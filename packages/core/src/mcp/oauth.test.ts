import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MCP_AUTH_REQUIRED,
  authorizeMcpOAuth,
  createPkcePair,
  ensureMcpOAuthAccess,
  loadMcpOAuthTokens,
  mcpOAuthTokenPath,
  refreshMcpOAuth,
  saveMcpOAuthTokens,
} from './oauth'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raven-mcp-oauth-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'mcp-oauth'), { recursive: true })
  return dir
}

describe('mcp oauth tokens', () => {
  test('writes mode 0600 and sanitizes the server name', () => {
    const home = tempHome()
    saveMcpOAuthTokens('docs/prod', { accessToken: 'tok', refreshToken: 'ref' }, home)
    const path = mcpOAuthTokenPath('docs/prod', home)
    expect(path).toBe(join(home, 'mcp-oauth', 'docs_prod.json'))
    expect(path).not.toContain('/docs/')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(loadMcpOAuthTokens('docs/prod', home)).toEqual({
      accessToken: 'tok',
      refreshToken: 'ref',
    })
  })

  test('createPkcePair returns S256-sized verifier and challenge', () => {
    const pair = createPkcePair()
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43)
    expect(pair.challenge.length).toBeGreaterThanOrEqual(43)
    expect(pair.verifier).not.toBe(pair.challenge)
  })
})

describe('ensureMcpOAuthAccess', () => {
  test('authorizes with PKCE and stores tokens', async () => {
    const home = tempHome()
    const posts: Array<{ url: string; body: string }> = []
    const opened: string[] = []
    const tokens = await authorizeMcpOAuth({
      serverName: 'docs',
      home,
      oauth: {
        clientId: 'cli-1',
        scope: 'mcp',
        redirectPort: 8756,
        authorizationUrl: 'https://auth.example/authorize',
        tokenUrl: 'https://auth.example/token',
      },
      async openBrowser(url) {
        opened.push(url)
      },
      async listenOnce(port, state) {
        expect(port).toBe(8756)
        return { code: 'code-1', state }
      },
      fetchImpl: async (input, init) => {
        const url = String(input)
        posts.push({ url, body: String(init?.body ?? '') })
        expect(init?.method).toBe('POST')
        return new Response(
          JSON.stringify({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
      now: () => 1_000,
    })
    expect(tokens.accessToken).toBe('access-1')
    expect(tokens.refreshToken).toBe('refresh-1')
    expect(opened[0]).toContain('code_challenge_method=S256')
    expect(opened[0]).toContain('client_id=cli-1')
    expect(opened[0]).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A8756%2Fcallback')
    expect(posts[0]?.url).toBe('https://auth.example/token')
    expect(posts[0]?.body).toContain('grant_type=authorization_code')
    expect(posts[0]?.body).toContain('code=code-1')
    expect(posts[0]?.body).toContain('code_verifier=')
    expect(loadMcpOAuthTokens('docs', home)?.accessToken).toBe('access-1')
  })

  test('reuses a live token and refreshes when expired', async () => {
    const home = tempHome()
    saveMcpOAuthTokens(
      'docs',
      { accessToken: 'old', refreshToken: 'ref', expiresAt: 50_000 },
      home,
    )
    const live = await ensureMcpOAuthAccess({
      serverName: 'docs',
      home,
      oauth: { clientId: 'cli-1', tokenUrl: 'https://auth.example/token', authorizationUrl: 'https://auth.example/a' },
      interactive: false,
      now: () => 1_000,
    })
    expect(live.accessToken).toBe('old')

    const refreshed = await ensureMcpOAuthAccess({
      serverName: 'docs',
      home,
      oauth: { clientId: 'cli-1', tokenUrl: 'https://auth.example/token', authorizationUrl: 'https://auth.example/a' },
      interactive: false,
      now: () => 50_000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ access_token: 'new', token_type: 'Bearer' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    })
    expect(refreshed.accessToken).toBe('new')
    expect(loadMcpOAuthTokens('docs', home)?.refreshToken).toBe('ref')
  })

  test('fails closed without a browser in non-interactive mode', async () => {
    const home = tempHome()
    await expect(
      ensureMcpOAuthAccess({
        serverName: 'docs',
        home,
        oauth: { clientId: 'cli-1' },
        interactive: false,
      }),
    ).rejects.toMatchObject({ message: MCP_AUTH_REQUIRED })
  })

  test('refresh fails closed on a 401 token endpoint', async () => {
    const home = tempHome()
    await expect(
      refreshMcpOAuth({
        serverName: 'docs',
        home,
        oauth: { clientId: 'cli-1', tokenUrl: 'https://auth.example/token', authorizationUrl: 'https://auth.example/a' },
        refreshToken: 'ref',
        fetchImpl: async () => new Response('nope', { status: 401 }),
      }),
    ).rejects.toMatchObject({ message: MCP_AUTH_REQUIRED })
  })
})
