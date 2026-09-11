import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../session/memory-store'
import type {
  CompactPolicy,
  ModelProfile,
  Provider,
  ProviderChunk,
  ProviderRequest,
  SessionRecord,
} from '../types'
import { applyReviewToMemory, forkMemoryReview } from './fork'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
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
    id: 'sess_review',
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

function createFakeProvider(scripts: ProviderChunk[][]): Provider & {
  requests: ProviderRequest[]
} {
  const requests: ProviderRequest[] = []
  const queue = [...scripts]
  return {
    id: 'fake',
    apiMode: 'openai_compat',
    requests,
    profile(model: string) {
      return defaultModel(model)
    },
    async *stream(req: ProviderRequest) {
      requests.push(req)
      const chunks = queue.shift() ?? [{ type: 'stop', reason: null }]
      for (const chunk of chunks) yield chunk
    },
  }
}

describe('forkMemoryReview', () => {
  test('returns provider text and writes .ravenclaw/MEMORY.md', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-review-'))
    tempDirs.push(cwd)
    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'lesson: use bun test' },
        { type: 'stop', reason: 'end' },
      ],
    ])
    const store = createMemoryStore()
    const session = makeSession({ cwd })
    await store.createSession(session)

    const result = await forkMemoryReview({
      provider,
      store,
      session,
      model: defaultModel(),
      compact: defaultCompact(),
      text: 'review this session',
    })

    expect(result.ok).toBe(true)
    expect(result.text).toBe('lesson: use bun test')
    expect(result.path).toBe(join(cwd, '.ravenclaw', 'MEMORY.md'))
    expect(existsSync(join(cwd, 'MEMORY.md'))).toBe(false)
    expect(readFileSync(join(cwd, '.ravenclaw', 'MEMORY.md'), 'utf8')).toContain(
      'lesson: use bun test',
    )
    const names = provider.requests[0]?.tools.map((tool) => tool.name) ?? []
    expect(names).not.toContain('Edit')
    expect(names).not.toContain('Write')
    expect(names).not.toContain('Bash')
  })

  test('does not execute Edit/Write/Bash if the model tries to call them', async () => {
    let executed = 0
    const provider: Provider & { requests: ProviderRequest[] } = {
      id: 'fake',
      apiMode: 'openai_compat',
      requests: [],
      profile(model: string) {
        return defaultModel(model)
      },
      async *stream(req: ProviderRequest) {
        provider.requests.push(req)
        executed += 1
        yield { type: 'tool_call', id: 'e1', name: 'Edit', input: { path: 'MEMORY.md' } }
        yield { type: 'tool_call', id: 'w1', name: 'Write', input: { path: 'MEMORY.md' } }
        yield { type: 'tool_call', id: 'b1', name: 'Bash', input: { command: 'rm -rf /' } }
        yield { type: 'text_delta', text: 'read-only review' }
        yield { type: 'stop', reason: 'end' }
      },
    }
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-review-'))
    tempDirs.push(cwd)
    const result = await forkMemoryReview({
      provider,
      store: createMemoryStore(),
      session: makeSession({ cwd }),
      model: defaultModel(),
      compact: defaultCompact(),
      text: 'try to mutate',
    })
    expect(result.ok).toBe(true)
    expect(result.text).toBe('read-only review')
    expect(executed).toBe(1)
    expect(existsSync(join(cwd, 'MEMORY.md'))).toBe(false)
    expect(readFileSync(join(cwd, '.ravenclaw', 'MEMORY.md'), 'utf8')).toContain(
      'read-only review',
    )
    expect(provider.requests[0]?.tools).toEqual([])
  })

  test('returns ok false and does not throw when the provider fails', async () => {
    const provider: Provider = {
      id: 'fake',
      apiMode: 'openai_compat',
      profile(model: string) {
        return defaultModel(model)
      },
      async *stream() {
        throw new Error('provider down')
      },
    }
    const result = await forkMemoryReview({
      provider,
      store: createMemoryStore(),
      session: makeSession(),
      model: defaultModel(),
      compact: defaultCompact(),
      text: 'review',
    })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('provider down')
    expect(result.path).toBeUndefined()
  })

  test('applyReviewToMemory appends a dated section and skips empty text', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-review-'))
    tempDirs.push(cwd)
    mkdirSync(join(cwd, '.ravenclaw'), { recursive: true })
    writeFileSync(join(cwd, '.ravenclaw', 'MEMORY.md'), '# Memory\n\nkeep me\n')
    expect(applyReviewToMemory(cwd, '   ').wrote).toBe(false)
    const applied = applyReviewToMemory(cwd, 'new lesson')
    expect(applied.wrote).toBe(true)
    const body = readFileSync(applied.path, 'utf8')
    expect(body).toContain('keep me')
    expect(body).toContain('new lesson')
    expect(body).toContain('review')
  })
})
