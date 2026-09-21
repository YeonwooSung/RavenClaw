import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeJsonRpcFrame } from '../mcp/client'
import { readPackageVersion } from '../package-version'

export type LspOperation = 'hover' | 'definition' | 'references'

export interface LspQueryRequest {
  operation: LspOperation
  path: string
  line: number
  character?: number
}

export const LSP_MAX_FRAME_BYTES = 256 * 1024
const INITIALIZE_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 8_000

export type LspQueryRoots = { workspaceCwd: string; configCwd: string }

export interface LspServerConfig {
  command: string
  args?: string[]
  extensions: string[]
  initializationOptions?: unknown
}

export interface LspConfig {
  servers: LspServerConfig[]
}

export interface LspChild {
  stdin: {
    write(chunk: string | Uint8Array): unknown
    end?: () => void
  } | null
  stdout: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
    off?(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  } | null
  kill?: (signal?: NodeJS.Signals) => boolean
  on?(event: 'error' | 'exit', listener: (...args: unknown[]) => void): unknown
  off?(event: 'error' | 'exit', listener: (...args: unknown[]) => void): unknown
}

export type LspStartFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => LspChild

export interface LspClientOpts {
  start?: LspStartFn
  query?: (req: LspQueryRequest) => Promise<string>
  initializeTimeoutMs?: number
  queryTimeoutMs?: number
  diagnosticDrainMs?: number
}

export interface LspClient {
  query(req: LspQueryRequest, cwdOrRoots: string | LspQueryRoots): Promise<string>
}

export const NO_SERVER_MESSAGE = 'LSP failed: no server configured for this file'
export const LSP_RESULT_CAP = 8_000

const METHODS: Record<LspOperation, string> = {
  hover: 'textDocument/hover',
  definition: 'textDocument/definition',
  references: 'textDocument/references',
}

const PROVIDER_KEY: Record<string, string> = {
  hover: 'hoverProvider',
  definition: 'definitionProvider',
  references: 'referencesProvider',
  implementation: 'implementationProvider',
  typeDefinition: 'typeDefinitionProvider',
}

const LANGUAGE_IDS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.json': 'json',
  '.md': 'markdown',
  '.css': 'css',
  '.html': 'html',
}

interface DocState {
  version: number
  text: string
}

interface LspSession {
  key: string
  child: LspChild
  nextId: number
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
  docs: Map<string, DocState>
  dead: boolean
  ready: Promise<void>
  capabilities?: Record<string, unknown>
  workspaceFolders: Array<{ uri: string; name: string }>
  diagnostics: Map<string, unknown[]>
}

interface HandshakeTimeouts {
  initializeTimeoutMs: number
  queryTimeoutMs: number
}

function providerExplicitFalse(caps: Record<string, unknown> | undefined, operation: string): boolean {
  const key = PROVIDER_KEY[operation]
  if (!key || !caps) return false
  return caps[key] === false
}

export function lspConfigPath(cwd: string): string {
  return join(cwd, '.ravenclaw', 'lsp.json')
}

export function loadLspConfig(cwd: string): LspConfig | undefined {
  const path = lspConfigPath(cwd)
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const servers = (raw as { servers?: unknown }).servers
  if (!Array.isArray(servers)) return undefined
  const parsed: LspServerConfig[] = []
  for (const server of servers) {
    const next = parseServer(server)
    if (next) parsed.push(next)
  }
  if (parsed.length === 0) return undefined
  return { servers: parsed }
}

export function findServerForPath(config: LspConfig, filePath: string): LspServerConfig | undefined {
  const ext = extname(filePath).toLowerCase()
  return config.servers.find((server) =>
    server.extensions.some((entry) => entry.toLowerCase() === ext),
  )
}

