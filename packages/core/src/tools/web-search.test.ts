import { describe, expect, test } from 'bun:test'
import type { ToolContext, Turn } from '../types'
import { createWebSearchTool, webSearchTool } from './web-search'

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('WebSearch', () => {
  test('is a concurrency-safe read-only tool that allows by mode', async () => {
    expect(webSearchTool.name).toBe('WebSearch')
    expect(webSearchTool.isConcurrencySafe({ query: 'x' })).toBe(true)
    expect(webSearchTool.isReadOnly({ query: 'x' })).toBe(true)
    expect(webSearchTool.interruptBehavior?.()).toBe('cancel')
    const decision = await webSearchTool.checkPermissions({ query: 'x' }, makeCtx())
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('parse requires query and accepts depth', () => {
    expect(webSearchTool.parse({ query: 'bun test' }).ok).toBe(true)
    expect(webSearchTool.parse({ query: 'bun', depth: 'deep' }).ok).toBe(true)
    expect(webSearchTool.parse({ query: 'bun', depth: 'standard' }).ok).toBe(true)
    expect(webSearchTool.parse({}).ok).toBe(false)
    expect(webSearchTool.parse({ query: '' }).ok).toBe(false)
    expect(webSearchTool.parse({ query: 'x', depth: 'nope' }).ok).toBe(false)
  })

  test('returns a missing-key error without calling fetch', async () => {
    let calls = 0
    const tool = createWebSearchTool({
      env: {},
      fetchImpl: async () => {
        calls += 1
        return jsonResponse({})
      },
    })
    const out = await tool.execute({ query: 'anything' }, makeCtx())
    expect(out).toBe('WebSearch failed: set BRAVE_API_KEY or SERPER_API_KEY')
    expect(calls).toBe(0)
  })

  test('Brave GET uses X-Subscription-Token and formats title/url/snippet blocks', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const tool = createWebSearchTool({
      env: { BRAVE_API_KEY: 'brave-secret' },
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return jsonResponse({
          web: {
            results: [
              { title: 'One', url: 'https://example.com/1', description: 'first' },
              { title: 'Two', url: 'https://example.com/2', description: 'second' },
            ],
          },
        })
      },
    })
    const out = await tool.execute({ query: 'raven claw' }, makeCtx())
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      'https://api.search.brave.com/res/v1/web/search?q=raven%20claw&count=5',
    )
    expect(calls[0]?.init?.method).toBe('GET')
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('X-Subscription-Token')).toBe('brave-secret')
    expect(out).toBe('One\nhttps://example.com/1\nfirst\n\nTwo\nhttps://example.com/2\nsecond\n')
  })

  test('Serper POST uses X-API-KEY and depth deep sets num to 10', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const tool = createWebSearchTool({
      env: { SERPER_API_KEY: 'serper-secret' },
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return jsonResponse({
          organic: [{ title: 'Hit', link: 'https://example.com/s', snippet: 'found' }],
        })
      },
    })
    const out = await tool.execute({ query: 'bun', depth: 'deep' }, makeCtx())
    expect(calls[0]?.url).toBe('https://google.serper.dev/search')
    expect(calls[0]?.init?.method).toBe('POST')
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('X-API-KEY')).toBe('serper-secret')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ q: 'bun', num: 10 })
    expect(out).toBe('Hit\nhttps://example.com/s\nfound\n')
  })

  test('WEBSEARCH_API_KEY without Brave/Serper is treated as Brave', async () => {
    const calls: Array<{ url: string }> = []
    const tool = createWebSearchTool({
      env: { WEBSEARCH_API_KEY: 'fallback' },
      fetchImpl: async (url) => {
        calls.push({ url })
        return jsonResponse({ web: { results: [] } })
      },
    })
    await tool.execute({ query: 'x' }, makeCtx())
    expect(calls[0]?.url.startsWith('https://api.search.brave.com/')).toBe(true)
  })

  test('BRAVE_API_KEY wins over SERPER_API_KEY', async () => {
    const calls: Array<{ url: string }> = []
    const tool = createWebSearchTool({
      env: { BRAVE_API_KEY: 'b', SERPER_API_KEY: 's' },
      fetchImpl: async (url) => {
        calls.push({ url })
        return jsonResponse({ web: { results: [] } })
      },
    })
    await tool.execute({ query: 'x' }, makeCtx())
    expect(calls[0]?.url).toContain('api.search.brave.com')
  })

  test('HTTP errors become WebSearch failed', async () => {
    const tool = createWebSearchTool({
      env: { BRAVE_API_KEY: 'b' },
      fetchImpl: async () => jsonResponse({ error: 'nope' }, 401),
    })
    const out = await tool.execute({ query: 'x' }, makeCtx())
    expect(out.startsWith('WebSearch failed:')).toBe(true)
    expect(out).toContain('401')
  })

  test('caps formatted output around 20000 characters', async () => {
    const tool = createWebSearchTool({
      env: { BRAVE_API_KEY: 'b' },
      fetchImpl: async () =>
        jsonResponse({
          web: {
            results: [{ title: 'T', url: 'https://example.com', description: 'y'.repeat(25_000) }],
          },
        }),
    })
    const out = await tool.execute({ query: 'big' }, makeCtx())
    expect(out.length).toBeLessThanOrEqual(20_000 + 40)
    expect(out.endsWith('... [truncated]')).toBe(true)
  })

  test('execute refuses when the signal is already aborted', async () => {
    let calls = 0
    const tool = createWebSearchTool({
      env: { BRAVE_API_KEY: 'b' },
      fetchImpl: async () => {
        calls += 1
        return jsonResponse({ web: { results: [] } })
      },
    })
    const ac = new AbortController()
    ac.abort()
    await expect(tool.execute({ query: 'x' }, makeCtx(ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(calls).toBe(0)
  })
})
