import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { McpOAuthConfig } from '../config'
import { ravenclawHome } from '../home'

export const MCP_AUTH_REQUIRED = 'auth required'
export const MCP_OAUTH_DIR = 'mcp-oauth'

export type { McpOAuthConfig }

export interface McpOAuthTokens {
  accessToken: string
  refreshToken?: string
  tokenType?: string
  expiresAt?: number
}

export interface McpOAuthHooks {
  fetchImpl?: typeof fetch
  openBrowser?: (url: string) => Promise<void> | void
  listenOnce?: (port: number, state: string) => Promise<{ code: string; state?: string }>
  now?: () => number
  interactive?: boolean
}

export function mcpOAuthTokenPath(serverName: string, home = ravenclawHome()): string {
  return join(home, MCP_OAUTH_DIR, `${safeServerName(serverName)}.json`)
}

export function loadMcpOAuthTokens(serverName: string, home = ravenclawHome()): McpOAuthTokens | undefined {
  try {
    const parsed = JSON.parse(readFileSync(mcpOAuthTokenPath(serverName, home), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const rec = parsed as Record<string, unknown>
    const accessToken = typeof rec.accessToken === 'string' ? rec.accessToken : undefined
    if (accessToken === undefined || accessToken === '') return undefined
    const out: McpOAuthTokens = { accessToken }
    if (typeof rec.refreshToken === 'string' && rec.refreshToken !== '') out.refreshToken = rec.refreshToken
    if (typeof rec.tokenType === 'string' && rec.tokenType !== '') out.tokenType = rec.tokenType
    if (typeof rec.expiresAt === 'number' && Number.isFinite(rec.expiresAt)) out.expiresAt = rec.expiresAt
    return out
  } catch {
    return undefined
  }
}

export function saveMcpOAuthTokens(
  serverName: string,
  tokens: McpOAuthTokens,
  home = ravenclawHome(),
): void {
  const dir = join(home, MCP_OAUTH_DIR)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(mcpOAuthTokenPath(serverName, home), `${JSON.stringify(tokens, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export async function ensureMcpOAuthAccess(opts: {
  serverName: string
  oauth: McpOAuthConfig
  resourceUrl?: string
  home?: string
} & McpOAuthHooks): Promise<McpOAuthTokens> {
  const home = opts.home ?? ravenclawHome()
  const now = opts.now ?? Date.now
  const existing = loadMcpOAuthTokens(opts.serverName, home)
  if (existing && !isExpired(existing, now())) return existing
  if (existing?.refreshToken) {
    try {
      return await refreshMcpOAuth({ ...opts, home, refreshToken: existing.refreshToken })
    } catch {
      // fall through to interactive auth
    }
  }
  const interactive = opts.interactive ?? process.stdin.isTTY === true
  if (!interactive) throw authRequired()
  return authorizeMcpOAuth({ ...opts, home })
}

export async function authorizeMcpOAuth(opts: {
  serverName: string
  oauth: McpOAuthConfig
  resourceUrl?: string
  home?: string
} & McpOAuthHooks): Promise<McpOAuthTokens> {
  try {
    const home = opts.home ?? ravenclawHome()
    const fetchImpl = opts.fetchImpl ?? fetch
    const endpoints = await resolveEndpoints(opts.oauth, opts.resourceUrl, fetchImpl)
    const pkce = createPkcePair()
    const state = base64Url(randomBytes(16))
    const loopback = opts.listenOnce
      ? { port: opts.oauth.redirectPort ?? 1, wait: () => opts.listenOnce!(opts.oauth.redirectPort ?? 1, state) }
      : await startLoopback(opts.oauth.redirectPort ?? 0, state)
    const redirectUri = `http://127.0.0.1:${loopback.port}/callback`
    const url = new URL(endpoints.authorizationUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', opts.oauth.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', pkce.challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    if (opts.oauth.scope) url.searchParams.set('scope', opts.oauth.scope)
    await (opts.openBrowser ?? defaultOpenBrowser)(url.toString())
    const callback = await loopback.wait()
    if (callback.state !== undefined && callback.state !== state) throw authRequired()
    const tokens = await exchangeToken(fetchImpl, endpoints.tokenUrl, {
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: redirectUri,
      client_id: opts.oauth.clientId,
      code_verifier: pkce.verifier,
    }, opts.now)
    saveMcpOAuthTokens(opts.serverName, tokens, home)
    return tokens
  } catch (error) {
    if (isAuthRequired(error)) throw error
    throw authRequired()
  }
}

export async function refreshMcpOAuth(opts: {
  serverName: string
  oauth: McpOAuthConfig
  refreshToken: string
  resourceUrl?: string
  home?: string
  fetchImpl?: typeof fetch
  now?: () => number
}): Promise<McpOAuthTokens> {
  try {
    const home = opts.home ?? ravenclawHome()
    const fetchImpl = opts.fetchImpl ?? fetch
    const endpoints = await resolveEndpoints(opts.oauth, opts.resourceUrl, fetchImpl)
    const tokens = await exchangeToken(fetchImpl, endpoints.tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: opts.refreshToken,
      client_id: opts.oauth.clientId,
    }, opts.now)
    if (!tokens.refreshToken) tokens.refreshToken = opts.refreshToken
    saveMcpOAuthTokens(opts.serverName, tokens, home)
    return tokens
  } catch (error) {
    if (isAuthRequired(error)) throw error
    throw authRequired()
  }
}

function isExpired(tokens: McpOAuthTokens, now: number): boolean {
  if (tokens.expiresAt === undefined) return false
  return now >= tokens.expiresAt - 30_000
}

async function resolveEndpoints(
  oauth: McpOAuthConfig,
  resourceUrl: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ authorizationUrl: string; tokenUrl: string }> {
  if (oauth.authorizationUrl && oauth.tokenUrl) {
    return { authorizationUrl: oauth.authorizationUrl, tokenUrl: oauth.tokenUrl }
  }
  if (!resourceUrl) throw authRequired()
  let origin: string
  try {
    origin = new URL(resourceUrl).origin
  } catch {
    throw authRequired()
  }
  const res = await fetchImpl(`${origin}/.well-known/oauth-authorization-server`)
  if (!res.ok) throw authRequired()
  const raw = (await res.json()) as { authorization_endpoint?: unknown; token_endpoint?: unknown }
  const authorizationUrl =
    oauth.authorizationUrl ??
    (typeof raw.authorization_endpoint === 'string' ? raw.authorization_endpoint : undefined)
  const tokenUrl =
    oauth.tokenUrl ?? (typeof raw.token_endpoint === 'string' ? raw.token_endpoint : undefined)
  if (!authorizationUrl || !tokenUrl) throw authRequired()
  return { authorizationUrl, tokenUrl }
}

async function exchangeToken(
  fetchImpl: typeof fetch,
  tokenUrl: string,
  body: Record<string, string>,
  now: () => number = Date.now,
): Promise<McpOAuthTokens> {
  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  })
  if (!res.ok) throw authRequired()
  const raw = (await res.json()) as Record<string, unknown>
  const accessToken = typeof raw.access_token === 'string' ? raw.access_token : undefined
  if (!accessToken) throw authRequired()
  const tokens: McpOAuthTokens = { accessToken }
  if (typeof raw.refresh_token === 'string' && raw.refresh_token !== '') tokens.refreshToken = raw.refresh_token
  if (typeof raw.token_type === 'string') tokens.tokenType = raw.token_type
  if (typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in)) {
    tokens.expiresAt = now() + raw.expires_in * 1000
  }
  return tokens
}