export function createLspClient(opts?: LspClientOpts): LspClient {
  const sessions = new Map<string, LspSession>()
  const starting = new Map<string, Promise<LspSession>>()
  const start = opts?.start ?? defaultStart
  const timeouts: HandshakeTimeouts = {
    initializeTimeoutMs: opts?.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS,
    queryTimeoutMs: opts?.queryTimeoutMs ?? REQUEST_TIMEOUT_MS,
  }
  return {
    async query(req, cwdOrRoots) {
      const roots =
        typeof cwdOrRoots === 'string'
          ? { workspaceCwd: cwdOrRoots, configCwd: cwdOrRoots }
          : cwdOrRoots
      const config = loadLspConfig(roots.configCwd)
      const server = config ? findServerForPath(config, req.path) : undefined
      if (!server) return NO_SERVER_MESSAGE
      if (opts?.query) return opts.query(req)
      try {
        return await queryWithHandshake(
          sessions,
          starting,
          start,
          server,
          req,
          roots.workspaceCwd,
          timeouts,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'not available') return 'LSP failed: language server not available'
        if (message === 'timed out') return 'LSP failed: timed out'
        if (message.startsWith('server does not support ')) return `LSP failed: ${message}`
        return `LSP failed: ${message}`
      }
    },
  }
}

async function queryWithHandshake(
  sessions: Map<string, LspSession>,
  starting: Map<string, Promise<LspSession>>,
  start: LspStartFn,
  server: LspServerConfig,
  req: LspQueryRequest,
  cwd: string,
  timeouts: HandshakeTimeouts,
): Promise<string> {
  const abs = resolveInWorkspace(cwd, req.path)
  if (abs === undefined) return 'LSP failed: cannot read file'
  let text: string
  try {
    const stat = statSync(abs)
    if (!stat.isFile()) return 'LSP failed: cannot read file'
    text = readFileSync(abs, 'utf8')
  } catch {
    return 'LSP failed: cannot read file'
  }

  const session = await ensureSession(sessions, starting, start, server, cwd, timeouts)
  const uri = pathToFileURL(abs).href
  await syncDocument(session, uri, abs, text)
  if (providerExplicitFalse(session.capabilities, req.operation)) {
    return `LSP failed: server does not support ${req.operation}`
  }
  const params = requestParams(req.operation, uri, req.line, req.character ?? 0)
  const result = await rpcRequest(session, METHODS[req.operation], params, timeouts.queryTimeoutMs)
  return clipPayload(result)
}

async function ensureSession(
  sessions: Map<string, LspSession>,
  starting: Map<string, Promise<LspSession>>,
  start: LspStartFn,
  server: LspServerConfig,
  cwd: string,
  timeouts: HandshakeTimeouts,
): Promise<LspSession> {
  const key = sessionKey(server, cwd)
  const inflight = starting.get(key)
  if (inflight) return inflight
  const work = openSession(sessions, start, server, cwd, key, timeouts)
  starting.set(key, work)
  try {
    return await work
  } finally {
    if (starting.get(key) === work) starting.delete(key)
  }
}

async function openSession(
  sessions: Map<string, LspSession>,
  start: LspStartFn,
  server: LspServerConfig,
  cwd: string,
  key: string,
  timeouts: HandshakeTimeouts,
): Promise<LspSession> {
  const existing = sessions.get(key)
  if (existing && !existing.dead) {
    try {
      await existing.ready
      if (!existing.dead) return existing
    } catch (error) {
      dropSession(existing)
      sessions.delete(key)
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'timed out') throw new Error('timed out')
    }
  } else if (existing?.dead) {
    dropSession(existing)
    sessions.delete(key)
  }
  const session = startSession(key, start, server, cwd, timeouts)
  sessions.set(key, session)
  try {
    await session.ready
    if (session.dead) throw new Error('not available')
    return session
  } catch (error) {
    dropSession(session)
    sessions.delete(key)
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'timed out') throw new Error('timed out')
    throw new Error('not available')
  }
}

