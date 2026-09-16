import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultCompactPolicy } from '../compact/policy'
import { runAutocompact } from '../compact/prune'
import { createMemoryStore } from '../session/memory-store'
import type { Message, ModelProfile, SessionRecord, ToolContext, Turn } from '../types'
import { forgetReadsNotInTail } from './read-files'
import { writeTool } from './write'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-read-files-'))
  tempDirs.push(root)
  return root
}

function makeTurn(cwd: string): Turn {
  return {
    id: 'turn_1',
    sessionId: 's1',
    messages: [],
    round: 1,
    maxRounds: 80,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd,
    model: 'dummy',
    readFiles: new Set(),
  }
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

function session(cwd: string): SessionRecord {
  return {
    id: 's1',
    createdAt: 1,
    updatedAt: 1,
    cwd,
    model: 'test',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
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

describe('forgetReadsNotInTail', () => {
  test('forgetReadsNotInTail drops paths whose Read was summarized away', () => {
    const turn = {
      cwd: '/tmp',
      readFiles: new Set(['/tmp/a.ts']),
      readFileMtimes: new Map([['/tmp/a.ts', 1]]),
    } as Turn
    const messages: Message[] = [
      {
        id: 'u',
        role: 'user',
        blocks: [{ type: 'text', text: 'summary' }],
        createdAt: 1,
      },
    ]
    forgetReadsNotInTail(turn, messages)
    expect(turn.readFiles.has('/tmp/a.ts')).toBe(false)
    expect(turn.readFileMtimes?.has('/tmp/a.ts')).toBe(false)
  })

  test('forgetReadsNotInTail keeps a path whose kept Read result is still in the tail', () => {
    const turn = {
      cwd: '/tmp',
      readFiles: new Set(['/tmp/a.ts', '/tmp/b.ts']),
      readFileMtimes: new Map([
        ['/tmp/a.ts', 1],
        ['/tmp/b.ts', 2],
      ]),
    } as Turn
    const messages: Message[] = [
      {
        id: 'a',
        role: 'assistant',
        blocks: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { path: 'a.ts' } }],
        createdAt: 1,
      },
      {
        id: 't',
        role: 'tool',
        toolUseId: 'r1',
        ok: true,
        blocks: [{ type: 'text', text: 'contents' }],
        createdAt: 2,
      },
    ]
    forgetReadsNotInTail(turn, messages)
    expect(turn.readFiles.has('/tmp/a.ts')).toBe(true)
    expect(turn.readFileMtimes?.get('/tmp/a.ts')).toBe(1)
    expect(turn.readFiles.has('/tmp/b.ts')).toBe(false)
    expect(turn.readFileMtimes?.has('/tmp/b.ts')).toBe(false)
  })

  test('forgetReadsNotInTail drops paths whose kept Read result starts with [cleared ', () => {
    const turn = {
      cwd: '/tmp',
      readFiles: new Set(['/tmp/a.ts']),
      readFileMtimes: new Map([['/tmp/a.ts', 1]]),
    } as Turn
    const messages: Message[] = [
      {
        id: 'a',
        role: 'assistant',
        blocks: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { path: 'a.ts' } }],
        createdAt: 1,
      },
      {
        id: 't',
        role: 'tool',
        toolUseId: 'r1',
        ok: true,
        blocks: [{ type: 'text', text: '[cleared Read output]' }],
        createdAt: 2,
      },
    ]
    forgetReadsNotInTail(turn, messages)
    expect(turn.readFiles.has('/tmp/a.ts')).toBe(false)
    expect(turn.readFileMtimes?.has('/tmp/a.ts')).toBe(false)
  })

  test('Write after compact of a Read requires a new Read', async () => {
    const cwd = fixtureRoot()
    writeFileSync(join(cwd, 'a.ts'), 'old')
    const resolved = resolve(cwd, 'a.ts')
    const store = createMemoryStore()
    const sess = session(cwd)
    await store.createSession(sess)

    const messages: Message[] = [
      { id: 'u0', role: 'user', blocks: [{ type: 'text', text: 'read it' }], createdAt: 1 },
      {
        id: 'a0',
        role: 'assistant',
        blocks: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { path: 'a.ts' } }],
        createdAt: 2,
      },
      {
        id: 't0',
        role: 'tool',
        toolUseId: 'r1',
        ok: true,
        blocks: [{ type: 'text', text: `${'old\n'.repeat(20_000)}` }],
        createdAt: 3,
      },
      { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'now write' }], createdAt: 4 },
    ]
    await persistAll(store, sess.id, messages)

    const compacted = await runAutocompact({
      messages,
      compact: { ...defaultCompactPolicy(), protectLastMessages: 1 },
      model: model(),
      store,
      sessionId: sess.id,
      generation: 0,
      summary: 'SUMMARY',
      cwd,
    })
    expect(
      compacted.messages.some(
        (msg) =>
          msg.role === 'assistant' &&
          msg.blocks.some((block) => block.type === 'tool_use' && block.name === 'Read'),
      ),
    ).toBe(false)

    const turn = makeTurn(cwd)
    turn.readFiles = new Set([resolved])
    turn.readFileMtimes = new Map([[resolved, statSync(resolved).mtimeMs]])
    forgetReadsNotInTail(turn, compacted.messages)

    const ctx: ToolContext = {
      turn,
      signal: turn.abort.signal,
      onProgress() {},
    }
    const out = await writeTool.execute({ path: 'a.ts', content: 'x' }, ctx)
    expect(out).toBe('Write failed: path must be Read first: a.ts')
    expect(readFileSync(join(cwd, 'a.ts'), 'utf8')).toBe('old')
  })
})
