import { describe, expect, test } from 'bun:test'
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