function startSession(
  key: string,
  start: LspStartFn,
  server: LspServerConfig,
  cwd: string,
  timeouts: HandshakeTimeouts,
): LspSession {
  let child: LspChild
  try {
    child = start(server.command, server.args ?? [], { cwd })
  } catch {
    const failed: LspSession = {
      key,
      child: { stdin: null, stdout: null },
      nextId: 1,
      pending: new Map(),
      docs: new Map(),
      dead: true,
      ready: Promise.reject(new Error('not available')),
      workspaceFolders: [],
      diagnostics: new Map(),
    }
    failed.ready = failed.ready.catch(() => undefined).then(() => {
      throw new Error('not available')
    })
    return failed
  }
  if (!child.stdin || !child.stdout) {
    try {
      child.kill?.()
    } catch {
      // fail-open
    }
    return startSession(
      key,
      () => {
        throw new Error('not available')
      },
      server,
      cwd,
      timeouts,
    )
  }

  let buffer = Buffer.alloc(0)
  let skipRemaining = 0
  const session: LspSession = {
    key,
    child,
    nextId: 1,
    pending: new Map(),
    docs: new Map(),
    dead: false,
    ready: Promise.resolve(),
    workspaceFolders: [],
    diagnostics: new Map(),
  }

  const onData = (chunk: Buffer | string): void => {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    buffer = Buffer.concat([buffer, incoming])
    if (skipRemaining > 0) {
      const drop = Math.min(skipRemaining, buffer.length)
      skipRemaining -= drop
      buffer = buffer.subarray(drop)
      if (buffer.length === 0) return
    }
    const parsed = consumeLspFrames(buffer)
    buffer = parsed.rest
    if (parsed.skipRemaining) skipRemaining = parsed.skipRemaining
    for (const message of parsed.messages) dispatchLspMessage(session, message)
  }
  child.stdout.on('data', onData)

  const die = (): void => {
    dropSession(session, { kill: true, onData })
  }
  child.on?.('error', die)
  child.on?.('exit', die)

  session.ready = (async () => {
    const rootUri = pathToFileURL(cwd).href
    const workspaceFolders = [{ uri: rootUri, name: basename(cwd) }]
    session.workspaceFolders = workspaceFolders
    const result = await rpcRequest(
      session,
      'initialize',
      {
        processId: process.pid,
        rootUri,
        workspaceFolders,
        capabilities: {
          workspace: { workspaceFolders: { supported: true } },
          textDocument: {
            synchronization: { didOpen: true, didChange: true },
            hover: {},
            definition: {},
            references: {},
            implementation: {},
            typeDefinition: {},
            publishDiagnostics: {},
            diagnostic: {},
          },
        },
        clientInfo: { name: 'ravenclaw', version: readPackageVersion(import.meta.url) },
        ...(server.initializationOptions !== undefined
          ? { initializationOptions: server.initializationOptions }
          : {}),
      },
      timeouts.initializeTimeoutMs,
    )
    session.capabilities =
      result && typeof result === 'object'
        ? ((result as { capabilities?: Record<string, unknown> }).capabilities ?? {})
        : {}
    await rpcNotify(session, 'initialized', {})
  })()

  return session
}

async function syncDocument(session: LspSession, uri: string, abs: string, text: string): Promise<void> {
  const prev = session.docs.get(uri)
  if (!prev) {
    session.docs.set(uri, { version: 1, text })
    await rpcNotify(session, 'textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: languageIdFor(abs),
        version: 1,
        text,
      },
    })
    return
  }
  if (prev.text === text) return
  const version = prev.version + 1
  session.docs.set(uri, { version, text })
  await rpcNotify(session, 'textDocument/didChange', {
    textDocument: { uri, version },
    contentChanges: [{ text }],
  })
}

function requestParams(
  operation: LspOperation,
  uri: string,
  line: number,
  character: number,
): Record<string, unknown> {
  const position = { line, character }
  const textDocument = { uri }
  if (operation === 'references') {
    return { textDocument, position, context: { includeDeclaration: true } }
  }
  return { textDocument, position }
}

