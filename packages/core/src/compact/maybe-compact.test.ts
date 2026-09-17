import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { maybeCompact, type LoopState } from '../loop/phases'
import { createMemoryStore } from '../session/memory-store'
import type {
  CompactPolicy,
  ContentBlock,
  Message,
  ModelProfile,
  Provider,
  SessionRecord,
  StreamEvent,
  SystemPart,
  TokenUsage,
  ToolContext,
} from '../types'
import { writeTool } from '../tools/write'
import { clearLastRequestAt, markLastRequestAt } from './last-request'
import { defaultCompactPolicy } from './policy'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function model(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'test',
    contextWindow: 32_000,
    reserveOutputTokens: 3_200,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
    ...over,
  }
}

function compact(over: Partial<CompactPolicy> = {}): CompactPolicy {
  return { ...defaultCompactPolicy(), protectLastMessages: 2, ...over }
}

function session(): SessionRecord {
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
  }
}

function user(id: string, text: string, createdAt: number): Message {
  return { id, role: 'user', blocks: [{ type: 'text', text }], createdAt }
}

function asstText(
  id: string,
  text: string,
  createdAt: number,
  usage?: TokenUsage,
): Message {
  const msg: Extract<Message, { role: 'assistant' }> = {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    createdAt,
  }
  if (usage) msg.usage = usage
  return msg
}

function dummyProvider(): Provider {
  return {
    id: 'fake',
    apiMode: 'openai_compat',
    profile(id: string) {
      return model({ id })
    },
    async *stream() {
      yield { type: 'stop', reason: null }
    },
  }
}

async function drain(state: LoopState) {
  const events: StreamEvent[] = []
  const gen = maybeCompact(state)
  while (true) {
    const next = await gen.next()
    if (next.done) return { events, result: next.value }
    events.push(next.value)
  }
}

async function makeState(over: {
  messages: Message[]
  compact?: CompactPolicy
  model?: ModelProfile
  compactFailures?: number
  persist?: boolean
  system?: SystemPart[]
}): Promise<LoopState> {
  const store = createMemoryStore()
  const sess = session()
  clearLastRequestAt(sess.id)
  await store.createSession(sess)
  if (over.persist !== false) {
    for (const msg of over.messages) {
      if (msg.role === 'user') await store.persistUser(sess.id, msg)
      else if (msg.role === 'assistant') await store.persistAssistant(sess.id, msg)
      else await store.persistToolResults(sess.id, [msg])
    }
  }
  const state: LoopState = {
    turn: {
      id: 't1',
      sessionId: sess.id,
      messages: over.messages,
      round: 1,
      maxRounds: 8,
      graceUsed: false,
      abort: new AbortController(),
      permissionMode: 'default',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactGeneration: 0,
      funding: 'byok',
      cwd: '/tmp',
      model: 'test',
      readFiles: new Set(),
    },
    tools: [],
    provider: dummyProvider(),
    store,
    compact: over.compact ?? compact(),
    model: over.model ?? model(),
    async askUser() {
      return 'deny'
    },
    lastHadToolUse: false,
    pendingText: '',
    pendingThinking: '',
    pendingToolCalls: [],
    pendingUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    streamAborted: false,
    assistantMessage: null,
    toolResults: [],
    compactFailures: over.compactFailures ?? 0,
    overflowCompacted: false,
    lastStopReason: null,
    fallbackUsed: false,
    outputEscalated: false,
    outputNudges: 0,
    schemaNudges: 0,
    emptyNudges: 0,
    thinkingNudges: 0,
    stopNudges: 0,
    verifyNudges: 0,
    mutatedThisTurn: false,
    sawVerifyCommand: false,
  }
  if (over.system !== undefined) state.system = over.system
  return state
}

