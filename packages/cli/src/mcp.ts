import { spawn } from 'node:child_process'
import {
  createMcpToolBridge,
  createStdioMcpTransport,
  loadMcpTools,
  type McpServerConfig,
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

export interface LoadedMcpTools {
  tools: Tool[]
  close: () => Promise<void>
}

export function spawnMcpServer(
  server: Pick<McpServerConfig, 'command' | 'args' | 'env'>,
  spawnFn: McpSpawnFn = spawn as unknown as McpSpawnFn,
): McpChild {
  return spawnFn(server.command, server.args ?? [], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...server.env },
  })
}

export async function loadConfiguredMcpTools(
  servers: McpServerConfig[],
  opts?: { spawn?: McpSpawnFn },
): Promise<LoadedMcpTools> {
  const spawnFn = opts?.spawn ?? (spawn as unknown as McpSpawnFn)
  const tools: Tool[] = []
  const closers: Array<() => Promise<void>> = []

  for (const server of servers) {
    try {
      const loaded = await loadOneMcpServer(server, spawnFn)
      tools.push(...loaded.tools)
      closers.push(loaded.close)
    } catch {
      // fail-open: skip this server
    }
  }

  return {
    tools,
    async close() {
      for (const closer of closers) {
        try {
          await closer()
        } catch {
          // fail-open
        }
      }
    },
  }
}

async function loadOneMcpServer(
  server: McpServerConfig,
  spawnFn: McpSpawnFn,
): Promise<LoadedMcpTools> {
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
  const bridge = createMcpToolBridge(transport)
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
    const tools = await raceChildFailure(child, loadMcpTools(bridge))
    return { tools, close }
  } catch (error) {
    await close()
    throw error
  }
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
