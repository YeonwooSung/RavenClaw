import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NO_WEB_ENTRY,
  browserArgv,
  detectPackageManager,
  detectWebEntry,
  resolveStaticFile,
  runPlay,
  scriptCommand,
  startStaticPreview,
  type PlayChild,
  type WebEntry,
} from './play'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raven-play-'))
  dirs.push(dir)
  return dir
}

function writeJson(dir: string, value: unknown): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(value))
}

describe('detectWebEntry', () => {
  test('a dev script with a web dependency wins over index.html', () => {
    const dir = temp()
    writeFileSync(join(dir, 'index.html'), 'static')
    writeJson(dir, {
      dependencies: { phaser: '4.0.0' },
      scripts: { dev: 'vite', start: 'node server.js' },
    })
    const entry = detectWebEntry(dir)
    expect(entry.kind).toBe('script')
    if (entry.kind !== 'script') return
    expect(entry.script).toBe('dev')
    expect(entry.vite).toBe(false)
    expect(entry.manager).toBe('npm')
  })

  test('start is used only when dev is absent', () => {
    const dir = temp()
    writeJson(dir, { devDependencies: { vite: '6.0.0' }, scripts: { start: 'vite' } })
    const entry = detectWebEntry(dir)
    expect(entry).toMatchObject({ kind: 'script', script: 'start', vite: true })
  })

  test('cwd index.html wins over dist when there is no web script', () => {
    const dir = temp()
    writeFileSync(join(dir, 'index.html'), 'root')
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.html'), 'built')
    expect(detectWebEntry(dir)).toEqual({ kind: 'static', root: dir })
  })

  test('dist/index.html is the static root when cwd has none', () => {
    const dir = temp()
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.html'), 'built')
    mkdirSync(join(dir, 'build'))
    writeFileSync(join(dir, 'build', 'index.html'), 'nope')
    expect(detectWebEntry(dir)).toEqual({ kind: 'static', root: join(dir, 'dist') })
  })

  test('broken package.json falls through to index.html', () => {
    const dir = temp()
    writeFileSync(join(dir, 'package.json'), '{')
    writeFileSync(join(dir, 'index.html'), 'ok')
    expect(detectWebEntry(dir)).toEqual({ kind: 'static', root: dir })
  })

  test('missing entry names the three accepted shapes', () => {
    expect(detectWebEntry(temp())).toEqual({ kind: 'missing' })
  })

  test('lockfiles pick bun, then pnpm, then yarn, else npm', () => {
    const dir = temp()
    writeFileSync(join(dir, 'yarn.lock'), '')
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    expect(detectPackageManager(dir)).toBe('pnpm')
    writeFileSync(join(dir, 'bun.lock'), '')
    expect(detectPackageManager(dir)).toBe('bun')
    const yarnOnly = temp()
    writeFileSync(join(yarnOnly, 'yarn.lock'), '')
    expect(detectPackageManager(yarnOnly)).toBe('yarn')
    expect(detectPackageManager(temp())).toBe('npm')
  })
})

describe('scriptCommand', () => {
  const base: Extract<WebEntry, { kind: 'script' }> = {
    kind: 'script',
    cwd: '/game',
    manager: 'npm',
    script: 'dev',
    vite: false,
  }

  test('phaser keeps the script and does not append host flags', () => {
    expect(scriptCommand(base, 4321)).toEqual({ cmd: 'npm', args: ['run', 'dev'] })
    expect(scriptCommand({ ...base, manager: 'yarn' }, 4321)).toEqual({ cmd: 'yarn', args: ['dev'] })
  })

  test('vite appends loopback host and port, with an extra -- for npm', () => {
    expect(scriptCommand({ ...base, vite: true }, 4321)).toEqual({
      cmd: 'npm',
      args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4321'],
    })
    expect(scriptCommand({ ...base, manager: 'bun', vite: true }, 4321).args).toEqual([
      'run',
      'dev',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      '4321',
    ])
    expect(scriptCommand({ ...base, manager: 'yarn', vite: true }, 4321).args).toEqual([
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      '4321',
    ])
  })
})

