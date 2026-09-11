import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Message, ProviderChunk, ProviderRequest, SystemPart } from '@ravenclaw/core'
import { OpenAICompatProvider } from './openai-compat'
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

describe('OpenAICompatProvider', () => {
  test('text-only stream concatenates text_deltas and yields stop', async () => {
    const body = await fixture('openai-text-only.sse')
    mockFetch(() => sseResponse(body))
    const provider = new OpenAICompatProvider({ apiKey: 'sk-test' })
    const chunks = await collect(provider.stream(baseReq(), new AbortController().signal))

    const text = chunks
      .filter((c): c is Extract<ProviderChunk, { type: 'text_delta' }> => c.type === 'text_delta')
      .map((c) => c.text)
      .join('')
    expect(text).toBe('Hello, world')
    expect(chunks.some((c) => c.type === 'stop' && c.reason === 'stop')).toBe(true)
    const usage = chunks.find((c) => c.type === 'usage')
    expect(usage).toEqual({
      type: 'usage',
      usage: { input: 12, output: 3, cacheRead: 4, cacheWrite: 0 },
    })
  })

  test('tool call split across deltas yields one complete tool_call only', async () => {
    const body = await fixture('openai-tool-call-split.sse')
    mockFetch(() => sseResponse(body))
    const provider = new OpenAICompatProvider({ apiKey: 'sk-test' })
    const chunks = await collect(provider.stream(baseReq(), new AbortController().signal))

    const toolCalls = chunks.filter((c) => c.type === 'tool_call')
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toEqual({
      type: 'tool_call',
      id: 'call_abc123',
      name: 'get_weather',
      input: { location: 'Paris' },
    })
    expect(chunks.some((c) => c.type === 'stop' && c.reason === 'tool_calls')).toBe(true)
  })

  test('maps SystemPart[] into a single system string in the request body', async () => {
    const body = await fixture('openai-text-only.sse')
    const { calls } = mockFetch(() => sseResponse(body))
    const provider = new OpenAICompatProvider({ apiKey: 'sk-test' })
    const system: SystemPart[] = [
      { tier: 'stable', text: 'ALPHA', cacheBreakpoint: true },
      { tier: 'context', text: 'BETA' },
      { tier: 'volatile', text: 'GAMMA' },
    ]
    const messages: Message[] = [
      userMsg('hello'),
      {
        id: 'a1',
        role: 'assistant',
        blocks: [
          { type: 'thinking', text: 'secret-thought' },
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
    expect(call?.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(call?.init?.method).toBe('POST')
    expect(call?.init?.headers).toMatchObject({
      Authorization: 'Bearer sk-test',
    })
    const payload = JSON.parse(String(call?.init?.body)) as {
      model: string
      stream: boolean
      max_tokens: number
      messages: Array<Record<string, unknown>>
      tools: unknown[]
    }
    expect(payload.stream).toBe(true)
    expect(payload.model).toBe('openai/gpt-4o')
    expect(payload.max_tokens).toBe(128)
    expect(payload.messages[0]).toEqual({ role: 'system', content: 'ALPHABETAGAMMA' })
    expect(payload.messages[1]).toEqual({ role: 'user', content: 'hello' })
    expect(payload.messages[2]).toEqual({
      role: 'assistant',
      content: 'ok',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'Echo', arguments: '{"text":"x"}' },
        },
      ],
    })
    expect(JSON.stringify(payload.messages[2])).not.toContain('secret-thought')
    expect(payload.messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'echoed',
    })
    expect(payload.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'Echo',
          description: 'echo',
          parameters: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
    ])
  })

  test('maps image blocks on user and tool messages to image_url data URLs', async () => {
    const body = await fixture('openai-text-only.sse')
    const { calls } = mockFetch(() => sseResponse(body))
    const provider = new OpenAICompatProvider({ apiKey: 'sk-test' })
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
        blocks: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'dot.png' } }],
        createdAt: 2,
      },
      {
        id: 't1',
        role: 'tool',
        toolUseId: 'call_1',
        ok: true,
        blocks: [
          { type: 'text', text: '[image image/png]' },
          { type: 'image', mediaType: 'image/png', data: 'abc' },
        ],
        createdAt: 3,
      },
    ]
    await collect(provider.stream(baseReq({ messages }), new AbortController().signal))
    const payload = JSON.parse(String(calls[0]?.init?.body)) as {
      messages: Array<Record<string, unknown>>
    }
    expect(payload.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
    })
    expect(payload.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: [
        { type: 'text', text: '[image image/png]' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
    })
  })

  test('401 is ProviderError retryable false; 429 is retryable true', async () => {
    const provider = new OpenAICompatProvider({ apiKey: 'sk-test' })

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

  test('AbortSignal aborts a hanging fetch', async () => {
    let fetchSignal: AbortSignal | undefined
    mockFetch((_url, init) => {
      fetchSignal = init?.signal
      return new Promise((_resolve, reject) => {
        const abort = () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }
        if (init?.signal?.aborted) {
          abort()
          return
        }
        init?.signal?.addEventListener('abort', abort, { once: true })
      })
    })

    const provider = new OpenAICompatProvider({ apiKey: 'sk-test' })
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
    expect(fetchSignal?.aborted).toBe(true)
  })
})
