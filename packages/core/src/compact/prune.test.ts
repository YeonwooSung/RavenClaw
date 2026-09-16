import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASSISTANT_STUB_TEXT } from '../loop/repair'
import { createMemoryStore } from '../session/memory-store'
import type { CompactPolicy, ContentBlock, Message, ModelProfile, SessionRecord } from '../types'
import { defaultCompactPolicy } from './policy'
import {
  applyRestoreCaps,
  applyToolResultBudget,
  microcompact,
  runAutocompact,
  truncateRestoredText,
} from './prune'

function user(id: string, text: string, createdAt: number): Message {
  return { id, role: 'user', blocks: [{ type: 'text', text }], createdAt }
}

function asstText(id: string, text: string, createdAt: number): Message {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], createdAt }
}

function asstTools(
  id: string,
  tools: Array<{ id: string; name: string; input: unknown }>,
  createdAt: number,
): Message {
  const blocks: ContentBlock[] = tools.map((tool) => ({
    type: 'tool_use',
    id: tool.id,
    name: tool.name,
    input: tool.input,
  }))
  return { id, role: 'assistant', blocks, createdAt }
}

function tool(
  id: string,
  toolUseId: string,
  text: string,
  createdAt: number,
  extra?: { persistPath?: string },
): Message {
  const msg: Extract<Message, { role: 'tool' }> = {
    id,
    role: 'tool',
    toolUseId,
    ok: true,
    blocks: [{ type: 'text', text }],
    createdAt,
  }
  if (extra?.persistPath !== undefined) msg.persistPath = extra.persistPath
  return msg
}

function textOf(msg: Message): string {
  return msg.blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function pairingHolds(messages: Message[]): boolean {
  const uses = new Set<string>()
  const tools = new Map<string, number>()
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const block of msg.blocks) {
        if (block.type === 'tool_use') uses.add(block.id)
      }
    }
    if (msg.role === 'tool') {
      tools.set(msg.toolUseId, (tools.get(msg.toolUseId) ?? 0) + 1)
    }
  }
  for (const id of uses) {
    if (tools.get(id) !== 1) return false
  }
  return true
}

function model(): ModelProfile {
  return {
    id: 'test',
    contextWindow: 200_000,
    reserveOutputTokens: 20_000,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
  }
}

function compact(over: Partial<CompactPolicy> = {}): CompactPolicy {
  return { ...defaultCompactPolicy(), ...over }
}

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp',
    model: 'test',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
    ...over,
  }
}

async function persistAll(
  store: ReturnType<typeof createMemoryStore>,
  sessionId: string,
  messages: Message[],
): Promise<void> {
  for (const msg of messages) {
    if (msg.role === 'user') await store.persistUser(sessionId, msg)
    else if (msg.role === 'assistant') {
      const hasTools = msg.blocks.some((block) => block.type === 'tool_use')
      if (hasTools) await store.persistToolCalls(sessionId, msg)
      else await store.persistAssistant(sessionId, msg)
    } else {
      await store.persistToolResults(sessionId, [msg])
    }
  }
}

describe('applyToolResultBudget', () => {
  test('stubs huge Bash output when persistPath is missing', () => {
    const huge = 'x'.repeat(100_001)
    const messages = [
      user('u1', 'run', 1),
      asstTools('a1', [{ id: 'b1', name: 'Bash', input: { command: 'ls' } }], 2),
      tool('t1', 'b1', huge, 3),
    ]
    const out = applyToolResultBudget(messages)
    const result = out.find((msg) => msg.id === 't1')
    expect(result).toBeDefined()
    expect(textOf(result!).length).toBeLessThan(huge.length)
    expect(textOf(result!).length).toBeLessThan(5_000)
    expect(pairingHolds(out)).toBe(true)
  })

  test('applyToolResultBudget trims large Grep results with head and tail', () => {
    const big = 'x'.repeat(200_000)
    const messages = [
      user('u1', 'g', 1),
      asstTools('a1', [{ id: 'c1', name: 'Grep', input: { pattern: 'x' } }], 2),
      tool('t1', 'c1', big, 3),
    ]
    const out = applyToolResultBudget(messages)
    const text = textOf(out.find((m) => m.role === 'tool')!)
    expect(text.length).toBeLessThan(2000)
    expect(text.startsWith('x'.repeat(200))).toBe(true)
    expect(text.endsWith('x'.repeat(200))).toBe(true)
    expect(text).toContain('truncated')
  })

  test('applyToolResultBudget still skips persistPath', () => {
    const huge = 'y'.repeat(100_001)
    const messages = [
      user('u1', 'run', 1),
      asstTools('a1', [{ id: 'b1', name: 'Bash', input: { command: 'ls' } }], 2),
      tool('t1', 'b1', huge, 3, { persistPath: '/tmp/out.txt' }),
    ]
    expect(textOf(applyToolResultBudget(messages).find((m) => m.id === 't1')!)).toBe(huge)
  })
})

