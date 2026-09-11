import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Message, ProviderChunk, ProviderRequest, SystemPart } from '@ravenclaw/core'
import { OpenAIResponsesProvider } from './responses'
import { ProviderError } from './errors'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function fixture(name: string): Promise<string> {
  return Bun.file(join(import.meta.dir, 'fixtures', name)).text()
}

function userMsg(text: string, id = 'u1'): Extract<Message, { role: 'user' }> {
  return { id, role: 'user', blocks: [{ type: 'text', text }], createdAt: 1 }
}

function baseReq(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'gpt-4.1',
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

function mockFetch(
  handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response> | Response,
): { calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return handler(input, init)
  }) as typeof fetch
  return { calls }
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('OpenAIResponsesProvider', () => {
  test('text-only stream concatenates text_deltas and yields usage + stop', async () => {
    const body = await fixture('openai-responses-text-only.sse')
    mockFetch(() => sseResponse(body))
    const provider = new OpenAIResponsesProvider({ apiKey: 'sk-test' })
    const chunks = await collect(provider.stream(baseReq(), new AbortController().signal))

    const text = chunks
      .filter((c): c is Extract<ProviderChunk, { type: 'text_delta' }> => c.type === 'text_delta')
      .map((c) => c.text)
      .join('')
    expect(text).toBe('Hello, world')
    expect(chunks.some((c) => c.type === 'stop' && c.reason === 'completed')).toBe(true)
    expect(chunks.find((c) => c.type === 'usage')).toEqual({
      type: 'usage',
      usage: { input: 12, output: 3, cacheRead: 4, cacheWrite: 0 },
    })
  })

  test('split function-call arguments yield one complete tool_call only', async () => {
    const body = await fixture('openai-responses-tool-call-split.sse')
    mockFetch(() => sseResponse(body))
    const provider = new OpenAIResponsesProvider({ apiKey: 'sk-test' })
    const chunks = await collect(provider.stream(baseReq(), new AbortController().signal))

    const toolCalls = chunks.filter((c) => c.type === 'tool_call')
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toEqual({
      type: 'tool_call',
      id: 'call_abc123',
      name: 'get_weather',
      input: { location: 'Paris' },
    })
  })

  test('maps messages and tools onto POST /responses', async () => {
    const body = await fixture('openai-responses-text-only.sse')
    const { calls } = mockFetch(() => sseResponse(body))
    const provider = new OpenAIResponsesProvider({ apiKey: 'sk-test' })
    const system: SystemPart[] = [
      { tier: 'stable', text: 'ALPHA' },
      { tier: 'context', text: 'BETA' },
    ]
    const messages: Message[] = [
      userMsg('hello'),
      {
        id: 'a1',
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'call_1', name: 'Echo', input: { text: 'x' } },
        ],
        createdAt: 2,
      },
      {
        id: 't1',
        role: 'tool',
        toolUseId: 'call_1',
        ok: true,
        blocks: [{ type: 'text', text: 'echoed' }],
        createdAt: 3,
      },
    ]
    await collect(
      provider.stream(
        baseReq({
          system,
          messages,
          tools: [
            {
              name: 'Echo',
              description: 'echo',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            },
          ],
        }),
        new AbortController().signal,
      ),
    )

    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.url).toBe('https://api.openai.com/v1/responses')
    expect(call?.init?.method).toBe('POST')
    expect(call?.init?.headers).toMatchObject({
      Authorization: 'Bearer sk-test',
    })
    const payload = JSON.parse(String(call?.init?.body)) as {
      model: string
      stream: boolean
      max_output_tokens: number
      instructions: string
      input: unknown[]
      tools: unknown[]
    }
    expect(payload.stream).toBe(true)
    expect(payload.model).toBe('gpt-4.1')
    expect(payload.max_output_tokens).toBe(128)
    expect(payload.instructions).toBe('ALPHABETA')
    expect(payload.input).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'ok' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'Echo',
        arguments: '{"text":"x"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'echoed' },
    ])
    expect(payload.tools).toEqual([
      {
        type: 'function',
        name: 'Echo',
        description: 'echo',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ])
  })

  test('401 is ProviderError retryable false; 429 is retryable true', async () => {
    const provider = new OpenAIResponsesProvider({ apiKey: 'sk-test' })

    mockFetch(() => new Response('nope', { status: 401, statusText: 'Unauthorized' }))
    const err401 = await collect(provider.stream(baseReq(), new AbortController().signal)).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err401).toBeInstanceOf(ProviderError)
    expect(err401).toMatchObject({ retryable: false, status: 401 })

    mockFetch(() => new Response('slow down', { status: 429, statusText: 'Too Many Requests' }))
    const err429 = await collect(provider.stream(baseReq(), new AbortController().signal)).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err429).toBeInstanceOf(ProviderError)
    expect(err429).toMatchObject({ retryable: true, status: 429 })
  })
})
