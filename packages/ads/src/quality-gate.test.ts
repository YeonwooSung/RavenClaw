import { afterEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchAds } from './client'

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

const FORBIDDEN_KEYS = new Set(['repo', 'cwd', 'git', 'path', 'diff', 'remote'])
const GIT_REMOTE =
  /(?:git@|git:\/\/|https?:\/\/)[\w.-]+[:/][\w./-]+(?:\.git)?\b|github\.com|gitlab\.com|bitbucket\.org/

function collectKeysAndStrings(
  value: unknown,
  keys: string[] = [],
  strings: string[] = [],
): { keys: string[]; strings: string[] } {
  if (Array.isArray(value)) {
    for (const item of value) collectKeysAndStrings(item, keys, strings)
    return { keys, strings }
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      keys.push(key)
      collectKeysAndStrings(nested, keys, strings)
    }
    return { keys, strings }
  }
  if (typeof value === 'string') strings.push(value)
  return { keys, strings }
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

describe('quality gate', () => {
  test('ad POST body has no repo fields', async () => {
    const { calls } = spyFetch()
    await fetchAds({
      enabled: true,
      feedUrl: 'https://ads.example.com/v1',
      sessionId: 'sess-qg',
      messages: [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi' },
      ],
      device: { os: 'darwin', locale: 'en-US', tz: 'UTC' },
    })
    expect(calls).toHaveLength(1)
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
    expect(body.sessionId).toBe('sess-qg')
    expect(body.placementIds).toEqual(['raven-dock-1'])
    expect(body.surface).toBe('cli')
    expect(body.messages).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi' },
    ])
    expect(body.device).toEqual({ os: 'darwin', locale: 'en-US', tz: 'UTC' })

    const { keys, strings } = collectKeysAndStrings(body)
    for (const key of keys) {
      expect(FORBIDDEN_KEYS.has(key)).toBe(false)
    }
    for (const value of strings) {
      expect(value).not.toMatch(GIT_REMOTE)
    }
  })

  test('BYOK / enabled:false never calls fetch', async () => {
    const { calls } = spyFetch()
    await fetchAds({
      enabled: false,
      feedUrl: 'https://ads.example.com/v1',
      sessionId: 'sess-byok',
    })
    expect(calls).toHaveLength(0)
  })

  test('ads package has no @ravenclaw/core import', () => {
    const root = join(import.meta.dir, '..')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.['@ravenclaw/core']).toBeUndefined()
    expect(pkg.devDependencies?.['@ravenclaw/core']).toBeUndefined()
    expect(pkg.peerDependencies?.['@ravenclaw/core']).toBeUndefined()

    const importRe =
      /(?:from|import\(|require\()\s*['"]@ravenclaw\/core(?:\/[^'"]*)?['"]/
    const files = walk(join(root, 'src')).filter((path) =>
      /\.(ts|tsx)$/.test(path),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      expect(text).not.toMatch(importRe)
    }
  })
})
