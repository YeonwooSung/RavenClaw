import { describe, expect, test } from 'bun:test'
import {
  conservativeProfile,
  defaultModelId,
  getModelProfile,
  MODEL_FAMILIES,
  MODEL_ROLES,
  reserveOutputTokens,
} from './models'

describe('reserveOutputTokens', () => {
  test('200_000 is capped at 20_000', () => {
    expect(reserveOutputTokens(200_000)).toBe(20_000)
  })

  test('32_000 → 3_200', () => {
    expect(reserveOutputTokens(32_000)).toBe(3_200)
  })

  test('50_000 → 5_000', () => {
    expect(reserveOutputTokens(50_000)).toBe(5_000)
  })
})

describe('defaultModelId', () => {
  test('returns the current snapshot for each family/role', () => {
    expect(defaultModelId('anthropic')).toBe('claude-sonnet-5')
    expect(defaultModelId('anthropic', 'default')).toBe('claude-sonnet-5')
    expect(defaultModelId('anthropic', 'strong')).toBe('claude-opus-5')
    expect(defaultModelId('anthropic', 'fast')).toBe('claude-haiku-4-5')
    expect(defaultModelId('openai')).toBe('gpt-5.6-terra')
    expect(defaultModelId('openai', 'strong')).toBe('gpt-6-astra')
    expect(defaultModelId('openai', 'fast')).toBe('gpt-5.6-luna')
  })

  test('every role pointer resolves to a priced catalog row', () => {
    for (const family of MODEL_FAMILIES) {
      for (const role of MODEL_ROLES) {
        const id = defaultModelId(family, role)
        const profile = getModelProfile(id)
        expect(profile.id).toBe(id)
        expect(profile.inputUsdPerMTok).toBeGreaterThan(0)
        expect(profile.outputUsdPerMTok).toBeGreaterThan(0)
        expect(profile.contextWindow).toBeGreaterThan(0)
      }
    }
  })
})

