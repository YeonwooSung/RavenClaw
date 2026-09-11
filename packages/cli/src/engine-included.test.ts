import { afterEach, describe, expect, test } from 'bun:test'
import {
  createMemoryStore,
  defaultConfig,
  type ModelProfile,
  type Provider,
  type ResolvedConfig,
} from '@ravenclaw/core'
import type { Entitlement } from '@ravenclaw/ads'
import {
  newSessionRecord,
  openEngine,
  providerFromConfig,
  resolveIncludedAccess,
} from './engine'

const GATEWAY = 'https://gw.example.com/v1'

function profile(id = 'anthropic/claude-sonnet-4'): ModelProfile {
  return {
    id,
    contextWindow: 32_000,
    reserveOutputTokens: 3_200,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
  }
}

function config(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...defaultConfig(),
    home: '/tmp',
    profile: profile(),
    ...over,
    included: over.included ?? { gatewayUrl: '' },
    env:
      over.env !== undefined
        ? over.env
        : { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai' },
  }
}

function admitted(over: Partial<Entitlement> = {}): Entitlement {
  return {
    admitted: true,
    placementRequired: true,
    hasPaidCapacityPlan: false,
    ...over,
  }
}

function denied(): Entitlement {
  return {
    admitted: false,
    placementRequired: false,
    hasPaidCapacityPlan: false,
  }
}

function stubProvider(): Provider {
  return {
    id: 'stub',
    apiMode: 'openai_compat',
    profile,
    async *stream() {
      yield { type: 'stop', reason: null }
    },
  }
}

describe('included gateway access', () => {
  const originalToken = process.env.RAVENCLAW_INCLUDED_TOKEN

  afterEach(() => {
    if (originalToken === undefined) delete process.env.RAVENCLAW_INCLUDED_TOKEN
    else process.env.RAVENCLAW_INCLUDED_TOKEN = originalToken
  })

  test.each(['anthropic', 'openai_compat'] as const)(
    'empty gatewayUrl uses %s and byok funding',
    async (kind) => {
      const probed: string[] = []
      const cfg = config({ provider: kind, included: { gatewayUrl: '' } })
      const probe = async (url: string) => {
        probed.push(url)
        return admitted()
      }
      const access = await resolveIncludedAccess(cfg, { probe })
      const provider = await providerFromConfig(cfg, { probe })
      const session = newSessionRecord({
        cwd: '/tmp',
        model: cfg.model,
        permissionMode: cfg.permissionMode,
        funding: access.admitted ? 'included' : 'byok',
      })
      expect(provider.id).toBe(kind)
      expect(session.funding).toBe('byok')
      expect(access.admitted).toBe(false)
      expect(probed).toEqual([])
    },
  )

  test('whitespace or missing gatewayUrl stays BYOK and does not probe', async () => {
    const probed: string[] = []
    const probe = async (url: string) => {
      probed.push(url)
      return admitted()
    }
    const missing = config({ included: undefined })
    const blank = config({ included: { gatewayUrl: '   ' } })
    expect((await resolveIncludedAccess(missing, { probe })).admitted).toBe(false)
    expect((await providerFromConfig(blank, { probe })).id).toBe('anthropic')
    expect(newSessionRecord({
      cwd: '/tmp',
      model: blank.model,
      permissionMode: blank.permissionMode,
    }).funding).toBe('byok')
    expect(probed).toEqual([])
  })

  test('gatewayUrl + admitted true uses included-gateway and included funding', async () => {
    const cfg = config({ included: { gatewayUrl: GATEWAY } })
    const seen: Array<{ url: string; token?: string }> = []
    const probe = async (url: string, opts?: { token?: string }) => {
      seen.push({ url, token: opts?.token })
      return admitted()
    }
    const access = await resolveIncludedAccess(cfg, { probe })
    const provider = await providerFromConfig(cfg, { access })
    const session = newSessionRecord({
      cwd: '/tmp',
      model: cfg.model,
      permissionMode: cfg.permissionMode,
      funding: access.admitted ? 'included' : 'byok',
    })
    expect(provider.id).toBe('included-gateway')
    expect(session.funding).toBe('included')
    expect(access.admitted).toBe(true)
    expect(seen).toEqual([{ url: GATEWAY, token: 'sk-oai' }])
  })

  test('gatewayUrl + admitted false falls back to BYOK and byok funding', async () => {
    const cfg = config({
      provider: 'openai_compat',
      included: { gatewayUrl: GATEWAY },
    })
    const probe = async () => denied()
    const access = await resolveIncludedAccess(cfg, { probe })
    const provider = await providerFromConfig(cfg, { probe })
    const session = newSessionRecord({
      cwd: '/tmp',
      model: cfg.model,
      permissionMode: cfg.permissionMode,
      funding: access.admitted ? 'included' : 'byok',
    })
    expect(provider.id).toBe('openai_compat')
    expect(session.funding).toBe('byok')
    expect(access.admitted).toBe(false)
  })

  test('hasPaidCapacityPlan true still uses included (capacity does not silence ads)', async () => {
    const cfg = config({ included: { gatewayUrl: GATEWAY } })
    const probe = async () => admitted({ hasPaidCapacityPlan: true })
    const access = await resolveIncludedAccess(cfg, { probe })
    const provider = await providerFromConfig(cfg, { access })
    expect(access.admitted).toBe(true)
    expect(provider.id).toBe('included-gateway')
    expect(
      newSessionRecord({
        cwd: '/tmp',
        model: cfg.model,
        permissionMode: cfg.permissionMode,
        funding: 'included',
      }).funding,
    ).toBe('included')
  })

  test('token prefers RAVENCLAW_INCLUDED_TOKEN, then OPENAI_API_KEY, then placeholder', async () => {
    const seen: Array<string | undefined> = []
    const probe = async (_url: string, opts?: { token?: string }) => {
      seen.push(opts?.token)
      return admitted()
    }

    process.env.RAVENCLAW_INCLUDED_TOKEN = 'tok-env'
    await resolveIncludedAccess(
      config({ env: { OPENAI_API_KEY: 'sk-oai' }, included: { gatewayUrl: GATEWAY } }),
      { probe },
    )
    expect(seen.at(-1)).toBe('tok-env')

    delete process.env.RAVENCLAW_INCLUDED_TOKEN
    await resolveIncludedAccess(
      config({ env: { OPENAI_API_KEY: 'sk-oai' }, included: { gatewayUrl: GATEWAY } }),
      { probe },
    )
    expect(seen.at(-1)).toBe('sk-oai')

    await resolveIncludedAccess(config({ env: {}, included: { gatewayUrl: GATEWAY } }), { probe })
    expect(seen.at(-1)).toBe('included')
  })

  test('admitted included works without a BYOK key', async () => {
    const cfg = config({ included: { gatewayUrl: GATEWAY }, env: {} })
    const provider = await providerFromConfig(cfg, { probe: async () => admitted() })
    expect(provider.id).toBe('included-gateway')
  })

  test('denied included does not throw; missing BYOK key still errors', async () => {
    const cfg = config({ included: { gatewayUrl: GATEWAY }, env: {}, provider: 'anthropic' })
    await expect(providerFromConfig(cfg, { probe: async () => denied() })).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    )
  })

  test('openEngine stamps funding onto a new session', async () => {
    const { engine } = await openEngine({
      provider: stubProvider(),
      store: createMemoryStore(),
      config: config(),
      cwd: '/tmp',
      funding: 'included',
      async askUser() {
        return 'deny'
      },
    })
    expect(engine.session.funding).toBe('included')
  })
})
