import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryStore,
  defaultConfig,
  type CronJob,
  type ModelProfile,
  type Provider,
  type ResolvedConfig,
  type RoundEnd,
  type SessionEngine,
} from '@ravenclaw/core'
import { cronFireSessionRuntime, fireCronJob } from './cron-fire'
import { createAskBridge, type CliRuntime, type CliRuntimeBase } from './engine'

function profile(): ModelProfile {
  return {
    id: 'dummy',
    contextWindow: 32_000,
    reserveOutputTokens: 3_200,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
  }
}

function config(): ResolvedConfig {
  return {
    ...defaultConfig(),
    home: '/tmp/rc-home',
    profile: profile(),
    permissionMode: 'default',
    included: { gatewayUrl: '' },
    env: {},
  }
}

function job(): CronJob {
  return {
    id: 'c_abcabcab',
    name: 'job',
    enabled: true,
    cwd: '/job/cwd',
    prompt: 'do work',
    schedule: { kind: 'every', everyMs: 30_000 },
    nextFireAt: 1,
    createdAt: 1,
  }
}

describe('cronFireSessionRuntime', () => {
  test('keeps headless surface and preferByok and only overrides cwd and dontAsk', () => {
    const probe = async () => ({
      admitted: false,
      placementRequired: true,
      hasPaidCapacityPlan: false,
    })
    const fetchImpl = async () => new Response('{}')
    const runtime = {
      store: createMemoryStore(),
      provider: { id: 'fake' } as Provider,
      config: config(),
      cwd: '/parent',
      ask: createAskBridge(),
      surface: 'headless' as const,
      preferByok: true,
      probe,
      fetch: fetchImpl as typeof fetch,
      lockHolderId: 'holder-parent',
      lockHolderName: 'tui' as const,
    }
    const next = cronFireSessionRuntime(runtime, job())
    expect(next.surface).toBe('headless')
    expect(runtime.surface).toBe('headless')
    expect(next.preferByok).toBe(true)
    expect(next.probe).toBe(probe)
    expect(next.fetch).toBe(fetchImpl)
    expect(next.cwd).toBe('/job/cwd')
    expect(next.config.permissionMode).toBe('dontAsk')
    expect(runtime.config.permissionMode).toBe('default')
    expect(runtime.cwd).toBe('/parent')
    expect(next.lockHolderName).toBe('cron')
    expect(next.lockHolderId).toBe('holder-parent')
    expect('engine' in next).toBe(false)
  })

  test('forces headless even when the parent TUI is interactive', () => {
    const runtime = {
      store: createMemoryStore(),
      provider: { id: 'fake' } as Provider,
      config: config(),
      cwd: '/parent',
      ask: createAskBridge(),
      surface: 'interactive' as const,
      lockHolderId: 'holder-parent',
      lockHolderName: 'tui' as const,
    }
    const next = cronFireSessionRuntime(runtime, job())
    expect(next.surface).toBe('headless')
    expect(runtime.surface).toBe('interactive')
    expect(next.lockHolderName).toBe('cron')
  })

  test('skipMemory sets bare and verifyOnStop is forwarded', () => {
    const runtime = {
      store: createMemoryStore(),
      provider: { id: 'fake' } as Provider,
      config: config(),
      cwd: '/parent',
      ask: createAskBridge(),
      surface: 'headless' as const,
      lockHolderId: 'holder-parent',
      lockHolderName: 'tui' as const,
      verifyOnStop: true,
    }
    const skipped = cronFireSessionRuntime(runtime, {
      ...job(),
      skipMemory: true,
      verifyOnStop: true,
    })
    expect(skipped.config.bare).toBe(true)
    expect(skipped.verifyOnStop).toBe(true)
    expect(skipped.surface).toBe('headless')
    expect(runtime.config.bare).toBeUndefined()

    const plain = cronFireSessionRuntime(runtime, job())
    expect(plain.config.bare).toBeUndefined()
    expect(plain.verifyOnStop).toBeUndefined()
  })

  test('parent askUserHost does not leak into the fire session', () => {
    const runtime = {
      store: createMemoryStore(),
      provider: { id: 'fake' } as Provider,
      config: config(),
      cwd: '/parent',
      ask: createAskBridge(),
      surface: 'interactive' as const,
      askUserHost: true,
      lockHolderId: 'holder-parent',
      lockHolderName: 'tui' as const,
    }
    const next = cronFireSessionRuntime(runtime, { ...job(), verifyOnStop: true })
    expect(next.askUserHost).toBeUndefined()
    expect(next.verifyOnStop).toBe(true)
    expect(next.surface).toBe('headless')
  })
})

