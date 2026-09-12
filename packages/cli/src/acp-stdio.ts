import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_PARSE_ERROR,
  createAcpServer,
  isJsonRpcResponse,
  jsonRpcError,
  type AcpEngine,
  type AcpEngineFactoryOpts,
  type JsonRpcId,
  type JsonRpcRequest,
} from '@ravenclaw/acp'
import type { ConfigFlags, McpServerConfig, ResolvedConfig, UserSubmitInput } from '@ravenclaw/core'
import { bootCli, createAskBridge, openNewSession, resumeRuntime, type CliRuntimeBase } from './engine'

export type AcpStdioBoot = () => Promise<{
  engine?: AcpEngine
  create?: (sessionId: string, opts?: AcpEngineFactoryOpts) => Promise<AcpEngine>
  load?: (sessionId: string, opts?: AcpEngineFactoryOpts) => Promise<AcpEngine>
}>

export type RunAcpStdioOpts = {
  input?: AsyncIterable<string | Uint8Array>
  output?: { write(chunk: string): unknown }
  boot?: AcpStdioBoot
  flags?: ConfigFlags
}

export async function runAcpStdio(opts: RunAcpStdioOpts = {}): Promise<void> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const flags = opts.flags ?? {}
  const boot = opts.boot ?? (() => defaultBoot(flags))
  let booted: Awaited<ReturnType<AcpStdioBoot>> | undefined
  const once = async () => {
    booted ??= await boot()
    return booted
  }

  const writeLine = (value: unknown) => {
    output.write(`${JSON.stringify(value)}\n`)
  }

  const pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >()

  const request = (req: JsonRpcRequest): Promise<unknown> => {
    writeLine(req)
    return new Promise((resolve, reject) => {
      pending.set(req.id, { resolve, reject })
    })
  }

  const server = createAcpServer({
    engineFactory: (sessionId, factoryOpts) =>
      wrapBoot(
        once().then(async (runtime) => {
          if (runtime.create) return runtime.create(sessionId, factoryOpts)
          if (runtime.engine) return runtime.engine
          throw new Error('ACP boot did not provide create or engine')
        }),
      ),
    loadEngine: (sessionId, factoryOpts) =>
      wrapBoot(
        once().then(async (runtime) => {
          if (runtime.load) return runtime.load(sessionId, factoryOpts)
          throw new Error(`session not found: ${sessionId}`)
        }),
      ),
    notify: writeLine,
    request,
  })

  const tasks: Array<Promise<void>> = []
  for await (const line of readLines(input)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let msg: unknown
    try {
      msg = JSON.parse(trimmed) as unknown
    } catch {
      writeLine(jsonRpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error'))
      continue
    }
    if (isJsonRpcResponse(msg) && msg.id !== null) {
      const waiter = pending.get(msg.id)
      if (waiter) {
        pending.delete(msg.id)
        if ('error' in msg && msg.error) waiter.reject(msg.error)
        else waiter.resolve('result' in msg ? msg.result : undefined)
      }
      continue
    }
    const captured = msg
    tasks.push(
      server
        .handle(captured)
        .then((response) => {
          writeLine(response)
        })
        .catch((error: unknown) => {
          writeLine(
            jsonRpcError(
              requestId(captured),
              JSON_RPC_INTERNAL_ERROR,
              error instanceof Error ? error.message : String(error),
            ),
          )
        }),
    )
  }
  for (const waiter of pending.values()) waiter.reject(new Error('stdin closed'))
  pending.clear()
  await Promise.all(tasks)
}

