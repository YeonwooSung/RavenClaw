import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, type Provider } from '@ravenclaw/core'
import type { CreateDurableSessionOptions } from '@ravenclaw/sdk'
import { parseArgv } from './args'
import { DURABLE_USAGE, durableRequestId, runDurableCommand } from './durable-cmd'
import { SETUP_HINT } from './first-run'

describe('parseArgv durable', () => {
  test('reads the command, path, and prompt', () => {
    const parsed = parseArgv(['durable', '--path', 'sess.sqlite', 'hello', 'there'])
    expect(parsed.cmd).toBe('durable')
    expect(parsed.path).toBe('sess.sqlite')
    expect(parsed.prompt).toBe('hello there')
    expect(parsed.flags.dontAsk).toBe(true)
  })

  test('accepts --path= and a path before the command', () => {
    const eq = parseArgv(['durable', '--path=sess.sqlite', 'hi'])
    expect(eq.path).toBe('sess.sqlite')
    expect(eq.prompt).toBe('hi')
    const before = parseArgv(['--path', 'sess.sqlite', 'durable', 'hi'])
    expect(before.cmd).toBe('durable')
    expect(before.path).toBe('sess.sqlite')
    expect(before.prompt).toBe('hi')
  })

  test('rejects --path on exec', () => {
    expect(() => parseArgv(['exec', '--path', 'sess.sqlite', 'hi'])).toThrow('unknown flag: --path')
  })

  test('rejects --path= on resume', () => {
    expect(() => parseArgv(['resume', '--path=sess.sqlite'])).toThrow('unknown flag: --path')
  })
})

const fakeProvider = {} as Provider

function configuredHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'raven-durable-home-'))
  writeFileSync(join(home, '.env'), 'ANTHROPIC_API_KEY=test-key\n', { mode: 0o600 })
  return home
}

function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), 'raven-durable-empty-'))
}

function captureIo() {
  const captured = { stdout: '', stderr: '' }
  return {
    captured,
    io: {
      stdout: {
        write(chunk: string) {
          captured.stdout += chunk
        },
      },
      stderr: {
        write(chunk: string) {
          captured.stderr += chunk
        },
      },
    },
  }
}

type WaitResult = { status: 'done'; text: string } | { status: 'unanswered'; reason: string }

function sessionWith(
  result: WaitResult,
  hooks?: {
    onSubmit?: (input: { content: string; requestId?: string }) => void
    close?: () => Promise<void>
    submit?: () => Promise<{ wait(): Promise<WaitResult> }>
  },
) {
  return {
    async submit(input: { content: string; requestId?: string }) {
      hooks?.onSubmit?.(input)
      if (hooks?.submit) return hooks.submit()
      return { async wait() { return result } }
    },
    close: hooks?.close ?? (async () => {}),
  }
}