function rpcRequest(
  session: LspSession,
  method: string,
  params: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  if (session.dead || !session.child.stdin) return Promise.reject(new Error('not available'))
  const id = session.nextId++
  const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method, params }
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id)
      reject(new Error('timed out'))
    }, timeoutMs)
    session.pending.set(id, {
      resolve(value) {
        clearTimeout(timer)
        resolve(value)
      },
      reject(error) {
        clearTimeout(timer)
        reject(error)
      },
    })
    try {
      session.child.stdin!.write(encodeJsonRpcFrame(payload))
    } catch (error) {
      session.pending.delete(id)
      clearTimeout(timer)
      dropSession(session, { skipShutdown: true })
      reject(error instanceof Error ? error : new Error('not available'))
    }
  })
}

function rpcNotify(session: LspSession, method: string, params: unknown): Promise<void> {
  if (session.dead || !session.child.stdin) return Promise.reject(new Error('not available'))
  const payload: Record<string, unknown> = { jsonrpc: '2.0', method, params }
  try {
    session.child.stdin.write(encodeJsonRpcFrame(payload))
    return Promise.resolve()
  } catch (error) {
    dropSession(session, { skipShutdown: true })
    return Promise.reject(error instanceof Error ? error : new Error('not available'))
  }
}

function dispatchLspMessage(session: LspSession, message: unknown): void {
  if (!message || typeof message !== 'object') return
  const rec = message as {
    id?: unknown
    method?: unknown
    result?: unknown
    error?: unknown
    params?: unknown
  }
  if (typeof rec.method === 'string' && rec.id !== undefined && rec.id !== null) {
    try {
      session.child.stdin?.write(
        encodeJsonRpcFrame({ jsonrpc: '2.0', id: rec.id, result: reverseRpcResult(session, rec.method, rec.params) }),
      )
    } catch {
      // ignore reverse-RPC write failures
    }
    return
  }
  if (typeof rec.method === 'string') {
    if (rec.method === 'textDocument/publishDiagnostics') {
      const params = rec.params as { uri?: unknown; diagnostics?: unknown } | undefined
      if (params && typeof params.uri === 'string') {
        const items = Array.isArray(params.diagnostics) ? params.diagnostics.slice(0, 20) : []
        session.diagnostics.set(params.uri, items)
      }
    }
    return
  }
  if (typeof rec.id !== 'number') return
  const waiter = session.pending.get(rec.id)
  if (!waiter) return
  session.pending.delete(rec.id)
  if (rec.error !== undefined && rec.error !== null) {
    waiter.reject(new Error(jsonRpcErrorMessage(rec.error)))
    return
  }
  waiter.resolve(rec.result)
}

function reverseRpcResult(session: LspSession, method: string, params: unknown): unknown {
  if (method === 'workspace/workspaceFolders') return session.workspaceFolders
  if (method === 'workspace/configuration') {
    const items = params && typeof params === 'object' ? (params as { items?: unknown }).items : undefined
    return Array.isArray(items) ? items.map(() => ({})) : []
  }
  if (method === 'window/workDoneProgress/create') return null
  if (method === 'workspace/applyEdit') return { applied: false }
  return null
}

function jsonRpcErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return 'not available'
}

function clipPayload(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (text.length <= LSP_RESULT_CAP) return text
  return `${text.slice(0, LSP_RESULT_CAP)}\n... [truncated]`
}

export function resolveInWorkspace(cwd: string, userPath: string): string | undefined {
  try {
    const root = realpathSync(cwd)
    const abs = isAbsolute(userPath) ? userPath : join(cwd, userPath)
    const target = realpathSync(abs)
    if (target === root || target.startsWith(root + sep)) return target
    return undefined
  } catch {
    return undefined
  }
}