describe('browserArgv', () => {
  test('uses the platform opener and refuses unknown platforms', () => {
    expect(browserArgv('darwin', 'http://127.0.0.1:1/')).toEqual(['open', 'http://127.0.0.1:1/'])
    expect(browserArgv('linux', 'http://127.0.0.1:1/')).toEqual(['xdg-open', 'http://127.0.0.1:1/'])
    expect(browserArgv('win32', 'http://127.0.0.1:1/')).toEqual([
      'cmd.exe',
      '/c',
      'start',
      '',
      'http://127.0.0.1:1/',
    ])
    expect(browserArgv('freebsd', 'http://127.0.0.1:1/')).toBeUndefined()
  })
})

describe('static preview', () => {
  test('serves index.html on 127.0.0.1 and refuses escapes and listings', async () => {
    const parent = temp()
    const root = join(parent, 'game')
    mkdirSync(root)
    writeFileSync(join(root, 'index.html'), 'HOME')
    writeFileSync(join(root, 'a.png'), Buffer.from([1, 2, 3]))
    writeFileSync(join(root, 'note.bin'), 'xyz')
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'assets', 'hidden.txt'), 'HIDDEN')
    writeFileSync(join(parent, 'secret.txt'), 'SECRET')
    symlinkSync(join(parent, 'secret.txt'), join(root, 'leak.txt'))

    const preview = startStaticPreview(root)
    try {
      expect(preview.hostname).toBe('127.0.0.1')
      expect(preview.url.startsWith('http://127.0.0.1:')).toBe(true)
      expect(preview.url.includes('0.0.0.0')).toBe(false)
      expect(await (await fetch(preview.url)).text()).toBe('HOME')
      const png = await fetch(`${preview.url}a.png`)
      expect(png.headers.get('content-type')).toBe('image/png')
      const bin = await fetch(`${preview.url}note.bin`)
      expect(bin.headers.get('content-type')).toBe('application/octet-stream')
      const listing = await fetch(`${preview.url}assets/`)
      expect(listing.status).toBe(404)
      expect(await listing.text()).not.toContain('HIDDEN')
      const leak = await fetch(`${preview.url}leak.txt`)
      expect(leak.status).toBe(403)
      expect(await leak.text()).not.toContain('SECRET')
      expect(resolveStaticFile(realpathSync(root), '/../secret.txt').status).toBe(403)
    } finally {
      await preview.stop()
    }
  })
})

