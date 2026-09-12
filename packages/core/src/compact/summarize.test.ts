import { describe, expect, test } from 'bun:test'
import type { Message, ModelProfile, Provider, ProviderChunk, ProviderRequest } from '../types'
import { defaultCompactPolicy } from './policy'
import { compactSummary, mechanicalSummary, summarizeSpan } from './summarize'

function user(id: string, text: string): Message {
  return { id, role: 'user', blocks: [{ type: 'text', text }], createdAt: 1 }
}

function asstTools(id: string, name: string, input: unknown, callId: string): Message {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: callId, name, input }],
    createdAt: 2,
  }
}

function model(): ModelProfile {
  return {
    id: 'test',
    contextWindow: 32_000,
    reserveOutputTokens: 1_024,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
  }
}

function fakeProvider(
  impl: (req: ProviderRequest, signal: AbortSignal) => AsyncIterable<ProviderChunk>,
): Provider & { streamCount: number } {
  const provider = {
    id: 'fake',
    apiMode: 'openai_compat' as const,
    streamCount: 0,
    profile(id: string) {
      return { ...model(), id }
    },
    async *stream(req: ProviderRequest, signal: AbortSignal) {
      provider.streamCount += 1
      yield* impl(req, signal)
    },
  }
  return provider
}

describe('mechanicalSummary', () => {
  test('keeps user text, file paths, and command strings', () => {
    const messages: Message[] = [
      user('u1', 'please inspect src/index.ts'),
      asstTools('a1', 'Read', { path: 'src/index.ts' }, 'r1'),
      asstTools('a2', 'Bash', { command: 'ls -la' }, 'b1'),
    ]
    const summary = mechanicalSummary(messages)
    expect(summary).toContain('please inspect src/index.ts')
    expect(summary).toContain('src/index.ts')
    expect(summary).toContain('ls -la')
  })
})

describe('summarizeSpan / compactSummary', () => {
  const span: Message[] = [
    user('u1', 'what files exist?'),
    asstTools('a1', 'Glob', { pattern: '*' }, 'g1'),
  ]

  test('summarizeSpan returns streamed text and uses a small maxTokens', async () => {
    let seen: ProviderRequest | undefined
    const provider = fakeProvider(async function* (req) {
      seen = req
      yield { type: 'text_delta', text: 'Glob ran. ' }
      yield { type: 'text_delta', text: 'Files listed.' }
      yield { type: 'stop', reason: 'end' }
    })
    const text = await summarizeSpan(span, provider, model(), new AbortController().signal)
    expect(text).toBe('Glob ran. Files listed.')
    expect(seen?.maxTokens).toBeLessThanOrEqual(2_048)
    expect(seen?.tools).toEqual([])
  })

  test('llmSummarize false → no provider.stream', async () => {
    const provider = fakeProvider(async function* () {
      yield { type: 'text_delta', text: 'should not run' }
    })
    const text = await compactSummary(
      span,
      defaultCompactPolicy(),
      provider,
      model(),
      new AbortController().signal,
    )
    expect(provider.streamCount).toBe(0)
    expect(text).toContain('what files exist?')
  })

  test('llmSummarize true + provider throw → mechanical fallback, not thrown', async () => {
    const provider = fakeProvider(async function* () {
      throw new Error('provider down')
    })
    const text = await compactSummary(
      span,
      { ...defaultCompactPolicy(), llmSummarize: true },
      provider,
      model(),
      new AbortController().signal,
    )
    expect(provider.streamCount).toBe(1)
    expect(text).toContain('what files exist?')
    expect(text).toContain('*')
  })

  test('aux throw → mechanical; live provider must not be called', async () => {
    const live = fakeProvider(async function* () {
      yield { type: 'text_delta', text: 'live should not run' }
    })
    const aux = fakeProvider(async function* () {
      throw new Error('aux 404')
    })
    const text = await compactSummary(
      span,
      { ...defaultCompactPolicy(), llmSummarize: true, auxProvider: aux, auxConfigured: true },
      live,
      model(),
      new AbortController().signal,
    )
    expect(aux.streamCount).toBe(1)
    expect(live.streamCount).toBe(0)
    expect(text).toContain('what files exist?')
    expect(text).not.toContain('live should not run')
  })

  test('aux configured but missing provider (build fail / included mismatch) → mechanical', async () => {
    const live = fakeProvider(async function* () {
      yield { type: 'text_delta', text: 'live should not run' }
    })
    const text = await compactSummary(
      span,
      { ...defaultCompactPolicy(), llmSummarize: true, auxConfigured: true },
      live,
      model(),
      new AbortController().signal,
    )
    expect(live.streamCount).toBe(0)
    expect(text).toContain('what files exist?')
    expect(text).not.toContain('live should not run')
  })

  test('aux success uses aux, not the live provider', async () => {
    const live = fakeProvider(async function* () {
      yield { type: 'text_delta', text: 'live should not run' }
    })
    const aux = fakeProvider(async function* () {
      yield { type: 'text_delta', text: 'cheap summary' }
      yield { type: 'stop', reason: 'end' }
    })
    const text = await compactSummary(
      span,
      {
        ...defaultCompactPolicy(),
        llmSummarize: true,
        auxProvider: aux,
        auxModel: { ...model(), id: 'anthropic/claude-haiku-4.5' },
        auxConfigured: true,
      },
      live,
      model(),
      new AbortController().signal,
    )
    expect(aux.streamCount).toBe(1)
    expect(live.streamCount).toBe(0)
    expect(text).toBe('cheap summary')
  })
})
