import { spawn } from 'node:child_process'
import {
  createHttpMcpTransport,
  createMcpResourceTools,
  createMcpToolBridge,
  createStdioMcpTransport,
  ensureMcpOAuthAccess,
  loadMcpOAuthTokens,
  loadMcpTools,
  ravenclawHome,
  refreshMcpOAuth,
  type McpElicitFn,
  type McpServerConfig,
  type McpToolBridge,
  type Tool,
} from '@ravenclaw/core'

export interface McpChild {
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

export type McpSpawnFn = (
  command: string,
  args: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'ignore']; env: NodeJS.ProcessEnv },
) => McpChild

export interface McpLoadError {
  name: string
  message: string
}

export type McpSlotState = 'connecting' | 'ready' | 'dead'

export interface McpServerSlot {
  name: string
  state: McpSlotState
}

export interface LoadedMcpTools {
  tools: Tool[]
  close: () => Promise<void>
  bridge?: McpToolBridge
  errors: McpLoadError[]
  refresh: () => Promise<Tool[]>
  slots: () => McpServerSlot[]
}

interface InternalMcpSlot {
  server: McpServerConfig
  state: McpSlotState
  tools: Tool[]
  bridge?: McpToolBridge
  close?: () => Promise<void>
  error?: string
  inflight?: Promise<void>
}

export function spawnMcpServer(
  server: Pick<McpServerConfig, 'command' | 'args' | 'env'>,
  spawnFn: McpSpawnFn = spawn as unknown as McpSpawnFn,
): McpChild {
  if (!server.command) throw new Error('mcp stdio missing command')
  return spawnFn(server.command, server.args ?? [], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...server.env },
  })
}

const MCP_REFRESH_WAIT_MS = 2_500
const MCP_CLOSE_WAIT_MS = 500

function boundConnect(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    work.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        resolve()
      },
    )
  })
}

export async function loadConfiguredMcpTools(
  servers: McpServerConfig[],
  opts?: { spawn?: McpSpawnFn; elicit?: McpElicitFn },
): Promise<LoadedMcpTools> {
  const spawnFn = opts?.spawn ?? (spawn as unknown as McpSpawnFn)
  const elicit = opts?.elicit
  const slots: InternalMcpSlot[] = servers.map((server) => ({
    server,
    state: 'connecting',
    tools: [],
  }))
  await Promise.all(slots.map((slot) => connectSlot(slot, spawnFn, elicit)))
  const snapshot = collectMcpSnapshot(slots)
  const pool: LoadedMcpTools = {
    tools: snapshot.tools,
    errors: snapshot.errors,
    bridge: snapshot.bridge,
    slots() {
      return slots.map((slot) => ({ name: slot.server.name, state: slot.state }))
    },
    async refresh() {
      const before = new Set(pool.tools.map((tool) => tool.name))
      const retry = slots.filter((slot) => slot.state === 'dead' || slot.state === 'connecting')
      if (retry.length > 0) {
        try {
          await Promise.all(
            retry.map((slot) => boundConnect(connectSlot(slot, spawnFn, elicit), MCP_REFRESH_WAIT_MS)),
          )
        } catch {
          // one dead server must not abort the session
        }
      }
      const next = collectMcpSnapshot(slots)
      pool.tools = next.tools
      pool.errors = next.errors
      pool.bridge = next.bridge
      return next.tools.filter((tool) => !before.has(tool.name))
    },
    async close() {
      await Promise.all(
        slots.map(async (slot) => {
          if (slot.inflight) {
            try {
              await boundConnect(slot.inflight, MCP_CLOSE_WAIT_MS)
            } catch {
              // still connecting
            }
          }
          if (!slot.close) return
          try {
            await slot.close()
          } catch {
            // fail-open
          }
        }),
      )
    },
  }
  return pool
}

async function connectSlot(
  slot: InternalMcpSlot,
  spawnFn: McpSpawnFn,
  elicit?: McpElicitFn,
): Promise<void> {
  if (slot.inflight) return slot.inflight
  slot.state = 'connecting'
  slot.inflight = (async () => {
    const previousClose = slot.close
    try {
      const loaded = await loadOneMcpServer(slot.server, spawnFn, elicit)
      if (previousClose) {
        try {
          await previousClose()
        } catch {
          // replaced
        }
      }
      slot.tools = loaded.tools
      slot.bridge = loaded.bridge
      slot.close = loaded.close
      slot.error = undefined
      slot.state = 'ready'
    } catch (error) {
      slot.state = 'dead'
      slot.error = errorMessage(error)
      slot.tools = []
      slot.bridge = undefined
      slot.close = previousClose
    } finally {
      slot.inflight = undefined
    }
  })()
  return slot.inflight
}