function languageIdFor(path: string): string {
  return LANGUAGE_IDS[extname(path).toLowerCase()] ?? 'plaintext'
}

function consumeLspFrames(buf: Buffer): { messages: unknown[]; rest: Buffer; skipRemaining?: number } {
  const messages: unknown[] = []
  let offset = 0
  while (offset < buf.length) {
    const sep = findHeaderSeparator(buf, offset)
    if (!sep) break
    const header = buf.subarray(offset, sep.index).toString('utf8')
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    if (!match?.[1]) {
      offset = sep.index + sep.length
      continue
    }
    const length = Number(match[1])
    const bodyStart = sep.index + sep.length
    if (length > LSP_MAX_FRAME_BYTES) {
      const bodyEnd = bodyStart + length
      if (buf.length < bodyEnd) {
        return { messages, rest: Buffer.alloc(0), skipRemaining: bodyEnd - buf.length }
      }
      offset = bodyEnd
      continue
    }
    if (buf.length < bodyStart + length) break
    const body = buf.subarray(bodyStart, bodyStart + length).toString('utf8')
    messages.push(JSON.parse(body))
    offset = bodyStart + length
  }
  return { messages, rest: buf.subarray(offset) }
}

function findHeaderSeparator(
  buf: Buffer,
  offset: number,
): { index: number; length: number } | undefined {
  const crlf = buf.indexOf('\r\n\r\n', offset)
  const lf = buf.indexOf('\n\n', offset)
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, length: 4 }
  if (lf >= 0) return { index: lf, length: 2 }
  return undefined
}

function dropSession(
  session: LspSession,
  opts?: { kill?: boolean; onData?: (chunk: Buffer | string) => void; skipShutdown?: boolean },
): void {
  if (!session.dead) {
    session.dead = true
    if (opts?.onData) session.child.stdout?.off?.('data', opts.onData)
    for (const waiter of session.pending.values()) {
      waiter.reject(new Error('not available'))
    }
    session.pending.clear()
    if (!opts?.skipShutdown) {
      try {
        session.child.stdin?.write(
          encodeJsonRpcFrame({ jsonrpc: '2.0', id: session.nextId++, method: 'shutdown', params: null }),
        )
        session.child.stdin?.write(encodeJsonRpcFrame({ jsonrpc: '2.0', method: 'exit' }))
      } catch {
        // swallow write errors
      }
    }
  }
  try {
    session.child.kill?.()
  } catch {
    // already gone
  }
}

function sessionKey(server: LspServerConfig, cwd: string): string {
  return `${cwd}\0${server.command}\0${(server.args ?? []).join('\0')}`
}

function parseServer(value: unknown): LspServerConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const rec = value as {
    command?: unknown
    args?: unknown
    extensions?: unknown
    initializationOptions?: unknown
  }
  if (typeof rec.command !== 'string' || rec.command.length === 0) return undefined
  if (!Array.isArray(rec.extensions) || rec.extensions.length === 0) return undefined
  const extensions = rec.extensions.filter((entry): entry is string => typeof entry === 'string')
  if (extensions.length === 0) return undefined
  const server: LspServerConfig = { command: rec.command, extensions }
  if (Array.isArray(rec.args) && rec.args.every((arg) => typeof arg === 'string')) {
    server.args = rec.args
  }
  if (
    rec.initializationOptions !== null &&
    typeof rec.initializationOptions === 'object' &&
    !Array.isArray(rec.initializationOptions)
  ) {
    server.initializationOptions = rec.initializationOptions
  }
  return server
}

function defaultStart(command: string, args: readonly string[], opts: { cwd: string }): LspChild {
  const child = spawn(command, [...args], {
    stdio: ['pipe', 'pipe', 'ignore'],
    cwd: opts.cwd,
  })
  if (!child.stdin || !child.stdout) {
    try {
      child.kill()
    } catch {
      // fail-open
    }
    throw new Error('not available')
  }
  return child
}