describe('runPlay', () => {
  test('extra positionals exit 2 and do not serve', async () => {
    const dir = temp()
    writeFileSync(join(dir, 'index.html'), 'HOME')
    const stderr: string[] = []
    const code = await runPlay({
      cwd: dir,
      positional: 'elsewhere',
      signal: AbortSignal.abort(),
      stderr: (text) => stderr.push(text),
      open: () => {
        throw new Error('opened')
      },
    })
    expect(code).toBe(2)
    expect(stderr).toEqual(['usage: raven play\n'])
  })

  test('a missing entry exits 1, prints one line, and creates nothing', async () => {
    const dir = temp()
    const before = readdirSync(dir)
    const stderr: string[] = []
    const code = await runPlay({
      cwd: dir,
      stderr: (text) => stderr.push(text),
      open: () => {
        throw new Error('opened')
      },
    })
    expect(code).toBe(1)
    expect(stderr).toEqual([`${NO_WEB_ENTRY}\n`])
    expect(readdirSync(dir)).toEqual(before)
  })

  test('serves a static game without a home or an API key', async () => {
    const dir = temp()
    writeFileSync(join(dir, 'index.html'), 'HOME')
    const previous = process.env.RAVENCLAW_HOME
    delete process.env.RAVENCLAW_HOME
    const stdout: string[] = []
    const ac = new AbortController()
    const pending = runPlay({
      cwd: dir,
      signal: ac.signal,
      platform: 'darwin',
      stdout: (text) => stdout.push(text),
      open: async () => {
        const body = await (await fetch(stdout[0]?.trim() ?? '')).text()
        expect(body).toBe('HOME')
        ac.abort()
        return { ok: true }
      },
    })
    try {
      expect(await pending).toBe(0)
      expect(stdout).toHaveLength(1)
      const url = stdout[0]?.trim() ?? ''
      expect(url.startsWith('http://127.0.0.1:')).toBe(true)
    } finally {
      ac.abort()
      if (previous === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = previous
    }
  })

  test('an unknown platform keeps the server and exits 0', async () => {
    const dir = temp()
    writeFileSync(join(dir, 'index.html'), 'HOME')
    const stderr: string[] = []
    const ac = new AbortController()
    const code = await runPlay({
      cwd: dir,
      signal: ac.signal,
      platform: 'freebsd',
      stdout: () => {},
      stderr: (text) => {
        stderr.push(text)
        ac.abort()
      },
      open() {
        throw new Error('opened')
      },
    })
    expect(code).toBe(0)
    expect(stderr).toEqual(['raven play: no browser opener for freebsd\n'])
  })

  test('a failed opener is one stderr line and exit 0', async () => {
    const dir = temp()
    writeFileSync(join(dir, 'index.html'), 'HOME')
    const stderr: string[] = []
    const ac = new AbortController()
    const code = await runPlay({
      cwd: dir,
      signal: ac.signal,
      platform: 'linux',
      stdout: () => {},
      stderr: (text) => stderr.push(text),
      open() {
        ac.abort()
        return { ok: false }
      },
    })
    expect(code).toBe(0)
    expect(stderr).toEqual(['raven play: browser opener failed\n'])
  })

  test('a missing package manager exits 1 with its name', async () => {
    const dir = temp()
    writeJson(dir, { dependencies: { phaser: '4.0.0' }, scripts: { dev: 'phaser serve' } })
    const stderr: string[] = []
    const code = await runPlay({
      cwd: dir,
      which: () => null,
      stderr: (text) => stderr.push(text),
      spawn: () => {
        throw new Error('spawned')
      },
    })
    expect(code).toBe(1)
    expect(stderr).toEqual(['raven play: npm not found\n'])
  })

  test('vite is spawned with loopback flags and a foreground child', async () => {
    const dir = temp()
    writeFileSync(join(dir, 'bun.lock'), '')
    writeJson(dir, { devDependencies: { vite: '6.0.0' }, scripts: { dev: 'vite' } })
    const spawned: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    let killed = false
    const ac = new AbortController()
    const stdout: string[] = []
    const code = await runPlay({
      cwd: dir,
      signal: ac.signal,
      which: () => '/fake/bun',
      stdout: (text) => stdout.push(text),
      open: (argv) => {
        expect(argv[0]).toBe('open')
        ac.abort()
        return { ok: true }
      },
      platform: 'darwin',
      spawn(cmd, args, opts): PlayChild {
        spawned.push({ cmd, args, env: opts.env })
        let finish: (code: number) => void = () => {}
        const exited = new Promise<number>((resolve) => {
          finish = resolve
        })
        return {
          exited,
          kill() {
            killed = true
            finish(0)
          },
        }
      },
    })
    expect(code).toBe(0)
    expect(killed).toBe(true)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.cmd).toBe('/fake/bun')
    expect(spawned[0]?.args).toEqual(['run', 'dev', '--', '--host', '127.0.0.1', '--port', spawned[0]?.env.PORT])
    expect(spawned[0]?.env.HOST).toBe('127.0.0.1')
    expect(stdout[0]?.trim()).toBe(`http://127.0.0.1:${spawned[0]?.env.PORT}/`)
  })

  test('a script that exits before the browser stays closed', async () => {
    const dir = temp()
    writeJson(dir, { dependencies: { three: '0.170.0' }, scripts: { dev: 'node game.js' } })
    let opened = false
    const code = await runPlay({
      cwd: dir,
      which: () => '/fake/npm',
      open: () => {
        opened = true
        return { ok: true }
      },
      spawn(): PlayChild {
        return { exited: Promise.resolve(3), kill() {} }
      },
    })
    expect(code).toBe(3)
    expect(opened).toBe(false)
  })
})