function startLoopback(
  port: number,
  expectedState: string,
): Promise<{ port: number; wait: () => Promise<{ code: string; state?: string }> }> {
  return new Promise((resolveListen, rejectListen) => {
    let settled = false
    const wait = new Promise<{ code: string; state?: string }>((resolve, reject) => {
      const server = createServer((req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const code = url.searchParams.get('code')
          const state = url.searchParams.get('state') ?? undefined
          if (!code || (state !== undefined && state !== expectedState)) {
            res.writeHead(400, { 'content-type': 'text/plain' })
            res.end(MCP_AUTH_REQUIRED)
            return
          }
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('Authentication complete. You can close this window.')
          server.close()
          if (!settled) {
            settled = true
            resolve({ code, ...(state !== undefined ? { state } : {}) })
          }
        } catch {
          res.writeHead(400)
          res.end()
          server.close()
          if (!settled) {
            settled = true
            reject(authRequired())
          }
        }
      })
      const timer = setTimeout(() => {
        server.close()
        if (!settled) {
          settled = true
          reject(authRequired())
        }
      }, 120_000)
      server.once('error', () => {
        clearTimeout(timer)
        rejectListen(authRequired())
      })
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        const bound = address && typeof address === 'object' ? address.port : port
        resolveListen({
          port: bound,
          wait: () =>
            wait.finally(() => {
              clearTimeout(timer)
            }),
        })
      })
      server.unref?.()
    })
  })
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.unref()
    child.once('error', () => reject(authRequired()))
    child.once('spawn', () => resolve())
  })
}

function safeServerName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '')
  return cleaned.slice(0, 128) || 'server'
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function authRequired(): Error {
  return new Error(MCP_AUTH_REQUIRED)
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof Error && error.message === MCP_AUTH_REQUIRED
}
