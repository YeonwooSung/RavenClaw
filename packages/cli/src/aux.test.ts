import { afterEach, describe, expect, test } from 'bun:test'
import {
  defaultCompactPolicy,
  defaultConfig,
  defaultModelId,
  type ModelProfile,
  type Provider,
  type ResolvedConfig,
} from '@ravenclaw/core'
import {
  applyAuxCompactPolicy,
  auxSameProvider,
  providerKindFromModelId,
  tryBuildAuxProvider,
} from './aux'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function profile(id = 'anthropic/claude-sonnet-4'): ModelProfile {
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

function liveProvider(id = 'included'): Provider & { streamCount: number } {
  const provider = {
    id,
    apiMode: 'openai_compat' as const,
    streamCount: 0,
    profile(model: string) {
      return profile(model)
    },
    async *stream() {
      provider.streamCount += 1
      yield { type: 'text_delta' as const, text: 'live' }
    },
  }
  return provider
}

function config(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...defaultConfig(),
    profile: profile(),
    home: '/tmp',
    env: { ANTHROPIC_API_KEY: 'sk-ant' },
    ...over,
  }
}

describe('providerKindFromModelId', () => {
  test('maps common prefixes', () => {
    expect(providerKindFromModelId('anthropic/claude-haiku-4.5')).toBe('anthropic')
    expect(providerKindFromModelId(defaultModelId('anthropic'))).toBe('anthropic')
    expect(providerKindFromModelId('openai/gpt-4o-mini')).toBe('openai_compat')
    expect(providerKindFromModelId(defaultModelId('openai'))).toBe('openai_compat')
    expect(providerKindFromModelId('ollama/qwen')).toBe('ollama')
    expect(providerKindFromModelId('vllm/local-model')).toBe('vllm')
    expect(providerKindFromModelId('orcarouter/auto')).toBe('orcarouter')
    expect(providerKindFromModelId('llama3.2')).toBeUndefined()
  })
})

describe('tryBuildAuxProvider', () => {
  test('included + mismatched provider does not open BYOK and returns undefined', () => {
    const live = liveProvider()
    const built = tryBuildAuxProvider({
      modelId: 'ollama/qwen',
      config: config({ env: {} }),
      funding: 'included',
      sessionModel: 'anthropic/claude-sonnet-4',
      liveProvider: live,
    })
    expect(built).toBeUndefined()
    expect(auxSameProvider('anthropic/claude-sonnet-4', 'ollama/qwen')).toBe(false)
  })

  test('included + same provider family reuses the live included provider', () => {
    const live = liveProvider()
    const built = tryBuildAuxProvider({
      modelId: 'anthropic/claude-haiku-4.5',
      config: config({ env: {} }),
      funding: 'included',
      sessionModel: 'anthropic/claude-sonnet-4',
      liveProvider: live,
    })
    expect(built?.provider).toBe(live)
    expect(built?.model.id).toBe('anthropic/claude-haiku-4.5')
  })

  test('BYOK missing keys → undefined (mechanical later)', () => {
    const built = tryBuildAuxProvider({
      modelId: 'anthropic/claude-haiku-4.5',
      config: config({ env: {} }),
      funding: 'byok',
      sessionModel: 'anthropic/claude-sonnet-4',
      liveProvider: liveProvider('anthropic'),
    })
    expect(built).toBeUndefined()
  })

  test('orcarouter aux model uses ORCAROUTER_API_KEY', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init })
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch
    const built = tryBuildAuxProvider({
      modelId: 'orcarouter/auto',
      config: config({
        provider: 'anthropic',
        env: {
          ANTHROPIC_API_KEY: 'sk-ant',
          OPENAI_API_KEY: 'sk-oai',
          ORCAROUTER_API_KEY: 'sk-orca-aux',
        },
      }),
      funding: 'byok',
      sessionModel: 'anthropic/claude-sonnet-4',
      liveProvider: liveProvider('anthropic'),
    })
    expect(built?.provider.id).toBe('orcarouter')
    for await (const _chunk of built!.provider.stream(
      {
        model: 'orcarouter/auto',
        system: [],
        messages: [
          { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'hi' }], createdAt: 1 },
        ],
        tools: [],
        maxTokens: 16,
      },
      new AbortController().signal,
    )) {
      // drain
    }
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-orca-aux')
    expect(calls[0]?.url).toBe('https://api.orcarouter.ai/v1/chat/completions')
  })

  test('openai model prefix stays openai_compat during an orcarouter session', () => {
    const built = tryBuildAuxProvider({
      modelId: 'openai/gpt-4o-mini',
      config: config({
        provider: 'orcarouter',
        env: { OPENAI_API_KEY: 'sk-oai', ORCAROUTER_API_KEY: 'sk-orca-aux' },
      }),
      funding: 'byok',
      sessionModel: 'orcarouter/auto',
      liveProvider: liveProvider('orcarouter'),
    })
    expect(built?.provider.id).toBe('openai_compat')
  })

  test('BYOK with keys builds a distinct provider', () => {
    const live = liveProvider('anthropic')
    const built = tryBuildAuxProvider({
      modelId: 'anthropic/claude-haiku-4.5',
      config: config(),
      funding: 'byok',
      sessionModel: 'anthropic/claude-sonnet-4',
      liveProvider: live,
    })
    expect(built).toBeDefined()
    expect(built?.provider).not.toBe(live)
    expect(built?.model.id).toBe('anthropic/claude-haiku-4.5')
  })
})

describe('applyAuxCompactPolicy', () => {
  test('unset auxiliary.compact leaves compact unchanged', () => {
    const compact = defaultCompactPolicy()
    applyAuxCompactPolicy(compact, {
      config: config(),
      funding: 'byok',
      sessionModel: 'anthropic/claude-sonnet-4',
      liveProvider: liveProvider(),
    })
    expect(compact.auxConfigured).toBeUndefined()
    expect(compact.auxProvider).toBeUndefined()
  })

  test('included mismatch marks aux configured without a provider', () => {
    const compact = defaultCompactPolicy()
    applyAuxCompactPolicy(compact, {
      config: config({
        auxiliary: { compact: 'ollama/qwen' },
        env: {},
      }),
      funding: 'included',
      sessionModel: 'anthropic/claude-sonnet-4',
      liveProvider: liveProvider(),
    })
    expect(compact.auxConfigured).toBe(true)
    expect(compact.auxProvider).toBeUndefined()
  })
})
