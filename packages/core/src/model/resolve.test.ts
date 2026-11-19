import { describe, expect, test } from 'bun:test'
import type { ResolvedConfig } from '../config'
import type { Provider } from '../types'
import {
  createModelResolver,
  profileOverridesFor,
  providerKindFromModelId,
} from './resolve'

const live = { name: 'live' } as unknown as Provider
const cfg = (extra: Partial<ResolvedConfig> = {}): ResolvedConfig =>
  ({ model: 'claude-sonnet-4-5', provider: 'anthropic', env: {}, ...extra }) as ResolvedConfig

describe('providerKindFromModelId', () => {
  test('maps prefixes', () => {
    expect(providerKindFromModelId('claude-x')).toBe('anthropic')
    expect(providerKindFromModelId('gpt-5')).toBe('openai_compat')
    expect(providerKindFromModelId('ollama/llama3')).toBe('ollama')
    expect(providerKindFromModelId('vllm/x')).toBe('vllm')
    expect(providerKindFromModelId('orcarouter/x')).toBe('orcarouter')
    expect(providerKindFromModelId('mystery')).toBeUndefined()
  })
})

describe('profileOverridesFor', () => {
  test('contextWindow only for the configured model', () => {
    const c = { model: 'a', contextWindow: 1000 }
    expect(profileOverridesFor(c, 'a')).toEqual({ contextWindow: 1000 })
    expect(profileOverridesFor(c, 'b')).toBeUndefined()
  })
  test('per-id prices always apply', () => {
    const prices = { b: { inputPerMTok: 1, outputPerMTok: 2 } } as never
    const c = { model: 'a', contextWindow: 1000, prices }
    expect(profileOverridesFor(c, 'b')).toEqual({ prices: (prices as any).b })
    expect(profileOverridesFor(c, 'a')).toEqual({ contextWindow: 1000 })
  })
})

