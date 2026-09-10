import { describe, expect, test } from 'bun:test'
import { conservativeProfile, getModelProfile } from '@ravenclaw/core'
import { AnthropicMessagesProvider } from './anthropic'
import { OpenAICompatProvider } from './openai-compat'
import { createProvider } from './registry'

describe('profile()', () => {
  test("profile('openai/gpt-4o') returns the table row; unknown is conservative 32k/3200/$0", () => {
    const openai = new OpenAICompatProvider({ apiKey: 'k' })
    const anthropic = new AnthropicMessagesProvider({ apiKey: 'k' })
    const known = getModelProfile('openai/gpt-4o')

    expect(openai.profile('openai/gpt-4o')).toEqual(known)
    expect(anthropic.profile('openai/gpt-4o')).toEqual(known)
    expect(known.contextWindow).toBe(128_000)
    expect(known.supportsThinking).toBe(false)

    const unknown = openai.profile('vendor/mystery')
    expect(unknown).toEqual(conservativeProfile('vendor/mystery'))
    expect(unknown.contextWindow).toBe(32_000)
    expect(unknown.reserveOutputTokens).toBe(3_200)
    expect(unknown.inputUsdPerMTok).toBe(0)
    expect(unknown.outputUsdPerMTok).toBe(0)
    expect(unknown.cacheReadUsdPerMTok).toBe(0)
    expect(unknown.cacheWriteUsdPerMTok).toBe(0)
    expect(unknown.supportsThinking).toBe(false)
    expect(anthropic.profile('vendor/mystery')).toEqual(unknown)
  })
})

describe('createProvider', () => {
  test('returns the matching adapter', () => {
    const oai = createProvider({ provider: 'openai_compat', apiKey: 'k' })
    expect(oai).toBeInstanceOf(OpenAICompatProvider)
    expect(oai.id).toBe('openai_compat')
    expect(oai.apiMode).toBe('openai_compat')

    const ant = createProvider({
      provider: 'anthropic',
      apiKey: 'k',
      baseUrl: 'https://example.test',
      defaultModel: 'claude-sonnet-4',
    })
    expect(ant).toBeInstanceOf(AnthropicMessagesProvider)
    expect(ant.id).toBe('anthropic')
    expect(ant.apiMode).toBe('anthropic_messages')
  })
})
