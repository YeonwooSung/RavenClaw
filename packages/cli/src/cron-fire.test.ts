import { describe, expect, test } from 'bun:test'
import {
  createMemoryStore,
  defaultConfig,
  type CronJob,
  type ModelProfile,
  type Provider,
  type ResolvedConfig,
} from '@ravenclaw/core'
import { cronFireSessionRuntime } from './cron-fire'
import { createAskBridge } from './engine'

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
})
