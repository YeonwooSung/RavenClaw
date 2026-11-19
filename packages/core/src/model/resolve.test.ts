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
  test('same kind and unknown kind reuse live provider', () => {
    const r = createModelResolver({ ...base, config: cfg(), funding: 'byok' })
    for (const id of ['claude-opus-4', 'mystery']) {
      const out = r.resolve(id)
      expect(out.ok && out.provider).toBe(live)
    }
  })
  test('cross kind uses factory and caches per kind', () => {
    let calls = 0
    const made = { name: 'made' } as unknown as Provider
    const r = createModelResolver({
      ...base,
      config: cfg(),
      funding: 'byok',
      createProvider: () => (calls++, made),
    })
    const a = r.resolve('gpt-5')
    const b = r.resolve('gpt-5-mini')
    expect(a.ok && a.provider).toBe(made)
    expect(a.ok && a.kind).toBe('openai_compat')
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
    expect(none.resolve('gpt-5').ok).toBe(false)
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
})
