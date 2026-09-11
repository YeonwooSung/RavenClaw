import { afterEach, describe, expect, test } from 'bun:test'
import { probeEntitlement } from './entitlement'

const DENIED = {
  admitted: false,
  placementRequired: false,
  hasPaidCapacityPlan: false,
} as const

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('probeEntitlement', () => {
  const originalTimeout = AbortSignal.timeout
  afterEach(() => {
    AbortSignal.timeout = originalTimeout
  })

  test('GET {baseUrl}/v1/entitlement and parses JSON booleans', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const entitlement = await probeEntitlement('https://gw.example.com', {
      fetch: (url, init) => {
        calls.push({ url, init })
        return jsonResponse({
          admitted: true,
          placementRequired: true,
          hasPaidCapacityPlan: true,
        })
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://gw.example.com/v1/entitlement')
    expect(calls[0]?.init?.method).toBe('GET')
    expect(entitlement).toEqual({
      admitted: true,
      placementRequired: true,
      hasPaidCapacityPlan: true,
    })
  })

  test('trims trailing slashes on baseUrl', async () => {
    const urls: string[] = []
    await probeEntitlement('https://gw.example.com/', {
      fetch: (url) => {
        urls.push(url)
        return jsonResponse({ admitted: true })
      },
    })
    expect(urls).toEqual(['https://gw.example.com/v1/entitlement'])
  })

  test('sends Bearer token when provided', async () => {
    const headers: Array<HeadersInit | undefined> = []
    await probeEntitlement('https://gw.example.com', {
      token: 'sess-token',
      fetch: (_url, init) => {
        headers.push(init?.headers)
        return jsonResponse({ admitted: true })
      },
    })
    const rec = headers[0]
    const value =
      rec instanceof Headers
        ? rec.get('authorization')
        : Array.isArray(rec)
          ? rec.find(([k]) => k.toLowerCase() === 'authorization')?.[1]
          : rec && typeof rec === 'object'
            ? ((rec as Record<string, string>).authorization ??
              (rec as Record<string, string>).Authorization)
            : undefined
    expect(value).toBe('Bearer sess-token')
  })

  test('missing fields default to false', async () => {
    const entitlement = await probeEntitlement('https://gw.example.com', {
      fetch: () => jsonResponse({ admitted: true }),
    })
    expect(entitlement).toEqual({
      admitted: true,
      placementRequired: false,
      hasPaidCapacityPlan: false,
    })
  })

  test('non-boolean JSON values coerce to false', async () => {
    const entitlement = await probeEntitlement('https://gw.example.com', {
      fetch: () =>
        jsonResponse({
          admitted: 'true',
          placementRequired: 1,
          hasPaidCapacityPlan: null,
        }),
    })
    expect(entitlement).toEqual(DENIED)
  })

  test('uses a 2s timeout', async () => {
    const seen: number[] = []
    AbortSignal.timeout = ((ms: number) => {
      seen.push(ms)
      return originalTimeout(ms)
    }) as typeof AbortSignal.timeout
    await probeEntitlement('https://gw.example.com', {
      fetch: () => jsonResponse({ admitted: true }),
    })
    expect(seen).toEqual([2_000])
  })

  test('4xx/5xx coerce to denied and do not throw', async () => {
    await expect(
      probeEntitlement('https://gw.example.com', {
        fetch: () => jsonResponse({ admitted: true }, 403),
      }),
    ).resolves.toEqual(DENIED)
    await expect(
      probeEntitlement('https://gw.example.com', {
        fetch: () => jsonResponse({ error: 'boom' }, 503),
      }),
    ).resolves.toEqual(DENIED)
  })

  test('parses optional sessionCap, remainingSessions, and defaultModel', async () => {
    const entitlement = await probeEntitlement('https://gw.example.com', {
      fetch: () =>
        jsonResponse({
          admitted: true,
          sessionCap: 16,
          remainingSessions: 3,
          defaultModel: 'openai/gpt-4o',
        }),
    })
    expect(entitlement).toEqual({
      admitted: true,
      placementRequired: false,
      hasPaidCapacityPlan: false,
      sessionCap: 16,
      remainingSessions: 3,
      defaultModel: 'openai/gpt-4o',
    })
  })

  test('invalid extras are omitted and do not deny when admitted is true', async () => {
    const entitlement = await probeEntitlement('https://gw.example.com', {
      fetch: () =>
        jsonResponse({
          admitted: true,
          sessionCap: '16',
          remainingSessions: null,
          defaultModel: 1,
        }),
    })
    expect(entitlement).toEqual({
      admitted: true,
      placementRequired: false,
      hasPaidCapacityPlan: false,
    })
    expect(entitlement.sessionCap).toBeUndefined()
    expect(entitlement.remainingSessions).toBeUndefined()
    expect(entitlement.defaultModel).toBeUndefined()
  })

  test('network, timeout, and invalid JSON coerce to denied', async () => {
    await expect(
      probeEntitlement('https://gw.example.com', {
        fetch: () => Promise.reject(new TypeError('fetch failed')),
      }),
    ).resolves.toEqual(DENIED)
    await expect(
      probeEntitlement('https://gw.example.com', {
        fetch: () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
      }),
    ).resolves.toEqual(DENIED)
    await expect(
      probeEntitlement('https://gw.example.com', {
        fetch: () => new Response('not-json', { status: 200 }),
      }),
    ).resolves.toEqual(DENIED)
  })
})
