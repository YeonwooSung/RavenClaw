import { afterEach, describe, expect, test } from 'bun:test'
import { fetchAds } from './client'
import { houseAds } from './house'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function spyFetch(): { calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'raven-dock-1',
          creative: {
            id: 'feed-1',
            title: 'Feed title',
            body: 'Feed body',
            cta: 'Go',
            url: 'https://ads.example.com/feed',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
  }) as typeof fetch
  return { calls }
}

describe('fetchAds', () => {
  test('disabled / BYOK never calls fetch and returns house', async () => {
    const { calls } = spyFetch()
    const placement = await fetchAds({
      enabled: false,
      feedUrl: 'https://ads.example.com/v1',
      sessionId: 'sess-1',
    })
    expect(calls).toHaveLength(0)
    expect(placement.creative).toEqual(houseAds({ hasPaidCapacityPlan: false }))
    expect(placement.id).toBe('raven-dock-1')
  })

  test('empty feedUrl never calls fetch and returns house', async () => {
    const { calls } = spyFetch()
    const empty = await fetchAds({ enabled: true, feedUrl: '', sessionId: 'sess-1' })
    const missing = await fetchAds({ enabled: true, sessionId: 'sess-1' })
    expect(calls).toHaveLength(0)
    expect(empty.creative.provider).toBe('house')
    expect(missing.creative.provider).toBe('house')
  })

  test('enabled + url POSTs a body with no repo fields', async () => {
    const { calls } = spyFetch()
    const placement = await fetchAds({
      enabled: true,
      feedUrl: 'https://ads.example.com/v1',
      sessionId: 'sess-9',
      messages: [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi' },
      ],
      device: { os: 'darwin', locale: 'en-US', tz: 'UTC' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://ads.example.com/v1')
    expect(calls[0]?.init?.method).toBe('POST')
    const raw = calls[0]?.init?.body
    expect(typeof raw).toBe('string')
    const body = JSON.parse(String(raw)) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual([
      'device',
      'messages',
      'placementIds',
      'sessionId',
      'surface',
    ])
    expect(body).not.toHaveProperty('repo')
    expect(body).not.toHaveProperty('cwd')
    expect(body).not.toHaveProperty('git')
    expect(body).not.toHaveProperty('path')
    expect(body).not.toHaveProperty('diff')
    expect(body.sessionId).toBe('sess-9')
    expect(body.surface).toBe('cli')
    expect(body.placementIds).toEqual(['raven-dock-1'])
    expect(body.messages).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi' },
    ])
    expect(placement.creative.provider).toBe('first_party')
    expect(placement.creative.title).toBe('Feed title')
  })
})
