import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Message, ProviderChunk, ProviderRequest, SystemPart } from '@ravenclaw/core'
import { AnthropicMessagesProvider } from './anthropic'
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
    model: 'anthropic/claude-sonnet-4',
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

async function lastPayload(calls: Array<{ url: string; init: RequestInit | undefined }>): Promise<{
  url: string
  headers: Record<string, string>
  body: {
    model: string
    stream: boolean
    max_tokens: number
    system?: unknown
    messages: Array<{ role: string; content: unknown }>
    tools?: unknown[]
  }
}> {
  const call = calls[0]
  if (!call) throw new Error('fetch was not called')
  const headers = call.init?.headers as Record<string, string>
  return {
    url: call.url,
    headers,
    body: JSON.parse(String(call.init?.body)) as {
      model: string
      stream: boolean
      max_tokens: number
      system?: unknown
      messages: Array<{ role: string; content: unknown }>
      tools?: unknown[]
    },
  }
}

describe('AnthropicMessagesProvider', () => {
  test('system parts set cache_control on breakpoint parts only', async () => {
    const sse = await fixture('anthropic-text-only.sse')
    const { calls } = mockFetch(() => sseResponse(sse))
    const provider = new AnthropicMessagesProvider({ apiKey: 'sk-ant-test' })
    const system: SystemPart[] = [
      { tier: 'stable', text: 'STABLE', cacheBreakpoint: true },
      { tier: 'context', text: 'CONTEXT', cacheBreakpoint: true },
      { tier: 'volatile', text: 'VOLATILE' },
    ]
    await collect(provider.stream(baseReq({ system }), new AbortController().signal))

    const req = await lastPayload(calls)
    expect(req.url).toBe('https://api.anthropic.com/v1/messages')
    expect(req.headers['x-api-key']).toBe('sk-ant-test')
    expect(req.headers['anthropic-version']).toBe('2023-06-01')
    expect(req.body.stream).toBe(true)
    expect(req.body.system).toEqual([
      { type: 'text', text: 'STABLE', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'CONTEXT', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'VOLATILE' },
    ])
    const volatile = (req.body.system as Array<Record<string, unknown>>)[2]
    expect(volatile).not.toHaveProperty('cache_control')
  })

  test('skips empty assistant rows instead of emitting empty content', async () => {
    const sse = await fixture('anthropic-text-only.sse')
    const { calls } = mockFetch(() => sseResponse(sse))
    const provider = new AnthropicMessagesProvider({ apiKey: 'sk-ant-test' })
    const messages: Message[] = [
      userMsg('first', 'u1'),
      { id: 'a-empty', role: 'assistant', blocks: [], createdAt: 2 },
      userMsg('second', 'u2'),
      {
        id: 'a-blank',
        role: 'assistant',
        blocks: [{ type: 'text', text: '' }],
        createdAt: 4,
      },
      userMsg('third', 'u3'),
    ]
    await collect(provider.stream(baseReq({ messages }), new AbortController().signal))
    const req = await lastPayload(calls)
    expect(
      req.body.messages.some(
        (msg) => msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.length === 0,
      ),
    ).toBe(false)
    expect(req.body.messages.filter((msg) => msg.role === 'assistant')).toHaveLength(0)
    expect(req.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
      { role: 'user', content: [{ type: 'text', text: 'third' }] },
    ])
  })

  test('consecutive tool messages collapse to one user tool_result message', async () => {
    const sse = await fixture('anthropic-text-only.sse')
    const { calls } = mockFetch(() => sseResponse(sse))
    const provider = new AnthropicMessagesProvider({ apiKey: 'sk-ant-test' })
    const messages: Message[] = [
      userMsg('weather?'),
      {
        id: 'a1',
        role: 'assistant',
        blocks: [
          { type: 'thinking', text: 'need tools' },
          { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
          { type: 'tool_use', id: 'tu_2', name: 'get_weather', input: { city: 'Lyon' } },
        ],
        createdAt: 2,
      },
      {
        id: 't1',
        role: 'tool',
        toolUseId: 'tu_1',
        ok: true,
        blocks: [{ type: 'text', text: 'sunny' }],
        createdAt: 3,
      },
      {
        id: 't2',
        role: 'tool',
        toolUseId: 'tu_2',
        ok: false,
        blocks: [{ type: 'text', text: 'timeout' }],
        createdAt: 4,
      },
    ]
    await collect(
      provider.stream(
        baseReq({
          messages,
          tools: [
            {
              name: 'get_weather',
              description: 'weather',
              inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
            },
          ],
        }),
        new AbortController().signal,
      ),
    )

    const req = await lastPayload(calls)
    expect(req.body.messages).toHaveLength(3)
    expect(req.body.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'weather?' }],
    })
    expect(req.body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'need tools' },
        { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
        { type: 'tool_use', id: 'tu_2', name: 'get_weather', input: { city: 'Lyon' } },
      ],
    })
    expect(req.body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'sunny', is_error: false },
        { type: 'tool_result', tool_use_id: 'tu_2', content: 'timeout', is_error: true },
      ],
    })
    expect(req.body.tools).toEqual([
      {
        name: 'get_weather',
        description: 'weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ])
  })

  test('maps image blocks on user and tool messages to base64 source', async () => {
    const sse = await fixture('anthropic-text-only.sse')
    const { calls } = mockFetch(() => sseResponse(sse))
    const provider = new AnthropicMessagesProvider({ apiKey: 'sk-ant-test' })
    const messages: Message[] = [
      {
        id: 'u1',
        role: 'user',
        blocks: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', mediaType: 'image/png', data: 'abc' },
        ],
        createdAt: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        blocks: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'dot.png' } }],
        createdAt: 2,
      },
      {
        id: 't1',
        role: 'tool',
        toolUseId: 'tu_1',
        ok: true,
        blocks: [
          { type: 'text', text: '[image image/png]' },
          { type: 'image', mediaType: 'image/png', data: 'abc' },
        ],
        createdAt: 3,
      },
    ]
    await collect(provider.stream(baseReq({ messages }), new AbortController().signal))
    const req = await lastPayload(calls)
    expect(req.body.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'abc' },
        },
      ],
    })
    expect(req.body.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: [
            { type: 'text', text: '[image image/png]' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'abc' },
            },
          ],
          is_error: false,
        },
      ],
    })
  })

  test('text stream yields text_deltas, usage, and stop; split tool JSON is one tool_call', async () => {
    const provider = new AnthropicMessagesProvider({ apiKey: 'sk-ant-test' })

    mockFetch(async () => sseResponse(await fixture('anthropic-text-only.sse')))
    const textChunks = await collect(provider.stream(baseReq(), new AbortController().signal))
    const text = textChunks
      .filter((c): c is Extract<ProviderChunk, { type: 'text_delta' }> => c.type === 'text_delta')
      .map((c) => c.text)
      .join('')
    expect(text).toBe('Hi there')
    expect(textChunks.some((c) => c.type === 'stop' && c.reason === 'end_turn')).toBe(true)
    expect(textChunks.find((c) => c.type === 'usage')).toEqual({
      type: 'usage',
      usage: { input: 20, output: 4, cacheRead: 2, cacheWrite: 5 },
    })

    mockFetch(async () => sseResponse(await fixture('anthropic-tool-use-split.sse')))
    const toolChunks = await collect(provider.stream(baseReq(), new AbortController().signal))
    const toolCalls = toolChunks.filter((c) => c.type === 'tool_call')
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toEqual({
      type: 'tool_call',
      id: 'toolu_01XYZ',
      name: 'get_weather',
      input: { location: 'Paris' },
    })
  })

  test('401 is ProviderError retryable false; 429 is retryable true', async () => {
    const provider = new AnthropicMessagesProvider({ apiKey: 'sk-ant-test' })

    mockFetch(() => new Response('nope', { status: 401 }))
    const err401 = await collect(provider.stream(baseReq(), new AbortController().signal)).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err401).toBeInstanceOf(ProviderError)
    expect(err401).toMatchObject({ retryable: false, status: 401 })

    mockFetch(() => new Response('rate', { status: 429 }))
    const err429 = await collect(provider.stream(baseReq(), new AbortController().signal)).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err429).toBeInstanceOf(ProviderError)
    expect(err429).toMatchObject({ retryable: true, status: 429 })
  })

  test('AbortSignal aborts a hanging fetch', async () => {
    mockFetch((_url, init) => {
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
        if (init?.signal?.aborted) {
          abort()
          return
        }
        init?.signal?.addEventListener('abort', abort, { once: true })
      })
    })
    const provider = new AnthropicMessagesProvider({ apiKey: 'sk-ant-test' })
    const ac = new AbortController()
    const pending = collect(provider.stream(baseReq(), ac.signal))
    await Promise.resolve()
    ac.abort()
    const err = await pending.then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe('AbortError')
  })
})