describe('microcompact', () => {
  test('stubs old Read/Grep/Glob/Bash tool text outside the tail; pairing holds', () => {
    const messages = [
      user('u1', 'inspect', 1),
      asstTools('a1', [{ id: 'r1', name: 'Read', input: { path: 'a.ts' } }], 2),
      tool('t1', 'r1', 'file contents '.repeat(20), 3),
      asstTools('a2', [{ id: 'g1', name: 'Grep', input: { pattern: 'foo' } }], 4),
      tool('t2', 'g1', 'grep hits', 5),
      asstTools('a3', [{ id: 'l1', name: 'Glob', input: { pattern: '*' } }], 6),
      tool('t3', 'l1', 'a.ts', 7),
      asstTools('a4', [{ id: 'b1', name: 'Bash', input: { command: 'pwd' } }], 8),
      tool('t4', 'b1', '/tmp', 9),
      user('u2', 'recent', 10),
      asstText('a5', 'still here', 11),
    ]
    const out = microcompact(messages, 2)
    expect(textOf(out.find((msg) => msg.id === 't1')!)).not.toContain('file contents')
    expect(textOf(out.find((msg) => msg.id === 't2')!)).not.toBe('grep hits')
    expect(textOf(out.find((msg) => msg.id === 't3')!)).not.toBe('a.ts')
    expect(textOf(out.find((msg) => msg.id === 't4')!)).not.toBe('/tmp')
    expect(textOf(out.find((msg) => msg.id === 'a5')!)).toBe('still here')
    expect(out.find((msg) => msg.id === 'a1')).toEqual(messages[1])
    expect(pairingHolds(out)).toBe(true)
    for (const id of ['r1', 'g1', 'l1', 'b1']) {
      expect(out.some((msg) => msg.role === 'tool' && msg.toolUseId === id)).toBe(true)
    }
  })

  test('keeps tool text inside the protected tail', () => {
    const messages = [
      user('u1', 'old', 1),
      asstText('a1', 'old reply', 2),
      user('u2', 'read now', 3),
      asstTools('a2', [{ id: 'r1', name: 'Read', input: { path: 'b.ts' } }], 4),
      tool('t1', 'r1', 'kept body', 5),
    ]
    const out = microcompact(messages, 3)
    expect(textOf(out.find((msg) => msg.id === 't1')!)).toBe('kept body')
    expect(pairingHolds(out)).toBe(true)
  })

  test('stubs old Agent tool text outside the tail', () => {
    const messages = [
      user('u1', 'delegate', 1),
      asstTools('a1', [{ id: 'ag1', name: 'Agent', input: { prompt: 'scan' } }], 2),
      tool('t1', 'ag1', 'child found 12 files and a bug in parser.ts', 3),
      user('u2', 'recent', 4),
      asstText('a2', 'still here', 5),
    ]
    const out = microcompact(messages, 2)
    expect(textOf(out.find((msg) => msg.id === 't1')!)).toBe('[cleared Agent output]')
    expect(textOf(out.find((msg) => msg.id === 'a2')!)).toBe('still here')
    expect(pairingHolds(out)).toBe(true)
    expect(out.some((msg) => msg.role === 'tool' && msg.toolUseId === 'ag1')).toBe(true)
  })
})

