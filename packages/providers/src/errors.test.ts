import { afterEach, describe, expect, test } from 'bun:test'
import {
  fetchWithSingleRetry,
  isAbortError,
  iterateSse,
  joinUrl,
  ProviderError,
  retryableForStatus,
  streamDroppedError,
  throwForHttpError,
  tryParseJson,
} from './errors'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('ProviderError', () => {
  test('sets retryable and optional fields', () => {
    const err = new ProviderError('nope', { retryable: true, status: 429, bytes: 12 })
    expect(err.name).toBe('ProviderError')
    expect(err.retryable).toBe(true)
    expect(err.status).toBe(429)
    expect(err.bytes).toBe(12)
  })
})

describe('isAbortError / retryableForStatus / joinUrl / tryParseJson', () => {
  test('classifies abort names and retryable HTTP statuses', () => {
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
    expect(isAbortError(new Error('x'))).toBe(false)
    expect(retryableForStatus(429)).toBe(true)
    expect(retryableForStatus(529)).toBe(true)
    expect(retryableForStatus(503)).toBe(true)
    expect(retryableForStatus(404)).toBe(false)
    expect(retryableForStatus(400)).toBe(false)
  })

  test('joins urls and parses JSON', () => {
    expect(joinUrl('https://x.com/v1/', '/chat')).toBe('https://x.com/v1/chat')
    expect(joinUrl('https://x.com/v1', 'chat')).toBe('https://x.com/v1/chat')
    expect(tryParseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(tryParseJson('not-json').ok).toBe(false)
  })
})

describe('streamDroppedError', () => {
  test('includes bytes only when greater than zero', () => {
    expect(streamDroppedError(0).bytes).toBeUndefined()
    expect(streamDroppedError(8).bytes).toBe(8)
    expect(streamDroppedError(8).retryable).toBe(true)
  })
})

describe('throwForHttpError', () => {
  test('uses body text when present and marks retryable from status', async () => {
    const res = new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })
    await expect(throwForHttpError(res)).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: true,
      status: 429,
      message: expect.stringContaining('rate limited'),
    })
  })

  test('falls back to statusText when the body is empty', async () => {
    const res = new Response('', { status: 404, statusText: 'Not Found' })
    await expect(throwForHttpError(res)).rejects.toMatchObject({
      retryable: false,
      status: 404,
      message: expect.stringContaining('Not Found'),
    })
  })
})

describe('fetchWithSingleRetry', () => {
  test('returns the first successful fetch', async () => {
    const ok = new Response('ok')
    globalThis.fetch = (async () => ok) as typeof fetch
    const ctrl = new AbortController()
    expect(await fetchWithSingleRetry('https://x', {}, ctrl.signal)).toBe(ok)
  })

  test('retries once on a non-abort network error', async () => {
    let calls = 0
    const ok = new Response('ok')
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) throw new Error('net')
      return ok
    }) as typeof fetch
    const ctrl = new AbortController()
    expect(await fetchWithSingleRetry('https://x', {}, ctrl.signal)).toBe(ok)
    expect(calls).toBe(2)
  })

  test('does not retry AbortError', async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }) as typeof fetch
    const ctrl = new AbortController()
    await expect(fetchWithSingleRetry('https://x', {}, ctrl.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  test('wraps a second network failure as a retryable ProviderError', async () => {
    globalThis.fetch = (async () => {
      throw new Error('down')
    }) as typeof fetch
    const ctrl = new AbortController()
    await expect(fetchWithSingleRetry('https://x', {}, ctrl.signal)).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: true,
      message: 'down',
    })
  })
})

describe('iterateSse', () => {
  test('yields data events and ignores comments', async () => {
    const body = [
      ': keep-alive',
      'event: delta',
      'data: hello',
      '',
      'data: line1',
      'data: line2',
      '',
    ].join('\n')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    })
    const events: Array<{ event: string; data: string }> = []
    let bytes = 0
    for await (const ev of iterateSse(stream, (n) => {
      bytes += n
    })) {
      events.push(ev)
    }
    expect(events).toEqual([
      { event: 'delta', data: 'hello' },
      { event: '', data: 'line1\nline2' },
    ])
    expect(bytes).toBeGreaterThan(0)
  })
})
