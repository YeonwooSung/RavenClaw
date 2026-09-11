import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Message, ProviderChunk, ProviderRequest } from '@ravenclaw/core'
import { conservativeProfile, getModelProfile } from '@ravenclaw/core'
import { createIncludedGatewayProvider } from './gateway'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function userMsg(text: string): Extract<Message, { role: 'user' }> {
  return { id: 'u1', role: 'user', blocks: [{ type: 'text', text }], createdAt: 1 }
}

function baseReq(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'openai/gpt-4o',
    system: [],
    messages: [userMsg('hi')],
    tools: [],
    maxTokens: 128,
    ...over,
  }
}

async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('createIncludedGatewayProvider', () => {
  test('is an OpenAI-compat adapter pointed at the gateway with id included-gateway', async () => {
    const body = await Bun.file(join(import.meta.dir, 'fixtures', 'openai-text-only.sse')).text()
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init })
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      )
    }) as typeof fetch

    const provider = createIncludedGatewayProvider({
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sess-token',
      defaultModel: 'openai/gpt-4o',
    })
    expect(provider.id).toBe('included-gateway')
    expect(provider.apiMode).toBe('openai_compat')
    expect(provider.profile('openai/gpt-4o')).toEqual(getModelProfile('openai/gpt-4o'))
    expect(provider.profile('vendor/mystery')).toEqual(conservativeProfile('vendor/mystery'))

    const chunks = await collect(provider.stream(baseReq(), new AbortController().signal))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://gw.example.com/v1/chat/completions')
    expect(calls[0]?.init?.method).toBe('POST')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sess-token')
    const text = chunks
      .filter((c): c is Extract<ProviderChunk, { type: 'text_delta' }> => c.type === 'text_delta')
      .map((c) => c.text)
      .join('')
    expect(text).toBe('Hello, world')
  })

  test('HTTP 404 retries once with defaultModel', async () => {
    const body = await Bun.file(join(import.meta.dir, 'fixtures', 'openai-text-only.sse')).text()
    const models: string[] = []
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : ''
      const parsed = JSON.parse(raw) as { model?: string }
      models.push(parsed.model ?? '')
      if (parsed.model === 'gone/model') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'unknown model' }), { status: 404 }),
        )
      }
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      )
    }) as typeof fetch

    const provider = createIncludedGatewayProvider({
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sess-token',
      defaultModel: 'openai/gpt-4o',
    })
    const chunks = await collect(
      provider.stream(baseReq({ model: 'gone/model' }), new AbortController().signal),
    )
    expect(models).toEqual(['gone/model', 'openai/gpt-4o'])
    const text = chunks
      .filter((c): c is Extract<ProviderChunk, { type: 'text_delta' }> => c.type === 'text_delta')
      .map((c) => c.text)
      .join('')
    expect(text).toBe('Hello, world')
  })

  test('HTTP 403 retries once with defaultModel', async () => {
    const body = await Bun.file(join(import.meta.dir, 'fixtures', 'openai-text-only.sse')).text()
    const models: string[] = []
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : ''
      const parsed = JSON.parse(raw) as { model?: string }
      models.push(parsed.model ?? '')
      if (parsed.model === 'gone/model') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
        )
      }
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      )
    }) as typeof fetch

    const provider = createIncludedGatewayProvider({
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sess-token',
      defaultModel: 'openai/gpt-4o',
    })
    const chunks = await collect(
      provider.stream(baseReq({ model: 'gone/model' }), new AbortController().signal),
    )
    expect(models).toEqual(['gone/model', 'openai/gpt-4o'])
    const text = chunks
      .filter((c): c is Extract<ProviderChunk, { type: 'text_delta' }> => c.type === 'text_delta')
      .map((c) => c.text)
      .join('')
    expect(text).toBe('Hello, world')
  })

  test('JSON unknown model body retries once even when status is not 404', async () => {
    const body = await Bun.file(join(import.meta.dir, 'fixtures', 'openai-text-only.sse')).text()
    const models: string[] = []
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : ''
      const parsed = JSON.parse(raw) as { model?: string }
      models.push(parsed.model ?? '')
      if (parsed.model === 'gone/model') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'Unknown model' } }), { status: 400 }),
        )
      }
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      )
    }) as typeof fetch

    const provider = createIncludedGatewayProvider({
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sess-token',
      defaultModel: 'openai/gpt-4o',
    })
    await collect(provider.stream(baseReq({ model: 'gone/model' }), new AbortController().signal))
    expect(models).toEqual(['gone/model', 'openai/gpt-4o'])
  })

  test('does not retry other errors or a missing/same defaultModel', async () => {
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      return Promise.resolve(new Response('nope', { status: 500 }))
    }) as typeof fetch
    const withFallback = createIncludedGatewayProvider({
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sess-token',
      defaultModel: 'openai/gpt-4o',
    })
    await expect(
      collect(withFallback.stream(baseReq({ model: 'gone/model' }), new AbortController().signal)),
    ).rejects.toThrow(/500/)
    expect(calls).toBe(1)

    calls = 0
    globalThis.fetch = (() => {
      calls++
      return Promise.resolve(new Response('unknown model', { status: 404 }))
    }) as typeof fetch
    const sameModel = createIncludedGatewayProvider({
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sess-token',
      defaultModel: 'gone/model',
    })
    await expect(
      collect(sameModel.stream(baseReq({ model: 'gone/model' }), new AbortController().signal)),
    ).rejects.toThrow(/404/)
    expect(calls).toBe(1)

    calls = 0
    const noFallback = createIncludedGatewayProvider({
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sess-token',
    })
    await expect(
      collect(noFallback.stream(baseReq({ model: 'gone/model' }), new AbortController().signal)),
    ).rejects.toThrow(/404/)
    expect(calls).toBe(1)
  })
})