describe('runDurableCommand', () => {
  test('missing path or prompt returns usage and does not open a session', async () => {
    const cases: Array<{ path: string | undefined; prompt: string | undefined }> = [
      { path: undefined, prompt: 'hi' },
      { path: 'sess.sqlite', prompt: '' },
      { path: 'sess.sqlite', prompt: undefined },
      { path: undefined, prompt: undefined },
    ]
    for (const item of cases) {
      let opened = 0
      let resolved = 0
      const { captured, io } = captureIo()
      const code = await runDurableCommand({
        path: item.path,
        prompt: item.prompt,
        flags: {},
        home: emptyHome(),
        io,
        createSession: () => {
          opened += 1
          throw new Error('factory should not be called')
        },
        resolveProvider: async () => {
          resolved += 1
          return fakeProvider
        },
      })
      expect(code).toBe(2)
      expect(DURABLE_USAGE).toBe('usage: raven durable --path <file> <prompt>')
      expect(captured.stderr).toBe('usage: raven durable --path <file> <prompt>\n')
      expect(captured.stdout).toBe('')
      expect(opened).toBe(0)
      expect(resolved).toBe(0)
    }
  })

  test('unconfigured home returns the setup hint and does not open a session', async () => {
    let opened = 0
    const { captured, io } = captureIo()
    const code = await runDurableCommand({
      path: 'sess.sqlite',
      prompt: 'hi',
      flags: {},
      home: emptyHome(),
      io,
      createSession: () => {
        opened += 1
        throw new Error('factory should not be called')
      },
      resolveProvider: async () => fakeProvider,
    })
    expect(code).toBe(1)
    expect(captured.stderr).toBe(`${SETUP_HINT}\n`)
    expect(captured.stdout).toBe('')
    expect(opened).toBe(0)
  })

  test('factory receives dontAsk, the config model, and the session cwd', async () => {
    const home = configuredHome()
    const seen: CreateDurableSessionOptions[] = []
    const createSession = async (opts: CreateDurableSessionOptions) => {
      seen.push(opts)
      return sessionWith({ status: 'done', text: 'ok' })
    }
    const flags = { cwd: '/tmp/durable-work', model: 'claude-from-flags' }
    const { captured, io } = captureIo()
    const code = await runDurableCommand({
      path: 'sess.sqlite',
      prompt: 'hi',
      flags,
      home,
      io,
      createSession,
      resolveProvider: async () => fakeProvider,
    })
    const config = loadConfig({ home, flags })
    expect(code).toBe(0)
    expect(seen[0]).toEqual({
      path: 'sess.sqlite',
      cwd: '/tmp/durable-work',
      provider: fakeProvider,
      model: config.model,
      permissionMode: 'dontAsk',
    })
    expect(config.model).toBe('claude-from-flags')
    expect(Object.keys(seen[0]!).sort()).toEqual(['cwd', 'model', 'path', 'permissionMode', 'provider'])
    expect(seen[0]).not.toHaveProperty('systemPrompt')

    await runDurableCommand({
      path: 'sess.sqlite',
      prompt: 'hi',
      flags: { cwd: '/tmp/from-flags' },
      cwd: '/tmp/explicit-wins',
      home,
      io: captureIo().io,
      createSession,
      resolveProvider: async () => fakeProvider,
    })
    expect(seen[1]?.cwd).toBe('/tmp/explicit-wins')

    await runDurableCommand({
      path: 'sess.sqlite',
      prompt: 'hi',
      flags: {},
      home,
      io: captureIo().io,
      createSession,
      resolveProvider: async () => fakeProvider,
    })
    expect(seen[2]?.cwd).toBe(process.cwd())
    expect(seen[2]?.model).toBe(loadConfig({ home, flags: {} }).model)
  })

  test('request id follows the resolved path and the prompt', async () => {
    const same = durableRequestId('/tmp/sess.sqlite', 'hi')
    expect(durableRequestId('/tmp/foo/../sess.sqlite', 'hi')).toBe(same)
    expect(same.startsWith('durable:')).toBe(true)
    expect(durableRequestId('/tmp/sess.sqlite', 'bye')).not.toBe(same)
    expect(durableRequestId('foo/../sess.sqlite', 'hi')).toBe(
      durableRequestId(join(process.cwd(), 'sess.sqlite'), 'hi'),
    )

    let requestId: string | undefined
    const { io } = captureIo()
    await runDurableCommand({
      path: '/tmp/foo/../sess.sqlite',
      prompt: 'hi',
      flags: {},
      home: configuredHome(),
      io,
      createSession: async () =>
        sessionWith({ status: 'done', text: 'ok' }, {
          onSubmit(input) {
            requestId = input.requestId
          },
        }),
      resolveProvider: async () => fakeProvider,
    })
    expect(requestId).toBe(same)
    expect(requestId).toBe(durableRequestId('/tmp/foo/../sess.sqlite', 'hi'))
  })

  test('done text is written to stdout and the session is closed once', async () => {
    let closes = 0
    const { captured, io } = captureIo()
    const code = await runDurableCommand({
      path: 'sess.sqlite',
      prompt: 'hi',
      flags: {},
      home: configuredHome(),
      io,
      createSession: async () =>
        sessionWith({ status: 'done', text: 'hello' }, {
          async close() {
            closes += 1
          },
        }),
      resolveProvider: async () => fakeProvider,
    })
    expect(captured.stdout).toBe('hello\n')
    expect(captured.stderr).toBe('')
    expect(code).toBe(0)
    expect(closes).toBe(1)
  })

  test('unanswered reason is written to stderr and the session is closed once', async () => {
    let closes = 0
    const { captured, io } = captureIo()
    const code = await runDurableCommand({
      path: 'sess.sqlite',
      prompt: 'hi',
      flags: {},
      home: configuredHome(),
      io,
      createSession: async () =>
        sessionWith({ status: 'unanswered', reason: 'task_parked' }, {
          async close() {
            closes += 1
          },
        }),
      resolveProvider: async () => fakeProvider,
    })
    expect(captured.stderr).toBe('task_parked\n')
    expect(captured.stdout).toBe('')
    expect(code).toBe(1)
    expect(closes).toBe(1)
  })

  test('a submit error is written to stderr and the session is closed once', async () => {
    let closes = 0
    const { captured, io } = captureIo()
    const code = await runDurableCommand({
      path: 'sess.sqlite',
      prompt: 'hi',
      flags: {},
      home: configuredHome(),
      io,
      createSession: async () =>
        sessionWith({ status: 'done', text: 'unused' }, {
          async close() {
            closes += 1
          },
          submit() {
            throw new Error('durable session is busy')
          },
        }),
      resolveProvider: async () => fakeProvider,
    })
    expect(captured.stderr).toBe('durable session is busy\n')
    expect(captured.stdout).toBe('')
    expect(code).toBe(1)
    expect(closes).toBe(1)
  })

  test('a factory error is written to stderr and close is not called', async () => {
    const { captured, io } = captureIo()
    const code = await runDurableCommand({
      path: 'state.db',
      prompt: 'hi',
      flags: {},
      home: configuredHome(),
      io,
      createSession() {
        throw new Error('durable session path must not be state.db')
      },
      resolveProvider: async () => fakeProvider,
    })
    expect(captured.stderr).toBe('durable session path must not be state.db\n')
    expect(captured.stdout).toBe('')
    expect(code).toBe(1)
  })

  test('a close error is written to stderr and the code is 1', async () => {
    const { captured, io } = captureIo()
    const code = await runDurableCommand({
      path: 'sess.sqlite',
      prompt: 'hi',
      flags: {},
      home: configuredHome(),
      io,
      createSession: async () =>
        sessionWith({ status: 'done', text: 'hello' }, {
          async close() {
            throw new Error('close failed')
          },
        }),
      resolveProvider: async () => fakeProvider,
    })
    expect(captured.stdout).toBe('hello\n')
    expect(captured.stderr).toBe('close failed\n')
    expect(code).toBe(1)
  })

  test('durable-cmd does not boot the cli and names its provider imports', async () => {
    const text = await Bun.file(new URL('./durable-cmd.ts', import.meta.url)).text()
    expect(text).not.toContain('bootCli')
    expect(text).not.toContain('state.db')
    expect(text).toContain('providerFromConfig')
    expect(text).toContain('loadConfig')
  })
})
