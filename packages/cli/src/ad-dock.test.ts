import { afterEach, describe, expect, test } from 'bun:test'
import { houseAds, type AdCreative } from '@ravenclaw/ads'
import {
  ackDockClick,
  claimDockViewAck,
  maybeAckDockView,
  resetDockViewAcks,
  shouldAckCreative,
} from './ad-dock'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  resetDockViewAcks()
})

function spyFetch(): { calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return Promise.resolve(new Response('', { status: 200 }))
  }) as typeof fetch
  return { calls }
}

const firstParty: AdCreative = {
  id: 'fp-1',
  title: 'Feed title',
  body: 'Feed body',
  cta: 'Go',
  url: 'https://ads.example.com/ack',
  provider: 'first_party',
}

describe('shouldAckCreative', () => {
  test('acks first-party only', () => {
    expect(shouldAckCreative(firstParty)).toBe(true)
    expect(shouldAckCreative(houseAds({ hasPaidCapacityPlan: false }))).toBe(false)
    expect(shouldAckCreative(houseAds({ hasPaidCapacityPlan: true }))).toBe(false)
    expect(shouldAckCreative(undefined)).toBe(false)
  })
})

describe('claimDockViewAck', () => {
  test('dedupes by creative id', () => {
    expect(claimDockViewAck('fp-1')).toBe(true)
    expect(claimDockViewAck('fp-1')).toBe(false)
    expect(claimDockViewAck('fp-2')).toBe(true)
    resetDockViewAcks()
    expect(claimDockViewAck('fp-1')).toBe(true)
  })
})

describe('maybeAckDockView', () => {
  test('POSTs once for a shown first-party creative', async () => {
    const { calls } = spyFetch()
    maybeAckDockView(firstParty, true)
    maybeAckDockView(firstParty, true)
    await Promise.resolve()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://ads.example.com/ack')
    expect(calls[0]?.init?.method).toBe('POST')
  })

  test('skips house ads and hidden docks', async () => {
    const { calls } = spyFetch()
    maybeAckDockView(houseAds({ hasPaidCapacityPlan: false }), true)
    maybeAckDockView(firstParty, false)
    maybeAckDockView(undefined, true)
    await Promise.resolve()
    expect(calls).toHaveLength(0)
  })
})

describe('ackDockClick', () => {
  test('skips when the feed has no click endpoint', async () => {
    const { calls } = spyFetch()
    ackDockClick(undefined, 0, 400)
    ackDockClick('', 0, 400)
    ackDockClick('   ', 0, 400)
    await Promise.resolve()
    expect(calls).toHaveLength(0)
  })

  test('labels sub-300ms clicks accidental and still POSTs', async () => {
    const { calls } = spyFetch()
    ackDockClick('https://ads.example.com/click', 0, 299)
    await Promise.resolve()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://ads.example.com/click')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ accidental: true }))
  })

  test('labels slower clicks as not accidental', async () => {
    const { calls } = spyFetch()
    ackDockClick('https://ads.example.com/click', 0, 300)
    await Promise.resolve()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ accidental: false }))
  })

  test('never throws when fetch fails', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch
    let threw = false
    try {
      ackDockClick('https://ads.example.com/click', 0, 400)
      await Promise.resolve()
      await Promise.resolve()
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })
})
