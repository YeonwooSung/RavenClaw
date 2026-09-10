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
})
