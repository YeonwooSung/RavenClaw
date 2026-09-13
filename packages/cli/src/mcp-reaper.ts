import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export const MCP_REAP_GRACE_MS = 3_000
export const MCP_REAPER_FLAG = '--mcp-reaper'

export type ReaperOp = { op: 'add' | 'del'; pgid: number }

export interface McpReaper {
  register(pgid: number): void
  unregister(pgid: number): void
  close(): void
}

export interface ReaperSink {
  write(line: string): void
  end(): void
}

export function encodeReaperOp(op: ReaperOp): string {
  return `${JSON.stringify(op)}\n`
}

export function parseReaperOp(line: string): ReaperOp | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  try {
    const rec = JSON.parse(trimmed) as { op?: unknown; pgid?: unknown }
    if (rec.op !== 'add' && rec.op !== 'del') return undefined
    if (!Number.isInteger(rec.pgid) || (rec.pgid as number) <= 0) return undefined
    return { op: rec.op, pgid: rec.pgid as number }
  } catch {
    return undefined
  }
}

export function killProcessGroup(
  pgid: number,
  signal: NodeJS.Signals,
  killFn: (pid: number, signal: NodeJS.Signals) => void = (pid, sig) => process.kill(pid, sig),
): void {
  const target = process.platform === 'win32' ? pgid : -pgid
  try {
    killFn(target, signal)
  } catch {
    try {
      killFn(pgid, signal)
    } catch {
      // already gone
    }
  }
}

export async function reapProcessGroups(
  pgids: Iterable<number>,
  opts?: {
    kill?: (pid: number, signal: NodeJS.Signals) => void
    sleep?: (ms: number) => Promise<void>
    graceMs?: number
  },
): Promise<void> {
  const list = [...new Set(pgids)].filter((pgid) => Number.isInteger(pgid) && pgid > 0)
  if (list.length === 0) return
  const kill = opts?.kill
  const sleep = opts?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  for (const pgid of list) killProcessGroup(pgid, 'SIGTERM', kill)
  await sleep(opts?.graceMs ?? MCP_REAP_GRACE_MS)
  for (const pgid of list) killProcessGroup(pgid, 'SIGKILL', kill)
}

export async function runReaperFromStdin(
  input: NodeJS.ReadableStream = process.stdin,
  opts?: Parameters<typeof reapProcessGroups>[1],
): Promise<void> {
  const pgids = new Set<number>()
  const rl = createInterface({ input })
  for await (const line of rl) {
    const op = parseReaperOp(line)
    if (op?.op === 'add') pgids.add(op.pgid)
    if (op?.op === 'del') pgids.delete(op.pgid)
  }
  await reapProcessGroups(pgids, opts)
}

export function createMcpReaper(opts?: { start?: () => ReaperSink }): McpReaper {
  let sink: ReaperSink | undefined
  const ensure = (): ReaperSink => {
    if (!sink) sink = (opts?.start ?? startDefaultSupervisor)()
    return sink
  }
  return {
    register(pgid) {
      if (!Number.isInteger(pgid) || pgid <= 0) return
      try {
        ensure().write(encodeReaperOp({ op: 'add', pgid }))
      } catch {
        // fail-open
      }
    },
    unregister(pgid) {
      if (!sink || !Number.isInteger(pgid) || pgid <= 0) return
      try {
        sink.write(encodeReaperOp({ op: 'del', pgid }))
      } catch {
        // fail-open
      }
    },
    close() {
      try {
        sink?.end()
      } catch {
        // fail-open
      }
      sink = undefined
    },
  }
}

function startDefaultSupervisor(): ReaperSink {
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), MCP_REAPER_FLAG], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    })
    child.unref()
    child.stdin?.on('error', () => undefined)
    return {
      write(line) {
        child.stdin?.write(line)
      },
      end() {
        child.stdin?.end()
      },
    }
  } catch {
    return { write() {}, end() {} }
  }
}

if (process.argv.includes(MCP_REAPER_FLAG)) {
  void runReaperFromStdin().finally(() => {
    process.exit(0)
  })
}