describe('createModelResolver', () => {
  const base = { liveProvider: live, liveModel: 'claude-sonnet-4-5' }
  test('providerKind on the reuse path is the explicit live kind, not the id prefix', () => {
    const r = createModelResolver({
      liveProvider: live,
      liveModel: 'openai/gpt-oss-120b',
      liveKind: 'vllm',
      config: cfg({ provider: 'vllm', model: 'openai/gpt-oss-120b' }),
      funding: 'byok',
    })
    const out = r.resolve('openai/gpt-oss-20b')
    expect(out.ok && out.provider).toBe(live)
    expect(out.ok && out.providerKind).toBe('vllm')
  })
  test('providerKind on the reuse path for an unprefixed id is the live kind', () => {
    const r = createModelResolver({
      liveProvider: live,
      liveModel: 'qwen3:8b',
      liveKind: 'ollama',
      config: cfg({ provider: 'ollama', model: 'qwen3:8b' }),
      funding: 'byok',
    })
    const out = r.resolve('qwen3:8b')
    expect(out.ok && out.provider).toBe(live)
    expect(out.ok && out.providerKind).toBe('ollama')
  })
  test('providerKind on the BYOK path is the factory kind', () => {
    const made = { name: 'made' } as unknown as Provider
    const seen: string[] = []
    const r = createModelResolver({
      liveProvider: live,
      liveModel: 'qwen3:8b',
      liveKind: 'ollama',
      config: cfg({ provider: 'ollama', model: 'qwen3:8b' }),
      funding: 'byok',
      createProvider: (kind) => (seen.push(kind), made),
    })
    const out = r.resolve('claude-opus-5')
    expect(out.ok && out.provider).toBe(made)
    expect(out.ok && out.providerKind).toBe('anthropic')
    expect(seen).toEqual(['anthropic'])
  })
  test('included reuse reports the live kind for a same-family prefixed id', () => {
    const r = createModelResolver({
      liveProvider: live,
      liveModel: 'claude-sonnet-4-5',
      liveKind: 'anthropic',
      config: cfg(),
      funding: 'included',
    })
    const out = r.resolve('anthropic/claude-opus-5')
    expect(out.ok && out.provider).toBe(live)
    expect(out.ok && out.providerKind).toBe('anthropic')
  })
  test('same kind and unknown kind reuse live provider', () => {
    const r = createModelResolver({ ...base, config: cfg(), funding: 'byok' })
    for (const id of ['claude-opus-4', 'mystery']) {
      const out = r.resolve(id)
      expect(out.ok && out.provider).toBe(live)
    }
  })
  test('cross kind uses factory and caches per kind+id', () => {
    let calls = 0
    const made = { name: 'made' } as unknown as Provider
    const r = createModelResolver({
      ...base,
      config: cfg(),
      funding: 'byok',
      createProvider: () => (calls++, made),
    })
    const a = r.resolve('gpt-5')
    const b = r.resolve('gpt-5')
    expect(a.ok && a.provider).toBe(made)
    expect(a.ok && a.providerKind).toBe('openai_compat')
    expect(b.ok && b.provider).toBe(made)
    expect(calls).toBe(1)
  })
  test('included cross kind errors without calling factory', () => {
    let calls = 0
    const r = createModelResolver({
      ...base,
      config: cfg(),
      funding: 'included',
      createProvider: () => (calls++, live),
    })
    expect(r.resolve('gpt-5')).toEqual({
      ok: false,
      error: 'model gpt-5 needs provider openai_compat; included sessions cannot switch provider',
    })
    expect(calls).toBe(0)
  })
  test('no factory and factory throw are errors', () => {
    const none = createModelResolver({ ...base, config: cfg(), funding: 'byok' })
    expect(none.resolve('gpt-5')).toEqual({
      ok: false,
      error: 'model gpt-5 needs provider openai_compat; no provider factory available',
    })
    const boom = createModelResolver({
      ...base,
      config: cfg(),
      funding: 'byok',
      createProvider: () => {
        throw new Error('missing OPENAI_API_KEY')
      },
    })
    expect(boom.resolve('gpt-5')).toEqual({ ok: false, error: 'missing OPENAI_API_KEY' })
  })
  test('profile applies override rules', () => {
    const r = createModelResolver({
      ...base,
      config: cfg({ contextWindow: 123_000 }),
      funding: 'byok',
    })
    expect(r.profile('claude-sonnet-4-5').contextWindow).toBe(123_000)
    expect(r.profile('claude-opus-4').contextWindow).not.toBe(123_000)
  })
  test('included same-kind resolves to live', () => {
    const r = createModelResolver({ ...base, config: cfg(), funding: 'included' })
    const out = r.resolve('claude-opus-4')
    expect(out.ok && out.provider).toBe(live)
  })
  test('different ids of the same kind get different providers', () => {
    const r = createModelResolver({
      ...base,
      config: cfg(),
      funding: 'byok',
      createProvider: () => ({}) as unknown as Provider,
    })
    const a = r.resolve('gpt-5')
    const b = r.resolve('gpt-5-mini')
    expect(a.ok && b.ok && a.provider !== b.provider).toBe(true)
  })
  test('reuseLiveProvider false uses the factory and caches per id', () => {
    let calls = 0
    const r = createModelResolver({
      ...base,
      config: cfg(),
      funding: 'byok',
      reuseLiveProvider: false,
      createProvider: () => (calls++, {}) as unknown as Provider,
    })
    const a = r.resolve('claude-opus-4')
    const a2 = r.resolve('claude-opus-4')
    expect(a.ok && a.provider).not.toBe(live)
    expect(a.ok && a2.ok && a.provider === a2.provider).toBe(true)
    expect(calls).toBe(1)
    r.resolve('mystery')
    expect(calls).toBe(2)
  })
  test('reuseLiveProvider false still reuses live when included', () => {
    const r = createModelResolver({
      ...base,
      config: cfg(),
      funding: 'included',
      reuseLiveProvider: false,
    })
    const out = r.resolve('claude-opus-4')
    expect(out.ok && out.provider).toBe(live)
  })
})

describe('configured model snapshot', () => {
  test('global contextWindow keeps following the model configured at creation', () => {
    const config = cfg({ model: 'claude-sonnet-4-5', contextWindow: 123_000 })
    const r = createModelResolver({
      config,
      funding: 'byok',
      liveProvider: live,
      liveModel: 'claude-sonnet-4-5',
    })
    config.model = 'claude-sonnet-5'
    expect(r.profile('claude-sonnet-5').contextWindow).not.toBe(123_000)
    expect(r.profile('claude-sonnet-4-5').contextWindow).toBe(123_000)
  })

  test('configuredModel option overrides the snapshot', () => {
    const config = cfg({ model: 'claude-sonnet-5', contextWindow: 123_000 })
    const r = createModelResolver({
      config,
      funding: 'byok',
      liveProvider: live,
      liveModel: 'claude-sonnet-5',
      configuredModel: 'claude-sonnet-4-5',
    })
    expect(r.profile('claude-sonnet-5').contextWindow).not.toBe(123_000)
    expect(r.profile('claude-sonnet-4-5').contextWindow).toBe(123_000)
  })
})