describe('restore caps', () => {
  test('truncateRestoredText cuts on characters, not tokens', () => {
    expect(truncateRestoredText('hello world', 5)).toBe('hello')
    expect(truncateRestoredText('hi', 5)).toBe('hi')
    expect(truncateRestoredText('abcd', 0)).toBe('')
  })

  test('applyRestoreCaps honors per-item and total char budgets', () => {
    expect(applyRestoreCaps(['aaaaaa', 'bbbbbb'], 4, 6)).toEqual(['aaaa', 'bb'])
    expect(applyRestoreCaps(['xyz'], 5_000, 50_000)).toEqual(['xyz'])
  })
})

describe('runAutocompact', () => {
  test('calls store.recordCompact with middle ids; load omits inactivated', async () => {
    const store = createMemoryStore()
    await store.createSession(session())
    const messages = [
      user('u0', 'old question', 1),
      asstText('a0', 'old answer', 2),
      user('u1', 'recent', 3),
      asstText('a1', 'recent reply', 4),
    ]
    await persistAll(store, 's1', messages)

    const recorded: Array<{ generation: number; ids: string[] }> = []
    const orig = store.recordCompact.bind(store)
    store.recordCompact = async (sessionId, generation, summary, inactivatedIds) => {
      recorded.push({ generation, ids: [...inactivatedIds] })
      return orig(sessionId, generation, summary, inactivatedIds)
    }

    const result = await runAutocompact({
      messages,
      compact: compact({ protectLastMessages: 2 }),
      model: model(),
      store,
      sessionId: 's1',
      generation: 0,
      summary: 'SUMMARY',
    })

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.generation).toBe(1)
    expect(recorded[0]?.ids).toEqual(['u0', 'a0'])
    expect(result.inactivatedIds).toEqual(['u0', 'a0'])
    expect(result.generation).toBe(1)
    expect(result.messages.some((msg) => msg.id === 'u0' || msg.id === 'a0')).toBe(false)
    expect(result.messages.map((msg) => msg.id)).toContain('u1')
    expect(result.messages.map((msg) => msg.id)).toContain('a1')

    const loaded = await store.loadSession('s1')
    expect(loaded.session.compactGeneration).toBe(1)
    expect(loaded.messages.map((msg) => msg.id)).toEqual(['u1', 'a1'])
  })

  test('tail starting on user uses assistant stub via buildPostCompactMessages', async () => {
    const store = createMemoryStore()
    await store.createSession(session())
    const messages = [
      user('u0', 'old', 1),
      asstText('a0', 'old reply', 2),
      user('u1', 'recent', 3),
      asstText('a1', 'recent reply', 4),
    ]
    await persistAll(store, 's1', messages)

    const result = await runAutocompact({
      messages,
      compact: compact({ protectLastMessages: 2 }),
      model: model(),
      store,
      sessionId: 's1',
      generation: 0,
      summary: 'SUMMARY',
    })

    expect(result.messages[0]?.role).toBe('assistant')
    if (result.messages[0]?.role === 'assistant') {
      expect(result.messages[0].blocks[0]).toEqual({
        type: 'text',
        text: ASSISTANT_STUB_TEXT,
      })
    }
    expect(result.messages[1]?.role).toBe('user')
    if (result.messages[1]?.role === 'user') {
      expect(textOf(result.messages[1])).toBe('SUMMARY')
    }
    expect(result.messages.slice(2).map((msg) => msg.id)).toEqual(['u1', 'a1'])
  })

  test('tail starting on tool expands via selectProtectedTail', async () => {
    const store = createMemoryStore()
    await store.createSession(session())
    const messages = [
      user('u1', 'first', 1),
      asstText('a1', 'ok', 2),
      user('u2', 'use tool', 3),
      asstTools('a2', [{ id: 'X', name: 'Echo', input: {} }], 4),
      tool('t1', 'X', 'result', 5),
    ]
    await persistAll(store, 's1', messages)

    const result = await runAutocompact({
      messages,
      compact: compact({ protectLastMessages: 1 }),
      model: model(),
      store,
      sessionId: 's1',
      generation: 2,
      summary: 'SUMMARY',
    })

    expect(result.inactivatedIds).toEqual(['u1', 'a1', 'u2'])
    expect(result.messages[0]?.role).toBe('user')
    if (result.messages[0]?.role === 'user') {
      expect(textOf(result.messages[0])).toBe('SUMMARY')
    }
    expect(result.messages.slice(1).map((msg) => msg.id)).toEqual(['a2', 't1'])
    expect(pairingHolds(result.messages)).toBe(true)

    const loaded = await store.loadSession('s1')
    expect(loaded.messages.map((msg) => msg.id)).toEqual(['a2', 't1'])
  })

  test('restores capped Read notes from outside the tail', async () => {
    const store = createMemoryStore()
    await store.createSession(session())
    const messages = [
      user('u0', 'old', 1),
      asstTools('a0', [{ id: 'r1', name: 'Read', input: { path: 'src/a.ts' } }], 2),
      tool('t0', 'r1', 'export const n = 1', 3),
      user('u1', 'recent', 4),
      asstText('a1', 'recent reply', 5),
    ]
    await persistAll(store, 's1', messages)

    const result = await runAutocompact({
      messages,
      compact: compact({ protectLastMessages: 2 }),
      model: model(),
      store,
      sessionId: 's1',
      generation: 0,
      summary: 'SUMMARY',
    })

    const notes = result.messages
      .filter((msg) => msg.role === 'user')
      .map((msg) => textOf(msg))
      .join('\n')
    expect(notes).toContain('File src/a.ts:')
    expect(notes).toContain('export const n = 1')
  })

  test('restores a capped copy of cwd/.ravenclaw/plan.md when it exists', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-plan-restore-'))
    try {
      mkdirSync(join(cwd, '.ravenclaw'), { recursive: true })
      writeFileSync(join(cwd, '.ravenclaw', 'plan.md'), `${'P'.repeat(80)}\nnext: ship persistPath\n`)

      const store = createMemoryStore()
      await store.createSession(session({ cwd }))
      const messages = [
        user('u0', 'old question', 1),
        asstText('a0', 'old answer', 2),
        user('u1', 'recent', 3),
        asstText('a1', 'recent reply', 4),
      ]
      await persistAll(store, 's1', messages)

      const result = await runAutocompact({
        messages,
        compact: compact({
          protectLastMessages: 2,
          maxCharsPerRestoredFile: 60,
          maxCharsRestoredFilesTotal: 60,
        }),
        model: model(),
        store,
        sessionId: 's1',
        generation: 0,
        summary: 'SUMMARY',
        cwd,
      })

      const notes = result.messages
        .filter((msg) => msg.role === 'user')
        .map((msg) => textOf(msg))
        .join('\n')
      expect(notes).toContain('.ravenclaw/plan.md')
      expect(notes).toContain('P'.repeat(20))
      expect(notes).not.toContain('next: ship persistPath')
      expect(notes.includes('P'.repeat(80))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('compact injects a todos restore-note when TodoWrite left the tail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ravenclaw-todo-restore-'))
    try {
      const store = createMemoryStore()
      const sess = session({ cwd: root })
      await store.createSession(sess)
      mkdirSync(join(root, '.ravenclaw'), { recursive: true })
      writeFileSync(
        join(root, '.ravenclaw', 'todo.json'),
        JSON.stringify([
          { id: 't1', text: 'one', status: 'pending' },
          { id: 't2', text: 'two', status: 'in_progress' },
          { id: 't3', text: 'three', status: 'done' },
        ]),
      )
      const messages = [
        user('u0', 'old', 1),
        asstTools('a0', [{ id: 'td', name: 'TodoWrite', input: { items: [] } }], 2),
        tool('t0', 'td', 'Wrote 3', 3),
        user('u1', 'recent', 4),
        asstText('a1', 'ok', 5),
      ]
      await persistAll(store, sess.id, messages)
      const out = await runAutocompact({
        messages,
        compact: compact({ protectLastMessages: 2 }),
        model: model(),
        store,
        sessionId: sess.id,
        generation: 0,
        summary: 'sum',
        cwd: root,
      })
      const blob = out.messages.map(textOf).join('\n')
      expect(blob).toContain('one')
      expect(blob).toContain('two')
      expect(blob).toContain('three')
      expect(blob).toContain('Todos:\n- [pending] one\n- [in_progress] two\n- [done] three')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('skips todos restore-note when the list is empty or missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ravenclaw-todo-empty-'))
    try {
      const store = createMemoryStore()
      await store.createSession(session({ cwd: root }))
      const messages = [
        user('u0', 'old', 1),
        asstText('a0', 'old reply', 2),
        user('u1', 'recent', 3),
        asstText('a1', 'ok', 4),
      ]
      await persistAll(store, 's1', messages)
      const missing = await runAutocompact({
        messages,
        compact: compact({ protectLastMessages: 2 }),
        model: model(),
        store,
        sessionId: 's1',
        generation: 0,
        summary: 'sum',
        cwd: root,
      })
      expect(missing.messages.map(textOf).join('\n')).not.toContain('Todos:')

      mkdirSync(join(root, '.ravenclaw'), { recursive: true })
      writeFileSync(join(root, '.ravenclaw', 'todo.json'), '[]')
      const emptyFile = await runAutocompact({
        messages,
        compact: compact({ protectLastMessages: 2 }),
        model: model(),
        store,
        sessionId: 's1',
        generation: 0,
        summary: 'sum',
        cwd: root,
      })
      expect(emptyFile.messages.map(textOf).join('\n')).not.toContain('Todos:')

      writeFileSync(
        join(root, '.ravenclaw', 'todo.json'),
        JSON.stringify([{ id: 't1', text: 'cwd-only', status: 'pending' }]),
      )
      const emptyOpt = await runAutocompact({
        messages,
        compact: compact({ protectLastMessages: 2 }),
        model: model(),
        store,
        sessionId: 's1',
        generation: 0,
        summary: 'sum',
        cwd: root,
        todos: [],
      })
      expect(emptyOpt.messages.map(textOf).join('\n')).not.toContain('Todos:')
      expect(emptyOpt.messages.map(textOf).join('\n')).not.toContain('cwd-only')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('explicit todos option is restored instead of cwd todo.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ravenclaw-todo-opt-'))
    try {
      mkdirSync(join(root, '.ravenclaw'), { recursive: true })
      writeFileSync(
        join(root, '.ravenclaw', 'todo.json'),
        JSON.stringify([{ id: 't1', text: 'cwd-item', status: 'pending' }]),
      )
      const store = createMemoryStore()
      await store.createSession(session({ cwd: root }))
      const messages = [
        user('u0', 'old', 1),
        asstText('a0', 'old reply', 2),
        user('u1', 'recent', 3),
        asstText('a1', 'ok', 4),
      ]
      await persistAll(store, 's1', messages)
      const out = await runAutocompact({
        messages,
        compact: compact({ protectLastMessages: 2 }),
        model: model(),
        store,
        sessionId: 's1',
        generation: 0,
        summary: 'sum',
        cwd: root,
        todos: [{ text: 'session-item', status: 'done' }],
      })
      const blob = out.messages.map(textOf).join('\n')
      expect(blob).toContain('Todos:\n- [done] session-item')
      expect(blob).not.toContain('cwd-item')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('skips plan.md restore when the file is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-plan-missing-'))
    try {
      const store = createMemoryStore()
      await store.createSession(session({ cwd }))
      const messages = [
        user('u0', 'old question', 1),
        asstText('a0', 'old answer', 2),
        user('u1', 'recent', 3),
        asstText('a1', 'recent reply', 4),
      ]
      await persistAll(store, 's1', messages)

      const result = await runAutocompact({
        messages,
        compact: compact({ protectLastMessages: 2 }),
        model: model(),
        store,
        sessionId: 's1',
        generation: 0,
        summary: 'SUMMARY',
        cwd,
      })

      const notes = result.messages
        .filter((msg) => msg.role === 'user')
        .map((msg) => textOf(msg))
        .join('\n')
      expect(notes).not.toContain('plan.md')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
