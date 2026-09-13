import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../session/memory-store'
import { readTool } from '../tools/read'
import type {
  CompactPolicy,
  Message,
  ModelProfile,
  Provider,
  ProviderChunk,
  ProviderRequest,
  SessionRecord,
  StreamEvent,
} from '../types'
import { createSessionEngine } from './session-engine'
import {
  INCOMPLETE_TEXT,
  TOOL_NAME_ALIASES,
  TOOLS_OMITTED_TEXT,
  makeToolMessage,
  pairMissing,
  resolveToolAlias,
  unpairedToolUseIds,
} from './pairing'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('tool name aliases', () => {
  test('maps frozen Claude/Hermes names onto registered tools only', () => {
    expect(TOOL_NAME_ALIASES.Task).toBe('Agent')
    expect(TOOL_NAME_ALIASES.read_file).toBe('Read')
    expect(TOOL_NAME_ALIASES.write_file).toBe('Write')
    expect(TOOL_NAME_ALIASES.search_files).toBe('Grep')
    expect(TOOL_NAME_ALIASES.list_dir).toBe('ListDir')
    expect(TOOL_NAME_ALIASES.list_files).toBe('Glob')
    expect(resolveToolAlias('read_file', ['Read', 'Write'])).toBe('Read')
    expect(resolveToolAlias('Task', ['Agent'])).toBe('Agent')
    expect(resolveToolAlias('read_file', ['Write'])).toBeUndefined()
    expect(resolveToolAlias('NotATool', ['Read'])).toBeUndefined()
  })
})

describe('pairing invariant helpers', () => {
  test('pairMissing incomplete uses the stable resume text', () => {
    const [msg] = pairMissing(['X'], 'incomplete')
    expect(msg).toBeDefined()
    expect(msg?.role).toBe('tool')
    expect(msg?.toolUseId).toBe('X')
    expect(msg?.ok).toBe(false)
    expect(msg?.blocks[0]?.text).toBe(INCOMPLETE_TEXT)
  })

  test('pairMissing tools_omitted uses the stable grace text', () => {
    const [msg] = pairMissing(['g1'], 'tools_omitted')
    expect(msg?.ok).toBe(false)
    expect(msg?.blocks[0]?.text).toBe(TOOLS_OMITTED_TEXT)
  })

  test('pairMissing aborted / persist_failed use stable prefixes and ok:false', () => {
    const [aborted] = pairMissing(['a'], 'aborted')
    expect(aborted?.ok).toBe(false)
    expect(aborted?.blocks[0]?.text.startsWith('aborted:')).toBe(true)

    const [failed] = pairMissing(['p'], 'persist_failed')
    expect(failed?.ok).toBe(false)
    expect(failed?.blocks[0]?.text.startsWith('persist_failed:')).toBe(true)
  })

  test('unpairedToolUseIds finds tool_use without a matching tool row', () => {
    const messages: Message[] = [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'go' }],
        createdAt: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        blocks: [
          { type: 'tool_use', id: 'c1', name: 'Echo', input: {} },
          { type: 'tool_use', id: 'c2', name: 'Echo', input: {} },
        ],
        createdAt: 2,
      },
      {
        id: 't1',
        role: 'tool',
        toolUseId: 'c1',
        ok: true,
        blocks: [{ type: 'text', text: 'ok' }],
        createdAt: 3,
      },
    ]
    expect(unpairedToolUseIds(messages)).toEqual(['c2'])
  })

  test('IMAGE:: result becomes an image block plus caption', () => {
    const msg = makeToolMessage('img1', true, `IMAGE::image/png::${PNG_1X1.toString('base64')}`)
    expect(msg.ok).toBe(true)
    expect(msg.toolUseId).toBe('img1')
    expect(msg.blocks).toEqual([
      { type: 'text', text: '[image image/png]' },
      { type: 'image', mediaType: 'image/png', data: PNG_1X1.toString('base64') },
    ])
  })

  test('plain text results stay a single text block', () => {
    const msg = makeToolMessage('t1', true, 'hello file')
    expect(msg.blocks).toEqual([{ type: 'text', text: 'hello file' }])
    expect(msg.persistPath).toBeUndefined()
  })

  test('optional persistPath is stored on the tool message', () => {
    const msg = makeToolMessage('t1', true, 'preview', '/tmp/out.txt')
    expect(msg.ok).toBe(true)
    expect(msg.toolUseId).toBe('t1')
    expect(msg.blocks).toEqual([{ type: 'text', text: 'preview' }])
    expect(msg.persistPath).toBe('/tmp/out.txt')
  })

  test('Read of a tiny png yields an image block and stays paired', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-pair-img-'))
    tempDirs.push(cwd)
    writeFileSync(join(cwd, 'dot.png'), PNG_1X1)
    writeFileSync(join(cwd, 'note.txt'), 'plain text\n')

    const store = createMemoryStore()
    const session = makeSession({ cwd })
    await store.createSession(session)
    const provider = createFakeProvider([
      toolThenStop('r1', 'Read', { path: 'dot.png' }),
      toolThenStop('r2', 'Read', { path: 'note.txt' }),
      textThenStop('saw both'),
    ])
    const engine = createSessionEngine({
      session,
      provider,
      store,
      tools: [readTool],
      compact: defaultCompact(),
      model: defaultModel(),
      maxRounds: 8,
      async askUser() {
        return 'deny'
      },
    })

    const { result } = await collect(engine.submitMessage('read the files'))
    expect(result).toEqual({ reason: 'completed' })

    const loaded = await store.loadSession(session.id)
    expect(unpairedToolUseIds(loaded.messages)).toEqual([])

    const pngRow = loaded.messages.find(
      (msg): msg is Extract<Message, { role: 'tool' }> =>
        msg.role === 'tool' && msg.toolUseId === 'r1',
    )
    expect(pngRow?.ok).toBe(true)
    expect(pngRow?.blocks).toEqual([
      { type: 'text', text: '[image image/png]' },
      { type: 'image', mediaType: 'image/png', data: PNG_1X1.toString('base64') },
    ])

    const textRow = loaded.messages.find(
      (msg): msg is Extract<Message, { role: 'tool' }> =>
        msg.role === 'tool' && msg.toolUseId === 'r2',
    )
    expect(textRow?.ok).toBe(true)
    expect(textRow?.blocks).toEqual([{ type: 'text', text: 'plain text\n' }])

    expect(
      loaded.messages.some(
        (msg) =>
          msg.role === 'assistant' &&
          msg.blocks.some((block) => block.type === 'tool_use' && block.id === 'r1'),
      ),
    ).toBe(true)
  })
})

