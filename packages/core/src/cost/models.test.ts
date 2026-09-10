import { describe, expect, test } from 'bun:test'
import { conservativeProfile, getModelProfile, reserveOutputTokens } from './models'

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

describe('getModelProfile', () => {
  test('known id returns table row with matching reserve', () => {
    const sonnet = getModelProfile('anthropic/claude-sonnet-4')
    expect(sonnet.id).toBe('anthropic/claude-sonnet-4')
    expect(sonnet.contextWindow).toBe(200_000)
    expect(sonnet.reserveOutputTokens).toBe(reserveOutputTokens(200_000))
    expect(sonnet.reserveOutputTokens).toBe(20_000)
    expect(sonnet.inputUsdPerMTok).toBe(3.0)
    expect(sonnet.outputUsdPerMTok).toBe(15.0)
    expect(sonnet.cacheReadUsdPerMTok).toBe(0.3)
    expect(sonnet.cacheWriteUsdPerMTok).toBe(3.75)
    expect(sonnet.supportsThinking).toBe(true)

    const opus = getModelProfile('anthropic/claude-opus-4')
    expect(opus.contextWindow).toBe(200_000)
    expect(opus.reserveOutputTokens).toBe(20_000)
    expect(opus.inputUsdPerMTok).toBe(15.0)
    expect(opus.outputUsdPerMTok).toBe(75.0)
    expect(opus.cacheReadUsdPerMTok).toBe(1.5)
    expect(opus.cacheWriteUsdPerMTok).toBe(18.75)
    expect(opus.supportsThinking).toBe(true)

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
