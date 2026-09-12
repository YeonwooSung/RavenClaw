import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consumeJsonRpcFrames, encodeJsonRpcFrame } from '../mcp/client'
import { readPackageVersion } from '../package-version'

export type LspOperation = 'hover' | 'definition' | 'references'

export interface LspQueryRequest {
  operation: LspOperation
  path: string
  line: number
  character?: number
}

export interface LspServerConfig {
  command: string
  args?: string[]
  extensions: string[]
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
}

export interface LspClient {
  query(req: LspQueryRequest, cwd: string): Promise<string>
}

export const NO_SERVER_MESSAGE = 'LSP failed: no server configured for this file'
export const LSP_RESULT_CAP = 8_000

const REQUEST_TIMEOUT_MS = 8_000
const METHODS: Record<LspOperation, string> = {
  hover: 'textDocument/hover',
  definition: 'textDocument/definition',
  references: 'textDocument/references',
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
  const start = opts?.start ?? defaultStart
  return {
    async query(req, cwd) {
      const config = loadLspConfig(cwd)
      const server = config ? findServerForPath(config, req.path) : undefined
      if (!server) return NO_SERVER_MESSAGE
      if (opts?.query) return opts.query(req)
      try {
        return await queryWithHandshake(sessions, start, server, req, cwd)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'not available') return 'LSP failed: language server not available'
        return `LSP failed: ${message}`
      }
    },
  }
}

async function queryWithHandshake(
  sessions: Map<string, LspSession>,
  start: LspStartFn,
  server: LspServerConfig,
  req: LspQueryRequest,
  cwd: string,
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

  const session = await ensureSession(sessions, start, server, cwd)
  const uri = pathToFileURL(abs).href
  await syncDocument(session, uri, abs, text)
  const params = requestParams(req.operation, uri, req.line, req.character ?? 0)
  const result = await rpcRequest(session, METHODS[req.operation], params)
  return clipPayload(result)
}

async function ensureSession(
  sessions: Map<string, LspSession>,
  start: LspStartFn,
  server: LspServerConfig,
  cwd: string,
): Promise<LspSession> {
  const key = sessionKey(server, cwd)
  const existing = sessions.get(key)
  if (existing && !existing.dead) {
    try {
      await existing.ready
      if (!existing.dead) return existing
    } catch {
      existing.dead = true
      sessions.delete(key)
    }
  }
  const session = startSession(key, start, server, cwd)
  sessions.set(key, session)
  try {
    await session.ready
    if (session.dead) throw new Error('not available')
    return session
  } catch {
    session.dead = true
    sessions.delete(key)
    throw new Error('not available')
  }
}

function startSession(
  key: string,
  start: LspStartFn,
  server: LspServerConfig,
  cwd: string,
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
    return startSession(key, () => {
      throw new Error('not available')
    }, server, cwd)
  }

  let buffer = Buffer.alloc(0)
  const session: LspSession = {
    key,
    child,
    nextId: 1,
    pending: new Map(),
    docs: new Map(),
    dead: false,
    ready: Promise.resolve(),
  }

  const onData = (chunk: Buffer | string): void => {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    buffer = Buffer.concat([buffer, incoming])
    const parsed = consumeJsonRpcFrames(buffer)
    buffer = parsed.rest
    for (const message of parsed.messages) dispatchLspMessage(session, message)
  }
  child.stdout.on('data', onData)

  const die = (): void => {
    if (session.dead) return
    session.dead = true
    child.stdout?.off?.('data', onData)
    for (const waiter of session.pending.values()) {
      waiter.reject(new Error('not available'))
    }
    session.pending.clear()
  }
  child.on?.('error', die)
  child.on?.('exit', die)

  session.ready = (async () => {
    const rootUri = pathToFileURL(cwd).href
    await rpcRequest(session, 'initialize', {
      processId: null,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { didOpen: true, didChange: true },
          hover: {},
          definition: {},
          references: {},
        },
      },
      clientInfo: { name: 'ravenclaw', version: readPackageVersion(import.meta.url) },
    })
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

function rpcRequest(session: LspSession, method: string, params: unknown): Promise<unknown> {
  if (session.dead || !session.child.stdin) return Promise.reject(new Error('not available'))
  const id = session.nextId++
  const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method, params }
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id)
      reject(new Error('not available'))
    }, REQUEST_TIMEOUT_MS)
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
      session.dead = true
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
    session.dead = true
    return Promise.reject(error instanceof Error ? error : new Error('not available'))
  }
}

function dispatchLspMessage(session: LspSession, message: unknown): void {
  if (!message || typeof message !== 'object') return
  const rec = message as { id?: unknown; method?: unknown; result?: unknown; error?: unknown }
  if (typeof rec.method === 'string' && rec.id !== undefined && rec.id !== null) {
    try {
      session.child.stdin?.write(
        encodeJsonRpcFrame({ jsonrpc: '2.0', id: rec.id, result: null }),
      )
    } catch {
      // ignore reverse-RPC write failures
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

function sessionKey(server: LspServerConfig, cwd: string): string {
  return `${cwd}\0${server.command}\0${(server.args ?? []).join('\0')}`
}

function parseServer(value: unknown): LspServerConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const rec = value as { command?: unknown; args?: unknown; extensions?: unknown }
  if (typeof rec.command !== 'string' || rec.command.length === 0) return undefined
  if (!Array.isArray(rec.extensions) || rec.extensions.length === 0) return undefined
  const extensions = rec.extensions.filter((entry): entry is string => typeof entry === 'string')
  if (extensions.length === 0) return undefined
  const server: LspServerConfig = { command: rec.command, extensions }
  if (Array.isArray(rec.args) && rec.args.every((arg) => typeof arg === 'string')) {
    server.args = rec.args
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
