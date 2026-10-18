import { afterEach, describe, expect, test } from 'bun:test'
import { conservativeProfile, getModelProfile } from '@ravenclaw/core'
import type { ProviderRequest } from '@ravenclaw/core'
import { AnthropicMessagesProvider } from './anthropic'
import { OpenAICompatProvider } from './openai-compat'
import { OpenAIResponsesProvider } from './responses'
import { createProvider } from './registry'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

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

    const responses = createProvider({ provider: 'openai_responses', apiKey: 'k' })
    expect(responses).toBeInstanceOf(OpenAIResponsesProvider)
    expect(responses.id).toBe('openai_responses')
    expect(responses.apiMode).toBe('openai_responses')
  })

  test('included requires a gateway URL and returns included-gateway', () => {
    const viaBase = createProvider({
      provider: 'included',
      apiKey: 'k',
      baseUrl: 'https://gw.example.com/v1',
    })
    expect(viaBase.id).toBe('included-gateway')
    expect(viaBase.apiMode).toBe('openai_compat')

    const viaGateway = createProvider({
      provider: 'included',
      apiKey: 'k',
      gatewayUrl: 'https://gw.example.com/v1',
    })
    expect(viaGateway.id).toBe('included-gateway')
    expect(viaGateway.apiMode).toBe('openai_compat')
  })

  test('ollama and vllm are OpenAI-compat adapters with local ids', () => {
    const ollama = createProvider({ provider: 'ollama', apiKey: '' })
    expect(ollama).toBeInstanceOf(OpenAICompatProvider)
    expect(ollama.id).toBe('ollama')
    expect(ollama.apiMode).toBe('openai_compat')

    const vllm = createProvider({
      provider: 'vllm',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:8000/v1',
      defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    })
    expect(vllm.id).toBe('vllm')
    expect(vllm.apiMode).toBe('openai_compat')
  })

  test('orcarouter streams to api.orcarouter.ai with RavenClaw attribution', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init })
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch

    const provider = createProvider({ provider: 'orcarouter', apiKey: 'sk-orca-test' })
    expect(provider.id).toBe('orcarouter')
    expect(provider.apiMode).toBe('openai_compat')
    for await (const _chunk of provider.stream(orcaReq(''), new AbortController().signal)) {
      // drain
    }

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.orcarouter.ai/v1/chat/completions')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-orca-test')
    expect(headers['HTTP-Referer']).toBe('https://github.com/YeonwooSung/RavenClaw')
    expect(headers['X-Title']).toBe('RavenClaw')
    const payload = JSON.parse(String(calls[0]?.init?.body)) as { model: string }
    expect(payload.model).toBe('orcarouter/auto')
  })

  test('orcarouter on another host omits attribution and keeps the requested model', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init })
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch

    const provider = createProvider({
      provider: 'orcarouter',
      apiKey: 'sk-orca-test',
      baseUrl: 'http://127.0.0.1:9/v1',
    })
    for await (const _chunk of provider.stream(
      orcaReq('anthropic/claude-sonnet-4.6'),
      new AbortController().signal,
    )) {
      // drain
    }

    expect(calls[0]?.url).toBe('http://127.0.0.1:9/v1/chat/completions')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['HTTP-Referer']).toBeUndefined()
    expect(headers['X-Title']).toBeUndefined()
    const payload = JSON.parse(String(calls[0]?.init?.body)) as { model: string }
    expect(payload.model).toBe('anthropic/claude-sonnet-4.6')
  })

  test('openai_compat does not send OrcaRouter attribution headers', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init })
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch

    const provider = createProvider({ provider: 'openai_compat', apiKey: 'sk-test' })
    for await (const _chunk of provider.stream(orcaReq('openai/gpt-4o'), new AbortController().signal)) {
      // drain
    }
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['HTTP-Referer']).toBeUndefined()
    expect(headers['X-Title']).toBeUndefined()
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions')
  })

  test('included without baseUrl or gatewayUrl throws a setup error', () => {
    expect(() => createProvider({ provider: 'included', apiKey: 'k' })).toThrow(
      /included\.gatewayUrl|baseUrl|BYOK/i,
    )
    expect(() =>
      createProvider({ provider: 'included', apiKey: 'k', baseUrl: '', gatewayUrl: '' }),
    ).toThrow(/included\.gatewayUrl|baseUrl|BYOK/i)
  })
})

function orcaReq(model: string): ProviderRequest {
  return {
    model,
    system: [],
    messages: [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'hi' }],
        createdAt: 1,
      },
    ],
    tools: [],
    maxTokens: 16,
  }
}