function collectMcpSnapshot(slots: InternalMcpSlot[]): {
  tools: Tool[]
  errors: McpLoadError[]
  bridge?: McpToolBridge
} {
  const tools: Tool[] = []
  const errors: McpLoadError[] = []
  const hosts: Array<{ name: string; bridge: McpToolBridge }> = []
  for (const slot of slots) {
    if (slot.state === 'ready') {
      tools.push(...slot.tools)
      if (slot.bridge) hosts.push({ name: slot.server.name, bridge: slot.bridge })
    } else if (slot.state === 'dead' && slot.error !== undefined) {
      errors.push({ name: slot.server.name, message: slot.error })
    }
  }
  if (hosts.length > 0) tools.push(...createMcpResourceTools(hosts))
  return {
    tools,
    errors,
    ...(hosts[0] !== undefined ? { bridge: hosts[0].bridge } : {}),
  }
}

interface ConnectedMcpServer {
  tools: Tool[]
  close: () => Promise<void>
  bridge?: McpToolBridge
}

async function loadOneMcpServer(
  server: McpServerConfig,
  spawnFn: McpSpawnFn,
  elicit?: McpElicitFn,
): Promise<ConnectedMcpServer> {
  if (server.type === 'http' || server.type === 'sse' || (server.url && !server.command)) {
    return loadHttpMcpServer(server, elicit)
  }
  return loadStdioMcpServer(server, spawnFn, elicit)
}

async function loadHttpMcpServer(
  server: McpServerConfig,
  elicit?: McpElicitFn,
): Promise<ConnectedMcpServer> {
  if (!server.url) throw new Error('mcp http missing url')
  const transport = createHttpMcpTransport({
    url: server.url,
    ...(server.headers !== undefined ? { headers: server.headers } : {}),
    ...(server.type === 'sse' ? { mode: 'sse' as const } : { mode: 'http' as const }),
    ...(server.oauth !== undefined
      ? {
          oauth: {
            async getAccessToken() {
              const tokens = await ensureMcpOAuthAccess({
                serverName: server.name,
                oauth: server.oauth!,
                resourceUrl: server.url,
                home: ravenclawHome(),
              })
              return tokens.accessToken
            },
            async refreshAccessToken() {
              const existing = loadMcpOAuthTokens(server.name, ravenclawHome())
              if (!existing?.refreshToken) return undefined
              const tokens = await refreshMcpOAuth({
                serverName: server.name,
                oauth: server.oauth!,
                refreshToken: existing.refreshToken,
                resourceUrl: server.url,
                home: ravenclawHome(),
              })
              return tokens.accessToken
            },
          },
        }
      : {}),
  })
  const bridge = createMcpToolBridge(transport, elicit !== undefined ? { elicit } : undefined)
  const close = async () => {
    try {
      await bridge.close()
    } catch {
      // fail-open
    }
  }
  try {
    const tools = await loadMcpTools(bridge, mcpToolFilter(server))
    return { tools, close, bridge, errors: [] }
  } catch (error) {
    await close()
    throw error
  }
}

async function loadStdioMcpServer(
  server: McpServerConfig,
  spawnFn: McpSpawnFn,
  elicit?: McpElicitFn,
): Promise<ConnectedMcpServer> {
  const child = spawnMcpServer(server, spawnFn)
  if (!child.stdin || !child.stdout) {
    try {
      child.kill?.()
    } catch {
      // fail-open
    }
    throw new Error('mcp stdio missing')
  }

  const transport = createStdioMcpTransport({
    stdin: child.stdin,
    stdout: child.stdout,
  })
  const bridge = createMcpToolBridge(transport, elicit !== undefined ? { elicit } : undefined)
  const close = async () => {
    try {
      await bridge.close()
    } catch {
      // fail-open
    }
    try {
      child.kill?.()
    } catch {
      // fail-open
    }
  }

  try {
    const tools = await raceChildFailure(child, loadMcpTools(bridge, mcpToolFilter(server)))
    return { tools, close, bridge, errors: [] }
  } catch (error) {
    await close()
    throw error
  }
}

function mcpToolFilter(server: McpServerConfig): { tools?: string[]; excludeTools?: string[] } {
  const filter: { tools?: string[]; excludeTools?: string[] } = {}
  if (server.tools !== undefined) filter.tools = server.tools
  if (server.excludeTools !== undefined) filter.excludeTools = server.excludeTools
  return filter
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function raceChildFailure<T>(child: McpChild, work: Promise<T>): Promise<T> {
  if (!child.on) return work
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      child.off?.('error', onError)
      child.off?.('exit', onExit)
      fn()
    }
    const onError = (err: unknown) => {
      finish(() => {
        reject(err instanceof Error ? err : new Error('mcp spawn error'))
      })
    }
    const onExit = () => {
      finish(() => {
        reject(new Error('mcp server exited'))
      })
    }
    child.on('error', onError)
    child.on('exit', onExit)
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}