function defaultModel(id = 'dummy'): ModelProfile {
  return {
    id,
    contextWindow: 32_000,
    reserveOutputTokens: 3_200,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
  }
}

function defaultCompact(): CompactPolicy {
  return {
    enabled: true,
    autoCompactBuffer: 13_000,
    blockingBufferWhenManual: 3_000,
    protectLastMessages: 20,
    keepRecentFiles: 5,
    maxCharsPerRestoredFile: 5_000,
    maxCharsRestoredFilesTotal: 50_000,
    maxCharsPerRestoredSkill: 5_000,
    maxCharsRestoredSkillsTotal: 25_000,
    maxConsecutiveFailures: 3,
    llmSummarize: false,
  }
}

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess_pair_img',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp',
    model: 'dummy',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
    ...over,
  }
}

function createFakeProvider(scripts: ProviderChunk[][]): Provider {
  const queue = [...scripts]
  return {
    id: 'fake',
    apiMode: 'openai_compat',
    profile(model: string) {
      return defaultModel(model)
    },
    async *stream(_req: ProviderRequest, signal: AbortSignal) {
      const script = queue.shift() ?? [{ type: 'stop', reason: null }]
      for (const chunk of script) {
        if (signal.aborted) return
        yield chunk
      }
    },
  }
}

function textThenStop(text: string): ProviderChunk[] {
  return [
    { type: 'text_delta', text },
    { type: 'stop', reason: 'end' },
  ]
}

function toolThenStop(id: string, name: string, input: unknown): ProviderChunk[] {
  return [
    { type: 'tool_call', id, name, input },
    { type: 'stop', reason: 'tool_use' },
  ]
}

async function collect(
  gen: AsyncGenerator<StreamEvent, import('../types').RoundEnd>,
): Promise<{ events: StreamEvent[]; result: import('../types').RoundEnd }> {
  const events: StreamEvent[] = []
  while (true) {
    const next = await gen.next()
    if (next.done) return { events, result: next.value }
    events.push(next.value)
  }
}