async function* readLines(
  input: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<string> {
  let buf = ''
  for await (const chunk of input) {
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    let idx = buf.indexOf('\n')
    while (idx >= 0) {
      yield buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      idx = buf.indexOf('\n')
    }
  }
  if (buf.length > 0) yield buf
}

async function defaultBoot(flags: ConfigFlags): Promise<{
  create: (sessionId: string, opts?: AcpEngineFactoryOpts) => Promise<AcpEngine>
  load: (sessionId: string, opts?: AcpEngineFactoryOpts) => Promise<AcpEngine>
}> {
  const runtime = await bootCli({
    flags,
    createSession: false,
    surface: 'headless',
    lockHolder: 'acp',
  })
  return {
    create: async (sessionId, opts) => {
      const next = withAcpAsk(applyAcpSessionNew(runtime, opts), opts)
      return (await openNewSession(next, { sessionId })).engine
    },
    load: async (sessionId, opts) => {
      const next = withAcpAsk(runtime, opts)
      return (await resumeRuntime(next, sessionId)).engine
    },
  }
}

function withAcpAsk(runtime: CliRuntimeBase, opts?: AcpEngineFactoryOpts): CliRuntimeBase {
  const ask = createAskBridge()
  if (opts?.requestPermission) {
    ask.bind((event, signal) => opts.requestPermission!(event, signal))
  }
  return { ...runtime, ask }
}

export function applyAcpSessionNew(
  runtime: CliRuntimeBase,
  opts?: AcpEngineFactoryOpts,
): CliRuntimeBase {
  const cwd = typeof opts?.cwd === 'string' && opts.cwd !== '' ? opts.cwd : runtime.cwd
  const model =
    typeof opts?.model === 'string' && opts.model !== '' ? opts.model : runtime.config.model
  const extra = parseAcpMcpServers(opts?.mcpServers)
  const servers = overlayMcpServers(runtime.config.mcp?.servers ?? [], extra)
  const config: ResolvedConfig = {
    ...runtime.config,
    model,
    mcp: { ...runtime.config.mcp, servers },
  }
  return { ...runtime, cwd, config }
}

export function parseAcpMcpServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return []
  const out: McpServerConfig[] = []
  for (const item of raw) {
    const parsed = parseAcpMcpServer(item)
    if (parsed) out.push(parsed)
  }
  return out
}

function parseAcpMcpServer(item: unknown): McpServerConfig | undefined {
  if (!item || typeof item !== 'object') return undefined
  const rec = item as Record<string, unknown>
  const name = typeof rec.name === 'string' ? rec.name : undefined
  if (!name) return undefined
  const type =
    rec.type === 'http' || rec.type === 'sse' || rec.type === 'stdio' ? rec.type : undefined
  const command = typeof rec.command === 'string' ? rec.command : undefined
  const url = typeof rec.url === 'string' ? rec.url : undefined
  const kind = type ?? (url ? 'http' : 'stdio')
  if (kind === 'stdio' && (command === undefined || command === '')) return undefined
  if (kind !== 'stdio' && (url === undefined || url === '')) return undefined
  const server: McpServerConfig = { name }
  if (kind !== 'stdio') server.type = kind
  if (command !== undefined && command !== '') server.command = command
  if (url !== undefined && url !== '') server.url = url
  if (Array.isArray(rec.args)) {
    server.args = rec.args.filter((value): value is string => typeof value === 'string')
  }
  const env = parseNameValues(rec.env)
  if (env) server.env = env
  const headers = parseNameValues(rec.headers)
  if (headers) server.headers = headers
  return server
}

function parseNameValues(raw: unknown): Record<string, string> | undefined {
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {}
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const name = (item as { name?: unknown }).name
      const value = (item as { value?: unknown }).value
      if (typeof name === 'string' && name !== '' && typeof value === 'string') out[name] = value
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  if (raw && typeof raw === 'object') {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  return undefined
}

export function overlayMcpServers(
  base: McpServerConfig[],
  extra: McpServerConfig[],
): McpServerConfig[] {
  if (extra.length === 0) return base
  const byName = new Map(base.map((server) => [server.name, server]))
  for (const server of extra) byName.set(server.name, server)
  const out: McpServerConfig[] = []
  const seen = new Set<string>()
  for (const server of base) {
    out.push(byName.get(server.name) ?? server)
    seen.add(server.name)
  }
  for (const server of extra) {
    if (seen.has(server.name)) continue
    out.push(server)
    seen.add(server.name)
  }
  return out
}

function wrapBoot(booted: Promise<AcpEngine>): AcpEngine {
  const ready = booted
  void ready.catch(() => {})
  return {
    async *submitMessage(input: UserSubmitInput) {
      const engine = await ready
      return yield* engine.submitMessage(input)
    },
    abort() {
      void ready.then((engine) => engine.abort()).catch(() => {})
    },
  }
}

function requestId(message: unknown): JsonRpcId | null {
  if (!message || typeof message !== 'object') return null
  const id = (message as { id?: unknown }).id
  if (typeof id === 'string' || typeof id === 'number') return id
  return null
}
