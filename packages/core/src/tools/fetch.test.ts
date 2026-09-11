import { afterEach, describe, expect, test } from 'bun:test'
import type { ToolContext, Turn } from '../types'
import { fetchTool, isBlockedFetchUrl } from './fetch'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makeTurn(cwd = '/tmp'): Turn {
  return {
    id: 'turn_1',
    sessionId: 'sess_1',
    messages: [],
    round: 1,
    maxRounds: 80,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd,
    model: 'dummy',
    readFiles: new Set(),
  }
}

function makeCtx(signal?: AbortSignal): ToolContext {
  const turn = makeTurn()
  return {
    turn,
    signal: signal ?? turn.abort.signal,
    onProgress() {},
  }
}

describe('Fetch', () => {
  test('is a leftover-ask read-only tool named Fetch', async () => {
    expect(fetchTool.name).toBe('Fetch')
    expect(fetchTool.isConcurrencySafe({ url: 'https://example.com' })).toBe(true)
    expect(fetchTool.isReadOnly({ url: 'https://example.com' })).toBe(true)
    const decision = await fetchTool.checkPermissions({ url: 'https://example.com' }, makeCtx())
    expect(decision.behavior).toBe('ask')
  })

  test('parse requires a url string', () => {
    expect(fetchTool.parse({ url: 'https://example.com' }).ok).toBe(true)
    expect(fetchTool.parse({}).ok).toBe(false)
    expect(fetchTool.parse({ url: '' }).ok).toBe(false)
  })

  test('rejects http, file, localhost, loopback, and private or link-local hosts', () => {
    expect(isBlockedFetchUrl('http://example.com')).toBeDefined()
    expect(isBlockedFetchUrl('file:///etc/passwd')).toBeDefined()
    expect(isBlockedFetchUrl('https://localhost/x')).toBeDefined()
    expect(isBlockedFetchUrl('https://127.0.0.1/x')).toBeDefined()
    expect(isBlockedFetchUrl('https://10.0.0.4/x')).toBeDefined()
    expect(isBlockedFetchUrl('https://192.168.1.9/x')).toBeDefined()
    expect(isBlockedFetchUrl('https://172.16.0.4/x')).toBeDefined()
    expect(isBlockedFetchUrl('https://169.254.1.1/x')).toBeDefined()
    expect(isBlockedFetchUrl('https://[::1]/x')).toBeDefined()
    expect(isBlockedFetchUrl('https://example.com')).toBeUndefined()
  })

  test('execute returns text and caps the body at 100000 characters', async () => {
    globalThis.fetch = (async () =>
      new Response('hello fetch', { status: 200, headers: { 'Content-Type': 'text/plain' } })) as typeof fetch
    const out = await fetchTool.execute({ url: 'https://example.com/note' }, makeCtx())
    expect(out).toBe('hello fetch')

    globalThis.fetch = (async () =>
      new Response('x'.repeat(100_010), {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })) as typeof fetch
    const capped = await fetchTool.execute({ url: 'https://example.com/big' }, makeCtx())
    expect(typeof capped).toBe('string')
    expect(capped.length).toBeLessThanOrEqual(100_000 + 80)
    expect(capped.startsWith('x'.repeat(1000))).toBe(true)
  })

  test('execute reports blocked and failed URLs without calling fetch for local hosts', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response('nope', { status: 200 })
    }) as typeof fetch
    const blocked = await fetchTool.execute({ url: 'http://127.0.0.1/' }, makeCtx())
    expect(blocked.toLowerCase()).toMatch(/fail|block|reject|http/)
    expect(calls).toBe(0)
  })
})
