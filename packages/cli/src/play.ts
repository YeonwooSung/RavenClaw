import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

export const NO_WEB_ENTRY =
  'raven play: no web entry (index.html, dist/index.html, or dev/start with phaser|pixi.js|three|vite)'

const WEB_DEP_NAMES = ['phaser', 'pixi.js', 'three', 'vite'] as const
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
}

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

export type WebEntry =
  | { kind: 'static'; root: string }
  | {
      kind: 'script'
      cwd: string
      manager: PackageManager
      script: 'dev' | 'start'
      vite: boolean
    }
  | { kind: 'missing' }

export type PlayChild = {
  exited: Promise<number>
  kill: () => void
}

export type PlayIo = {
  cwd?: string
  positional?: string
  signal?: AbortSignal
  platform?: NodeJS.Platform
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  open?: (argv: string[]) => { ok: boolean } | Promise<{ ok: boolean }>
  spawn?: (
    cmd: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv },
  ) => PlayChild
  which?: (name: string) => string | null
}

type StaticHit =
  | { status: 200; file: string; type: string }
  | { status: 403 | 404 }

type LivePlay = {
  url: string
  stop: () => Promise<void>
}

const liveBySession = new Map<string, LivePlay>()

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export function browserArgv(platform: string, url: string): string[] | undefined {
  if (platform === 'darwin') return ['open', url]
  if (platform === 'linux') return ['xdg-open', url]
  if (platform === 'win32') return ['cmd.exe', '/c', 'start', '', url]
  return undefined
}

export function detectPackageManager(cwd: string): PackageManager {
  if (isFile(join(cwd, 'bun.lock')) || isFile(join(cwd, 'bun.lockb'))) return 'bun'
  if (isFile(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (isFile(join(cwd, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

export function scriptCommand(
  entry: Extract<WebEntry, { kind: 'script' }>,
  port: number,
): { cmd: string; args: string[] } {
  const cmd = entry.manager
  if (!entry.vite) {
    if (entry.manager === 'yarn') return { cmd, args: [entry.script] }
    return { cmd, args: ['run', entry.script] }
  }
  const tail = ['--host', '127.0.0.1', '--port', String(port)]
  if (entry.manager === 'yarn') return { cmd, args: [entry.script, ...tail] }
  return { cmd, args: ['run', entry.script, '--', ...tail] }
}

export function detectWebEntry(cwd: string): WebEntry {
  const pkg = readPackage(cwd)
  if (pkg && pkg.script && WEB_DEP_NAMES.some((name) => pkg.deps.has(name))) {
    return {
      kind: 'script',
      cwd,
      manager: detectPackageManager(cwd),
      script: pkg.script,
      vite: pkg.deps.has('vite'),
    }
  }
  if (isFile(join(cwd, 'index.html'))) return { kind: 'static', root: cwd }
  if (isFile(join(cwd, 'dist', 'index.html'))) return { kind: 'static', root: join(cwd, 'dist') }
  return { kind: 'missing' }
}

export function resolveStaticFile(rootReal: string, pathname: string): StaticHit {
  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { status: 404 }
  }
  if (decoded.includes('\0')) return { status: 404 }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  if (rel === '' || rel === '.') return { status: 404 }
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
  const lexical = resolve(rootReal, rel)
  if (lexical !== rootReal && !lexical.startsWith(rootPrefix)) return { status: 403 }
  let listed: ReturnType<typeof lstatSync>
  try {
    listed = lstatSync(lexical)
  } catch {
    return { status: 404 }
  }
  if (listed.isDirectory()) return { status: 404 }
  let real: string
  try {
    real = realpathSync(lexical)
  } catch {
    return { status: 404 }
  }
  if (real !== rootReal && !real.startsWith(rootPrefix)) return { status: 403 }
  if (!statSync(real).isFile()) return { status: 404 }
  return { status: 200, file: real, type: contentTypeFor(real) }
}

export type StaticPreview = {
  url: string
  hostname: string
  port: number
  stop: () => Promise<void>
}

export function startStaticPreview(root: string): StaticPreview {
  const rootReal = realpathSync(root)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response(null, { status: 405 })
      }
      const hit = resolveStaticFile(rootReal, new URL(req.url).pathname)
      if (hit.status !== 200) return new Response(null, { status: hit.status })
      const body = req.method === 'HEAD' ? null : Bun.file(hit.file)
      return new Response(body, { headers: { 'content-type': hit.type } })
    },
  })
  const hostname = server.hostname ?? '127.0.0.1'
  return {
    url: `http://127.0.0.1:${server.port}/`,
    hostname,
    port: server.port,
    async stop() {
      await server.stop(true)
    },
  }
}

export async function reserveLoopbackPort(): Promise<number> {
  const probe = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(null, { status: 204 })
    },
  })
  const port = probe.port
  await probe.stop(true)
  return port
}