describe('getModelProfile', () => {
  test('known id returns table row with matching reserve', () => {
    const sonnet = getModelProfile('claude-sonnet-5')
    expect(sonnet.id).toBe('claude-sonnet-5')
    expect(sonnet.contextWindow).toBe(1_000_000)
    expect(sonnet.reserveOutputTokens).toBe(reserveOutputTokens(1_000_000))
    expect(sonnet.reserveOutputTokens).toBe(20_000)
    expect(sonnet.inputUsdPerMTok).toBe(2.0)
    expect(sonnet.outputUsdPerMTok).toBe(10.0)
    expect(sonnet.cacheReadUsdPerMTok).toBe(0.2)
    expect(sonnet.cacheWriteUsdPerMTok).toBe(2.5)
    expect(sonnet.supportsThinking).toBe(true)

    const opus = getModelProfile('claude-opus-5')
    expect(opus.contextWindow).toBe(1_000_000)
    expect(opus.reserveOutputTokens).toBe(20_000)
    expect(opus.inputUsdPerMTok).toBe(5.0)
    expect(opus.outputUsdPerMTok).toBe(25.0)
    expect(opus.cacheReadUsdPerMTok).toBe(0.5)
    expect(opus.cacheWriteUsdPerMTok).toBe(6.25)
    expect(opus.supportsThinking).toBe(true)

    const fable = getModelProfile('claude-fable-5-1')
    expect(fable.contextWindow).toBe(1_000_000)
    expect(fable.inputUsdPerMTok).toBe(10.0)
    expect(fable.outputUsdPerMTok).toBe(50.0)
    expect(fable.cacheReadUsdPerMTok).toBe(0.25)
    expect(fable.cacheWriteUsdPerMTok).toBe(12.5)
    expect(fable.supportsThinking).toBe(true)

    const haiku = getModelProfile('claude-haiku-4-5')
    expect(haiku.contextWindow).toBe(200_000)
    expect(haiku.inputUsdPerMTok).toBe(1.0)
    expect(haiku.outputUsdPerMTok).toBe(5.0)
    expect(haiku.cacheReadUsdPerMTok).toBe(0.1)
    expect(haiku.cacheWriteUsdPerMTok).toBe(1.25)
    expect(haiku.supportsThinking).toBe(true)

    const terra = getModelProfile('gpt-5.6-terra')
    expect(terra.contextWindow).toBe(1_050_000)
    expect(terra.reserveOutputTokens).toBe(20_000)
    expect(terra.inputUsdPerMTok).toBe(2.0)
    expect(terra.outputUsdPerMTok).toBe(12.0)
    expect(terra.cacheReadUsdPerMTok).toBe(0.2)
    expect(terra.cacheWriteUsdPerMTok).toBe(2.5)
    expect(terra.supportsThinking).toBe(false)

    const sol = getModelProfile('gpt-5.6-sol')
    expect(sol.inputUsdPerMTok).toBe(4.0)
    expect(sol.outputUsdPerMTok).toBe(20.0)
    expect(sol.cacheReadUsdPerMTok).toBe(0.4)
    expect(sol.cacheWriteUsdPerMTok).toBe(5.0)

    const astra = getModelProfile('gpt-6-astra')
    expect(astra.inputUsdPerMTok).toBe(10.0)
    expect(astra.outputUsdPerMTok).toBe(50.0)
    expect(astra.cacheReadUsdPerMTok).toBe(1.0)
    expect(astra.cacheWriteUsdPerMTok).toBe(12.5)

    const luna = getModelProfile('gpt-5.6-luna')
    expect(luna.inputUsdPerMTok).toBe(0.2)
    expect(luna.outputUsdPerMTok).toBe(1.2)
    expect(luna.cacheReadUsdPerMTok).toBe(0.02)
    expect(luna.cacheWriteUsdPerMTok).toBe(0.25)

    const sonnet4 = getModelProfile('anthropic/claude-sonnet-4')
    expect(sonnet4.contextWindow).toBe(200_000)
    expect(sonnet4.inputUsdPerMTok).toBe(3.0)
    expect(sonnet4.outputUsdPerMTok).toBe(15.0)
    expect(sonnet4.supportsThinking).toBe(true)

    const gpt4o = getModelProfile('openai/gpt-4o')
    expect(gpt4o.contextWindow).toBe(128_000)
    expect(gpt4o.reserveOutputTokens).toBe(reserveOutputTokens(128_000))
    expect(gpt4o.inputUsdPerMTok).toBe(2.5)
    expect(gpt4o.outputUsdPerMTok).toBe(10.0)
    expect(gpt4o.cacheReadUsdPerMTok).toBe(1.25)
    expect(gpt4o.cacheWriteUsdPerMTok).toBe(2.5)
    expect(gpt4o.supportsThinking).toBe(false)

    const mini = getModelProfile('openai/gpt-4o-mini')
    expect(mini.contextWindow).toBe(128_000)
    expect(mini.reserveOutputTokens).toBe(12_800)
    expect(mini.inputUsdPerMTok).toBe(0.15)
    expect(mini.outputUsdPerMTok).toBe(0.6)
    expect(mini.cacheReadUsdPerMTok).toBe(0.075)
    expect(mini.cacheWriteUsdPerMTok).toBe(0.15)
    expect(mini.supportsThinking).toBe(false)
  })

  test('vendor-prefixed and dated aliases share prices with the canonical id', () => {
    const sonnet = getModelProfile('claude-sonnet-5')
    const prefixed = getModelProfile('anthropic/claude-sonnet-5')
    expect(prefixed.contextWindow).toBe(sonnet.contextWindow)
    expect(prefixed.inputUsdPerMTok).toBe(sonnet.inputUsdPerMTok)
    expect(prefixed.outputUsdPerMTok).toBe(sonnet.outputUsdPerMTok)
    expect(prefixed.id).toBe('anthropic/claude-sonnet-5')

    const haiku = getModelProfile('claude-haiku-4-5')
    expect(getModelProfile('claude-haiku-4-5-20251001').inputUsdPerMTok).toBe(haiku.inputUsdPerMTok)
    expect(getModelProfile('anthropic/claude-haiku-4.5').inputUsdPerMTok).toBe(haiku.inputUsdPerMTok)

    const sol = getModelProfile('gpt-5.6-sol')
    expect(getModelProfile('gpt-5.6').inputUsdPerMTok).toBe(sol.inputUsdPerMTok)
    expect(getModelProfile('openai/gpt-5.6-terra').inputUsdPerMTok).toBe(2.0)
  })

  test('unknown id returns conservativeProfile', () => {
    const id = 'vendor/unknown-model'
    const profile = getModelProfile(id)
    expect(profile).toEqual(conservativeProfile(id))
    expect(profile.contextWindow).toBe(32_000)
    expect(profile.reserveOutputTokens).toBe(3_200)
    expect(profile.inputUsdPerMTok).toBe(0)
    expect(profile.outputUsdPerMTok).toBe(0)
    expect(profile.cacheReadUsdPerMTok).toBe(0)
    expect(profile.cacheWriteUsdPerMTok).toBe(0)
    expect(profile.supportsThinking).toBe(false)
  })

  test('contextWindow override reapplies the reserve formula', () => {
    const profile = getModelProfile('anthropic/claude-sonnet-4', { contextWindow: 50_000 })
    expect(profile.contextWindow).toBe(50_000)
    expect(profile.reserveOutputTokens).toBe(5_000)
    expect(profile.inputUsdPerMTok).toBe(3.0)
    expect(profile.supportsThinking).toBe(true)
  })

  test('price override changes USD fields only', () => {
    const profile = getModelProfile('openai/gpt-4o', {
      prices: { input: 9, output: 8 },
    })
    expect(profile.inputUsdPerMTok).toBe(9)
    expect(profile.outputUsdPerMTok).toBe(8)
    expect(profile.cacheReadUsdPerMTok).toBe(1.25)
    expect(profile.cacheWriteUsdPerMTok).toBe(2.5)
    expect(profile.contextWindow).toBe(128_000)
    expect(profile.reserveOutputTokens).toBe(12_800)
    expect(profile.supportsThinking).toBe(false)
  })
})

describe('conservativeProfile', () => {
  test('uses formula reserve and zero prices', () => {
    const profile = conservativeProfile('x')
    expect(profile.id).toBe('x')
    expect(profile.reserveOutputTokens).toBe(reserveOutputTokens(32_000))
  })
})