function hungEngine(): SessionEngine {
  let aborted = false
  let resolveWait: (() => void) | undefined
  const engine = {
    session: { id: 'sess_timeout' },
    abort() {
      aborted = true
      resolveWait?.()
    },
    close: async () => {},
    submitMessage() {
      return (async function* () {
        if (!aborted) {
          await new Promise<void>((resolve) => {
            resolveWait = resolve
            if (aborted) resolve()
          })
        }
        return { reason: 'aborted' } as RoundEnd
      })()
    },
  }
  return engine as unknown as SessionEngine
}

function fakeChild(engine: SessionEngine): CliRuntime {
  return {
    engine,
    store: createMemoryStore(),
    provider: { id: 'fake' } as Provider,
    config: config(),
    cwd: '/job/cwd',
    ask: createAskBridge(),
    surface: 'headless',
    lockHolderId: 'holder',
    lockHolderName: 'cron',
  }
}

function baseRuntime(): CliRuntimeBase {
  return {
    store: createMemoryStore(),
    provider: { id: 'fake' } as Provider,
    config: config(),
    cwd: '/parent',
    ask: createAskBridge(),
    surface: 'headless',
    lockHolderId: 'holder-parent',
    lockHolderName: 'cron',
  }
}

describe('fireCronJob', () => {
  test('timeout aborts a hung engine and returns lastError timeout', async () => {
    const engine = hungEngine()
    let aborted = false
    const origAbort = engine.abort.bind(engine)
    engine.abort = () => {
      aborted = true
      origAbort()
    }
    let opened: CliRuntimeBase | undefined
    const result = await fireCronJob(baseRuntime(), { ...job(), timeoutMs: 15_000 }, {
      openNewSession: async (runtime) => {
        opened = runtime
        return fakeChild(engine)
      },
      runExec: async ({ engine: child }) => {
        const gen = child.submitMessage('do work')
        const next = await gen.next()
        const end = next.done ? next.value : { reason: 'aborted' as const }
        return { text: '', events: [], end }
      },
      delay: (_ms, onFire) => {
        onFire()
        return () => {}
      },
    })
    expect(aborted).toBe(true)
    expect(result).toEqual({ ok: false, sessionId: 'sess_timeout', error: 'timeout' })
    expect(opened?.surface).toBe('headless')
    expect(opened?.config.bare).toBeUndefined()
  })

  test('preScript non-zero skips the agent', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-cron-pre-'))
    let opened = false
    try {
      const result = await fireCronJob(
        baseRuntime(),
        { ...job(), cwd, preScript: 'exit 7' },
        {
          openNewSession: async () => {
            opened = true
            return fakeChild(hungEngine())
          },
        },
      )
      expect(opened).toBe(false)
      expect(result.ok).toBe(false)
      expect(result.sessionId).toBeUndefined()
      expect(result.error).toMatch(/preScript exited 7/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('old job without new fields still fires', async () => {
    let opened: CliRuntimeBase | undefined
    let prompt: string | undefined
    const result = await fireCronJob(baseRuntime(), job(), {
      openNewSession: async (runtime) => {
        opened = runtime
        return fakeChild({
          session: { id: 'sess_old' },
          abort() {},
          close: async () => {},
        } as SessionEngine)
      },
      runExec: async (opts) => {
        prompt = opts.prompt
        return { text: 'ok', events: [], end: { reason: 'completed' } }
      },
      delay: () => () => {},
    })
    expect(result).toEqual({ ok: true, sessionId: 'sess_old' })
    expect(prompt).toBe('do work')
    expect(opened?.config.bare).toBeUndefined()
    expect(opened?.verifyOnStop).toBeUndefined()
    expect(opened?.config.permissionMode).toBe('dontAsk')
  })

  test('verifyOnStop job flag is forwarded into the fire session', async () => {
    let opened: CliRuntimeBase | undefined
    await fireCronJob(baseRuntime(), { ...job(), verifyOnStop: true, skipMemory: true }, {
      openNewSession: async (runtime) => {
        opened = runtime
        return fakeChild({
          session: { id: 'sess_vos' },
          abort() {},
          close: async () => {},
        } as SessionEngine)
      },
      runExec: async () => ({ text: '', events: [], end: { reason: 'completed' } }),
      delay: () => () => {},
    })
    expect(opened?.verifyOnStop).toBe(true)
    expect(opened?.config.bare).toBe(true)
  })
})