export async function runPlay(io: PlayIo = {}): Promise<number> {
  const positional = io.positional?.trim() ?? ''
  if (positional !== '') {
    writeErr(io, 'usage: raven play\n')
    return 2
  }
  const cwd = io.cwd ?? process.cwd()
  const entry = detectWebEntry(cwd)
  if (entry.kind === 'missing') {
    writeErr(io, `${NO_WEB_ENTRY}\n`)
    return 1
  }
  let stop = async () => {}
  try {
    let url: string
    if (entry.kind === 'static') {
      const preview = startStaticPreview(entry.root)
      stop = preview.stop
      url = preview.url
    } else {
      const started = await startScript(entry, io)
      if (started.exitCode !== undefined) return started.exitCode
      stop = started.stop
      url = started.url
    }
    writeOut(io, url.endsWith('\n') ? url : `${url}\n`)
    await openBrowser(url.trim(), io)
    await waitForStop(io.signal)
    return 0
  } finally {
    await stop()
  }
}

export async function startSessionPlay(sessionId: string, cwd: string, io: PlayIo = {}): Promise<string> {
  const existing = liveBySession.get(sessionId)
  if (existing) return existing.url
  const entry = detectWebEntry(cwd)
  if (entry.kind === 'missing') return NO_WEB_ENTRY
  if (entry.kind === 'static') {
    const preview = startStaticPreview(entry.root)
    liveBySession.set(sessionId, { url: preview.url, stop: preview.stop })
    await openBrowser(preview.url, io)
    return preview.url
  }
  const which = io.which ?? ((name: string) => Bun.which(name))
  const bin = which(entry.manager)
  if (!bin) return `raven play: ${entry.manager} not found`
  const started = await startScript(entry, io, bin)
  if (started.exitCode !== undefined) return `raven play: exit ${started.exitCode}`
  liveBySession.set(sessionId, { url: started.url, stop: started.stop })
  await openBrowser(started.url, io)
  return started.url
}

export async function stopSessionPlay(sessionId: string): Promise<string> {
  const existing = liveBySession.get(sessionId)
  if (!existing) return 'raven play: nothing running'
  liveBySession.delete(sessionId)
  await existing.stop()
  return `stopped ${existing.url}`
}

async function startScript(
  entry: Extract<WebEntry, { kind: 'script' }>,
  io: PlayIo,
  bin?: string,
): Promise<{ url: string; stop: () => Promise<void>; exitCode?: number }> {
  const which = io.which ?? ((name: string) => Bun.which(name))
  const resolved = bin ?? which(entry.manager)
  if (!resolved) {
    writeErr(io, `raven play: ${entry.manager} not found\n`)
    return { url: '', stop: async () => {}, exitCode: 1 }
  }
  const port = await reserveLoopbackPort()
  const command = scriptCommand(entry, port)
  const env: NodeJS.ProcessEnv = { ...process.env, HOST: '127.0.0.1', PORT: String(port) }
  const spawn = io.spawn ?? defaultSpawn
  const child = spawn(resolved, command.args, { cwd: entry.cwd, env })
  const early = await earlyExit(child)
  if (early !== undefined) return { url: '', stop: async () => {}, exitCode: early }
  const url = `http://127.0.0.1:${port}/`
  return {
    url,
    async stop() {
      child.kill()
      await Promise.race([child.exited, delay(1_000)])
    },
  }
}

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): PlayChild {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return {
    exited: proc.exited,
    kill() {
      proc.kill()
    },
  }
}

async function earlyExit(child: PlayChild): Promise<number | undefined> {
  let code: number | undefined
  const seen = child.exited.then((value) => {
    code = value
  })
  await Promise.race([seen, delay(50)])
  return code
}

async function openBrowser(url: string, io: PlayIo): Promise<void> {
  const platform = io.platform ?? process.platform
  const argv = browserArgv(platform, url)
  if (!argv) {
    writeErr(io, `raven play: no browser opener for ${platform}\n`)
    return
  }
  const open = io.open ?? defaultOpen
  try {
    const result = await open(argv)
    if (!result.ok) writeErr(io, 'raven play: browser opener failed\n')
  } catch {
    writeErr(io, 'raven play: browser opener failed\n')
  }
}

async function defaultOpen(argv: string[]): Promise<{ ok: boolean }> {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  const code = await proc.exited
  return { ok: code === 0 }
}

function waitForStop(signal: AbortSignal | undefined): Promise<void> {
  if (signal) {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }
  return new Promise((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

function writeOut(io: PlayIo, text: string): void {
  if (io.stdout) io.stdout(text)
  else process.stdout.write(text)
}

function writeErr(io: PlayIo, text: string): void {
  if (io.stderr) io.stderr(text)
  else process.stderr.write(text)
}

function readPackage(
  cwd: string,
): { deps: Set<string>; script: 'dev' | 'start' | undefined } | undefined {
  const path = join(cwd, 'package.json')
  if (!isFile(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  const deps = new Set<string>()
  for (const field of DEP_FIELDS) {
    const block = record[field]
    if (block && typeof block === 'object') {
      for (const key of Object.keys(block as object)) deps.add(key)
    }
  }
  const scripts = record.scripts
  let script: 'dev' | 'start' | undefined
  if (scripts && typeof scripts === 'object') {
    const table = scripts as Record<string, unknown>
    if (typeof table.dev === 'string' && table.dev.length > 0) script = 'dev'
    else if (typeof table.start === 'string' && table.start.length > 0) script = 'start'
  }
  return { deps, script }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