describe('maybeCompact', () => {
  test('tiny messages continue without compacting', async () => {
    const state = await makeState({
      messages: [user('u1', 'hi', 1)],
    })
    const { events, result } = await drain(state)
    expect(result).toEqual({ action: 'continue' })
    expect(events).toEqual([])
    expect(state.turn.compactGeneration).toBe(0)
    expect(state.turn.messages.map((msg) => msg.id)).toEqual(['u1'])
  })

  test('compact off + over hard limit → context_full', async () => {
    const state = await makeState({
      messages: [user('u1', 'x'.repeat(4_000), 1)],
      compact: compact({ enabled: false, blockingBufferWhenManual: 10 }),
      model: model({ contextWindow: 200, reserveOutputTokens: 20 }),
    })
    const { result } = await drain(state)
    expect(result).toEqual({ action: 'return', end: { reason: 'context_full' } })
  })

  test('anchored over threshold yields compact and bumps generation', async () => {
    const messages = [
      user('u0', 'old', 1),
      asstText('a0', 'old reply', 2),
      user('u1', 'recent', 3),
      asstText('a1', 'recent reply', 4, {
        input: 200,
        output: 20,
        cacheRead: 10,
        cacheWrite: 0,
      }),
    ]
    const state = await makeState({
      messages,
      compact: compact({ autoCompactBuffer: 13 }),
      model: model({ contextWindow: 200, reserveOutputTokens: 20 }),
    })
    const { events, result } = await drain(state)
    expect(result).toEqual({ action: 'continue' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'compact', generation: 1 })
    expect(state.turn.compactGeneration).toBe(1)
    expect(state.turn.messages.some((msg) => msg.id === 'u0')).toBe(false)
  })

  test('circuit-breaker skips after 3 failures', async () => {
    const messages = [
      user('u0', 'old', 1),
      asstText('a0', 'old reply', 2, {
        input: 200,
        output: 20,
        cacheRead: 10,
        cacheWrite: 0,
      }),
      user('u1', 'recent', 3),
      asstText('a1', 'ok', 4),
    ]
    const state = await makeState({
      messages,
      compact: compact({ autoCompactBuffer: 13, blockingBufferWhenManual: 10 }),
      model: model({ contextWindow: 200, reserveOutputTokens: 20 }),
      compactFailures: 3,
    })
    const { events, result } = await drain(state)
    expect(result).toEqual({ action: 'continue' })
    expect(events).toEqual([])
    expect(state.turn.compactGeneration).toBe(0)
    expect(state.turn.messages.map((msg) => msg.id)).toEqual(['u0', 'a0', 'u1', 'a1'])
  })

  test('cache expiry with enough tokens yields compact', async () => {
    const messages = [
      user('u0', 'x'.repeat(4_000), 1),
      asstText('a0', 'y'.repeat(4_000), 2),
      user('u1', 'recent', 3),
      asstText('a1', 'ok', 4),
    ]
    const state = await makeState({ messages })
    markLastRequestAt(state.turn.sessionId, Date.now() - 4_000_000)
    const { events, result } = await drain(state)
    expect(result).toEqual({ action: 'continue' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'compact', generation: 1 })
    expect(state.turn.compactGeneration).toBe(1)
    expect(state.turn.messages.some((msg) => msg.id === 'u0')).toBe(false)
  })

  test('fresh last request does not compact under the token window', async () => {
    const messages = [
      user('u0', 'x'.repeat(4_000), 1),
      asstText('a0', 'y'.repeat(4_000), 2),
      user('u1', 'recent', 3),
      asstText('a1', 'ok', 4),
    ]
    const state = await makeState({ messages })
    markLastRequestAt(state.turn.sessionId, Date.now())
    const { events, result } = await drain(state)
    expect(result).toEqual({ action: 'continue' })
    expect(events).toEqual([])
    expect(state.turn.compactGeneration).toBe(0)
    expect(state.turn.messages.map((msg) => msg.id)).toEqual(['u0', 'a0', 'u1', 'a1'])
  })

  test('compact leaves MEMORY system snapshot untouched', async () => {
    const memoryPart: SystemPart = {
      tier: 'stable',
      text: 'MEMORY.md unique-bytes-xyz',
    }
    const messages = [
      user('u0', 'old', 1),
      asstText('a0', 'old reply', 2),
      user('u1', 'recent', 3),
      asstText('a1', 'recent reply', 4, {
        input: 200,
        output: 20,
        cacheRead: 10,
        cacheWrite: 0,
      }),
    ]
    const state = await makeState({
      system: [memoryPart],
      messages,
      compact: compact({ autoCompactBuffer: 13 }),
      model: model({ contextWindow: 200, reserveOutputTokens: 20 }),
    })
    const before = JSON.stringify(state.system)
    const { events, result } = await drain(state)
    expect(result).toEqual({ action: 'continue' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'compact', generation: 1 })
    expect(JSON.stringify(state.system)).toBe(before)
    expect(state.system?.some((p) => 'text' in p && p.text.includes('unique-bytes-xyz'))).toBe(
      true,
    )
    const blob = JSON.stringify(state.turn.messages)
    expect(blob.includes('unique-bytes-xyz') && state.system === undefined).toBe(false)
  })

  test('maybeCompact forgets this-turn Reads that left the tail', async () => {
    const readBlock: ContentBlock = {
      type: 'tool_use',
      id: 'r1',
      name: 'Read',
      input: { path: 'a.ts' },
    }
    const messages: Message[] = [
      user('u0', 'old', 1),
      { id: 'a0', role: 'assistant', blocks: [readBlock], createdAt: 2 },
      {
        id: 't0',
        role: 'tool',
        toolUseId: 'r1',
        ok: true,
        blocks: [{ type: 'text', text: 'export const n = 1' }],
        createdAt: 3,
      },
      user('u1', 'recent', 4),
      asstText('a1', 'recent reply', 5, {
        input: 200,
        output: 20,
        cacheRead: 10,
        cacheWrite: 0,
      }),
    ]
    const state = await makeState({
      messages,
      compact: compact({ autoCompactBuffer: 13, protectLastMessages: 2 }),
      model: model({ contextWindow: 200, reserveOutputTokens: 20 }),
      persist: false,
    })
    for (const msg of messages) {
      if (msg.role === 'user') await state.store.persistUser(state.turn.sessionId, msg)
      else if (msg.role === 'assistant') {
        const hasTools = msg.blocks.some((block) => block.type === 'tool_use')
        if (hasTools) await state.store.persistToolCalls(state.turn.sessionId, msg)
        else await state.store.persistAssistant(state.turn.sessionId, msg)
      } else {
        await state.store.persistToolResults(state.turn.sessionId, [msg])
      }
    }
    state.turn.readFiles.add('/tmp/a.ts')
    if (!state.turn.readFileMtimes) state.turn.readFileMtimes = new Map()
    state.turn.readFileMtimes.set('/tmp/a.ts', 1)

    const { events, result } = await drain(state)
    expect(result).toEqual({ action: 'continue' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'compact', generation: 1 })
    expect(
      state.turn.messages.some(
        (msg) =>
          msg.role === 'assistant' &&
          msg.blocks.some((block) => block.type === 'tool_use' && block.name === 'Read'),
      ),
    ).toBe(false)
    expect(state.turn.readFiles.has('/tmp/a.ts')).toBe(false)
    expect(state.turn.readFileMtimes?.has('/tmp/a.ts')).toBe(false)
  })

  test('cheap-only stubbed Read then Write requires a new Read', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-cheap-read-'))
    tempDirs.push(cwd)
    writeFileSync(join(cwd, 'a.ts'), 'old')
    const resolved = resolve(cwd, 'a.ts')
    const readBlock: ContentBlock = {
      type: 'tool_use',
      id: 'r1',
      name: 'Read',
      input: { path: 'a.ts' },
    }
    const messages: Message[] = [
      user('u0', 'old', 1),
      { id: 'a0', role: 'assistant', blocks: [readBlock], createdAt: 2 },
      {
        id: 't0',
        role: 'tool',
        toolUseId: 'r1',
        ok: true,
        blocks: [{ type: 'text', text: 'export const n = 1' }],
        createdAt: 3,
      },
      user('u1', 'recent', 4),
      asstText('a1', 'recent reply', 5),
    ]
    const state = await makeState({
      messages,
      compact: compact({ protectLastMessages: 2 }),
      persist: false,
    })
    state.turn.cwd = cwd
    state.turn.readFiles.add(resolved)
    if (!state.turn.readFileMtimes) state.turn.readFileMtimes = new Map()
    state.turn.readFileMtimes.set(resolved, 1)

    const { events, result } = await drain(state)
    expect(result).toEqual({ action: 'continue' })
    expect(events).toEqual([])
    const stubbed = state.turn.messages.find((msg) => msg.id === 't0')
    expect(stubbed && stubbed.role === 'tool' ? stubbed.blocks[0] : undefined).toEqual({
      type: 'text',
      text: '[cleared Read output]',
    })
    expect(state.turn.readFiles.has(resolved)).toBe(false)

    const ctx: ToolContext = {
      turn: state.turn,
      signal: state.turn.abort.signal,
      onProgress() {},
    }
    const out = await writeTool.execute({ path: 'a.ts', content: 'x' }, ctx)
    expect(out).toBe('Write failed: path must be Read first: a.ts')
    expect(readFileSync(join(cwd, 'a.ts'), 'utf8')).toBe('old')
  })
})
