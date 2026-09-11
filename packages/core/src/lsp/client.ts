import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

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

export interface LspSpawnResult {
  ok: boolean
  stdout?: string
  stderr?: string
}

export type LspSpawnFn = (
  command: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<LspSpawnResult> | LspSpawnResult

export interface LspClientOpts {
  spawn?: LspSpawnFn
  query?: (req: LspQueryRequest) => Promise<string>
}

export interface LspClient {
  query(req: LspQueryRequest, cwd: string): Promise<string>
}

export const NO_SERVER_MESSAGE = 'LSP failed: no server configured for this file'

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
  const spawn = opts?.spawn ?? defaultSpawn
  return {
    async query(req, cwd) {
      const config = loadLspConfig(cwd)
      const server = config ? findServerForPath(config, req.path) : undefined
      if (!server) return NO_SERVER_MESSAGE
      if (opts?.query) return opts.query(req)

      // Probe only — no LSP handshake or protocol messages.
      let probe: LspSpawnResult
      try {
        probe = await spawn(server.command, ['--version'], { cwd })
      } catch (error) {
        return `LSP failed: ${error instanceof Error ? error.message : String(error)}`
      }
      if (!probe.ok) return 'LSP failed: language server not available'
      const col = req.character ?? 0
      return `${req.operation} ${req.path}:${req.line}:${col}`
    },
  }
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

function defaultSpawn(command: string, args: string[], opts?: { cwd?: string }): LspSpawnResult {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 3000,
      cwd: opts?.cwd,
    })
    const out: LspSpawnResult = { ok: result.status === 0 }
    if (result.stdout) out.stdout = result.stdout
    if (result.stderr) out.stderr = result.stderr
    return out
  } catch {
    return { ok: false }
  }
}
