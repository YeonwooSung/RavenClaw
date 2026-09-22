import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { sep } from 'node:path'
import { resolveExisting } from '../permissions/modes'
import {
  buildMkdirScript,
  buildReadFileBufferScript,
  buildReaddirScript,
  buildStatScript,
  buildUnlinkScript,
  buildWriteFileScript,
  execSandboxFs,
  FS_MISSING,
  isAbortError,
} from './sandbox-fs'
import type { TerminalBackend, TerminalExecResult } from './terminal-backend'

export type WorkspaceFs = {
  readFile(path: string): Promise<string>
  readFileBuffer(path: string): Promise<Buffer>
  writeFile(path: string, content: string): Promise<void>
  mkdir(path: string): Promise<void>
  unlink(path: string): Promise<void>
  stat(path: string): Promise<{
    exists: boolean
    isFile: boolean
    isDir: boolean
    mtimeMs: number
    size: number
  }>
  readdir(path: string): Promise<Array<{ name: string; isFile: boolean; isDir: boolean }>>
  realpath(path: string): string
}

export function assertInsideWorkspace(cwd: string, path: string): string {
  const root = realpathSync(cwd)
  const resolved = resolveExisting(root, path)
  if (!isInsideRoot(resolved, root)) {
    throw new Error('outside workspace')
  }
  return resolved
}

export function workspaceFsFor(turn: { cwd: string }): WorkspaceFs {
  return createWorkspaceFs({ cwd: turn.cwd })
}

export function createWorkspaceFs(opts: {
  cwd: string
  exec?: TerminalBackend
  signal?: AbortSignal
}): WorkspaceFs {
  const root = realpathSync(opts.cwd)
  const signal = opts.signal ?? new AbortController().signal
  function jailed(path: string): string {
    return assertInsideWorkspace(root, path)
  }
  if (opts.exec?.kind === 'docker') {
    return dockerWorkspaceFs(opts.exec, opts.cwd, jailed, signal)
  }
  return hostWorkspaceFs(jailed)
}

function hostWorkspaceFs(jailed: (path: string) => string): WorkspaceFs {
  return {
    async readFile(path) {
      return readFileSync(jailed(path), 'utf8')
    },
    async readFileBuffer(path) {
      return readFileSync(jailed(path))
    },
    async writeFile(path, content) {
      writeFileSync(jailed(path), content, 'utf8')
    },
    async mkdir(path) {
      mkdirSync(jailed(path), { recursive: true })
    },
    async unlink(path) {
      unlinkSync(jailed(path))
    },
    async stat(path) {
      const target = jailed(path)
      try {
        const st = statSync(target)
        return {
          exists: true,
          isFile: st.isFile(),
          isDir: st.isDirectory(),
          mtimeMs: st.mtimeMs,
          size: st.size,
        }
      } catch (error) {
        if (isEnoent(error)) {
          return { exists: false, isFile: false, isDir: false, mtimeMs: 0, size: 0 }
        }
        throw error
      }
    },
    async readdir(path) {
      return readdirSync(jailed(path), { withFileTypes: true }).map((ent) => ({
        name: ent.name,
        isFile: ent.isFile(),
        isDir: ent.isDirectory(),
      }))
    },
    realpath(path) {
      return realpathSync(jailed(path))
    },
  }
}

function dockerWorkspaceFs(
  exec: TerminalBackend,
  cwd: string,
  jailed: (path: string) => string,
  signal: AbortSignal,
): WorkspaceFs {
  async function run(command: string, stdin?: string | Uint8Array): Promise<TerminalExecResult> {
    try {
      const result = await execSandboxFs(exec, {
        command,
        cwd,
        signal,
        ...(stdin !== undefined ? { stdin } : {}),
      })
      if (signal.aborted) throw abortError()
      return result
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        throw isAbortError(error) ? error : abortError()
      }
      throw error
    }
  }

  async function runChecked(command: string, stdin?: string | Uint8Array): Promise<TerminalExecResult> {
    const result = await run(command, stdin)
    if (result.exitCode !== 0) throw failClosed(result)
    return result
  }

  async function readFileBuffer(path: string): Promise<Buffer> {
    const result = await runChecked(buildReadFileBufferScript(jailed(path)))
    return decodeBase64(result.stdout)
  }

  return {
    async readFile(path) {
      return (await readFileBuffer(path)).toString('utf8')
    },
    readFileBuffer,
    async writeFile(path, content) {
      await runChecked(buildWriteFileScript(jailed(path)), content)
    },
    async mkdir(path) {
      await runChecked(buildMkdirScript(jailed(path)))
    },
    async unlink(path) {
      await runChecked(buildUnlinkScript(jailed(path)))
    },
    async stat(path) {
      const result = await run(buildStatScript(jailed(path)))
      if (result.exitCode !== 0) throw failClosed(result)
      return parseStat(result.stdout)
    },
    async readdir(path) {
      const result = await runChecked(buildReaddirScript(jailed(path)))
      if (result.stdout.trim() === '' && result.stderr.trim() !== '') throw failClosed(result)
      return parseReaddir(result.stdout)
    },
    realpath(path) {
      return realpathSync(jailed(path))
    },
  }
}

function parseStat(stdout: string): {
  exists: boolean
  isFile: boolean
  isDir: boolean
  mtimeMs: number
  size: number
} {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  if (lines.some((line) => line === FS_MISSING)) {
    return { exists: false, isFile: false, isDir: false, mtimeMs: 0, size: 0 }
  }
  for (const line of lines) {
    const match = /^EXISTS (\S+) (\d+) (\d+)$/.exec(line)
    if (!match) continue
    const kind = match[1]
    const size = Number(match[2])
    const mtimeSec = Number(match[3])
    if (kind === undefined || !Number.isFinite(size) || !Number.isFinite(mtimeSec)) {
      throw new Error('failed to parse stat')
    }
    return {
      exists: true,
      isFile: kind === 'file',
      isDir: kind === 'dir',
      mtimeMs: mtimeSec * 1000,
      size,
    }
  }
  throw new Error('failed to parse stat')
}

function parseReaddir(stdout: string): Array<{ name: string; isFile: boolean; isDir: boolean }> {
  const out: Array<{ name: string; isFile: boolean; isDir: boolean }> = []
  for (const raw of stdout.split('\n')) {
    if (!raw) continue
    if (raw.startsWith('d ')) out.push({ name: raw.slice(2), isFile: false, isDir: true })
    else if (raw.startsWith('f ')) out.push({ name: raw.slice(2), isFile: true, isDir: false })
  }
  if (out.length === 0 && stdout.trim().length > 0) {
    throw new Error('failed to parse readdir')
  }
  return out
}

function decodeBase64(text: string): Buffer {
  const cleaned = text.replace(/\s+/g, '')
  if (cleaned.length === 0) return Buffer.alloc(0)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new Error('failed to decode base64')
  }
  return Buffer.from(cleaned, 'base64')
}

function failClosed(result: TerminalExecResult): Error {
  const message = (result.stderr || result.stdout || 'failed').trim() || 'failed'
  return new Error(message)
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

function isInsideRoot(resolved: string, root: string): boolean {
  if (resolved === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return resolved.startsWith(prefix)
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
