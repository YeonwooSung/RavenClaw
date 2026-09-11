import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ravenclawHome } from '../home'
import { parseWithSchema } from '../tools/parse'
import type { Tool, ToolContext } from '../types'

export interface PluginToolSpec {
  name: string
  description: string
  command: string
  args?: string[]
}

export interface PluginManifest {
  name: string
  description: string
  tools?: PluginToolSpec[]
}

const PLUGIN_TIMEOUT_MS = 30_000
const KILL_GRACE_MS = 200

const toolInputSchema = { type: 'object' }

export function loadLocalPlugins(
  cwd: string,
  home?: string,
  opts?: { project?: boolean },
): Tool[] {
  const userHome = home ?? ravenclawHome()
  const byName = new Map<string, { dir: string; manifest: PluginManifest }>()
  loadPluginRoot(join(userHome, 'plugins'), byName)
  if (opts?.project === true) {
    loadPluginRoot(join(cwd, '.ravenclaw', 'plugins'), byName)
  }

  const tools: Tool[] = []
  for (const loaded of byName.values()) {
    for (const spec of loaded.manifest.tools ?? []) {
      tools.push(createPluginTool(loaded.dir, spec))
    }
  }
  return tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function loadPluginRoot(
  root: string,
  into: Map<string, { dir: string; manifest: PluginManifest }>,
): void {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const dir = join(root, ent.name)
    const manifest = readManifest(join(dir, 'plugin.json'))
    if (!manifest) continue
    into.set(manifest.name, { dir, manifest })
  }
}

function readManifest(path: string): PluginManifest | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  return parseManifest(parsed)
}

function parseManifest(value: unknown): PluginManifest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const rec = value as Record<string, unknown>
  if (typeof rec.name !== 'string' || rec.name.length === 0) return undefined
  if (typeof rec.description !== 'string') return undefined

  const tools: PluginToolSpec[] = []
  if (rec.tools !== undefined) {
    if (!Array.isArray(rec.tools)) return undefined
    for (const item of rec.tools) {
      const spec = parseToolSpec(item)
      if (spec) tools.push(spec)
    }
  }
  return { name: rec.name, description: rec.description, tools }
}

function parseToolSpec(value: unknown): PluginToolSpec | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const rec = value as Record<string, unknown>
  if (typeof rec.name !== 'string' || rec.name.length === 0) return undefined
  if (typeof rec.description !== 'string') return undefined
  if (typeof rec.command !== 'string' || rec.command.length === 0) return undefined
  const spec: PluginToolSpec = {
    name: rec.name,
    description: rec.description,
    command: rec.command,
  }
  if (rec.args !== undefined) {
    if (!Array.isArray(rec.args) || rec.args.some((arg) => typeof arg !== 'string')) {
      return undefined
    }
    spec.args = rec.args as string[]
  }
  return spec
}

function createPluginTool(pluginDir: string, spec: PluginToolSpec): Tool {
  const command = resolveCommand(spec.command, pluginDir)
  const args = spec.args ?? []
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: toolInputSchema,
    parse(input: unknown) {
      return parseWithSchema(toolInputSchema, input)
    },
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return false
    },
    interruptBehavior() {
      return 'cancel'
    },
    async checkPermissions() {
      return { behavior: 'ask', reason: 'user' }
    },
    async execute(input: unknown, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      let cwd: string
      try {
        cwd = realpathSync(ctx.turn.cwd)
      } catch {
        return 'plugin failed: cwd not found'
      }
      try {
        return await runPluginCommand({
          command,
          args,
          cwd,
          stdin: JSON.stringify(input ?? {}),
          signal: ctx.signal,
          timeoutMs: PLUGIN_TIMEOUT_MS,
        })
      } catch (error) {
        if (isAbortError(error) || ctx.signal.aborted) throw abortError()
        const message = error instanceof Error ? error.message : String(error)
        return `plugin failed: ${message}`
      }
    },
  }
}

const SPAWN_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP'] as const

function pluginSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of SPAWN_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function resolveCommand(command: string, pluginDir: string): string {
  if (command.includes('/') || command.includes('\\')) return resolve(pluginDir, command)
  return command
}

function runPluginCommand(opts: {
  command: string
  args: string[]
  cwd: string
  stdin: string
  signal: AbortSignal
  timeoutMs: number
}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    if (opts.signal.aborted) {
      reject(abortError())
      return
    }

    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: pluginSpawnEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      requestKill()
    }, opts.timeoutMs)

    const onAbort = () => {
      requestKill()
    }

    const requestKill = () => {
      child.kill('SIGTERM')
      if (killTimer === undefined) {
        killTimer = setTimeout(() => {
          child.kill('SIGKILL')
        }, KILL_GRACE_MS)
      }
    }

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      opts.signal.removeEventListener('abort', onAbort)
      clearTimeout(timeoutTimer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      fn()
    }

    opts.signal.addEventListener('abort', onAbort)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })

    child.on('error', (error) => {
      finish(() => {
        if (opts.signal.aborted) {
          reject(abortError())
          return
        }
        reject(error)
      })
    })

    child.on('close', (code) => {
      finish(() => {
        if (opts.signal.aborted) {
          reject(abortError())
          return
        }
        if (timedOut) {
          resolvePromise(stdout.length > 0 ? stdout : 'plugin timed out')
          return
        }
        if ((code ?? 0) !== 0 && stdout.length === 0) {
          resolvePromise(stderr.length > 0 ? stderr : `plugin exited ${code ?? 1}`)
          return
        }
        resolvePromise(stdout)
      })
    })

    child.stdin?.write(opts.stdin)
    child.stdin?.end()
  })
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError')
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
