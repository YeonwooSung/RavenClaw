import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { utcDay } from './included-usage'

const GATEWAY = 'https://gw.example.com/v1'
const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-included-'))
  tempDirs.push(dir)
  return dir
}

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
  const home = over.home ?? tempHome()
  return {
    ...defaultConfig(),
    profile: profile(),
    ...over,
    home,
    included: over.included ?? { gatewayUrl: '' },
    env:
      over.env !== undefined
        ? over.env
        : { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai' },
  }
}

function includedOn(
  over: Partial<NonNullable<ResolvedConfig['included']>> = {},
): NonNullable<ResolvedConfig['included']> {
  return { gatewayUrl: GATEWAY, enabled: true, ...over }
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

async function drainProvider(stream: AsyncIterable<{ type: string }>): Promise<void> {
  for await (const _chunk of stream) {
    // exhaust
  }
}

describe('included gateway access', () => {
  const originalToken = process.env.RAVENCLAW_INCLUDED_TOKEN

  afterEach(() => {
    if (originalToken === undefined) delete process.env.RAVENCLAW_INCLUDED_TOKEN
    else process.env.RAVENCLAW_INCLUDED_TOKEN = originalToken
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
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

  test('disabled + gatewayUrl stays BYOK and does not probe', async () => {
    const probed: string[] = []
    const probe = async (url: string) => {
      probed.push(url)
      return admitted()
    }
    const cfg = config({ included: { gatewayUrl: GATEWAY } })
    const access = await resolveIncludedAccess(cfg, { probe })
    expect(access.admitted).toBe(false)
    expect((await providerFromConfig(cfg, { probe })).id).toBe('anthropic')
    expect(probed).toEqual([])
  })

  test('enabled + denied probe stays BYOK', async () => {
    const cfg = config({
      provider: 'openai_compat',
      included: includedOn(),
    })
    const probe = async () => denied()
    const access = await resolveIncludedAccess(cfg, { probe })
    expect(access.admitted).toBe(false)
    expect((await providerFromConfig(cfg, { probe })).id).toBe('openai_compat')
  })

  test('gatewayUrl + admitted true uses included-gateway and included funding', async () => {
    const cfg = config({ included: includedOn() })
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
      included: includedOn(),
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
    const cfg = config({ included: includedOn() })
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
      config({ env: { OPENAI_API_KEY: 'sk-oai' }, included: includedOn() }),
      { probe },
    )
    expect(seen.at(-1)).toBe('tok-env')

    delete process.env.RAVENCLAW_INCLUDED_TOKEN
    await resolveIncludedAccess(
      config({ env: { OPENAI_API_KEY: 'sk-oai' }, included: includedOn() }),
      { probe },
    )
    expect(seen.at(-1)).toBe('sk-oai')

    await resolveIncludedAccess(config({ env: {}, included: includedOn() }), { probe })
    expect(seen.at(-1)).toBe('included')
  })

  test('admitted included works without a BYOK key', async () => {
    const cfg = config({ included: includedOn(), env: {} })
    const provider = await providerFromConfig(cfg, { probe: async () => admitted() })
    expect(provider.id).toBe('included-gateway')
  })

  test('denied included does not throw; missing BYOK key still errors', async () => {
    const cfg = config({ included: includedOn(), env: {}, provider: 'anthropic' })
    await expect(providerFromConfig(cfg, { probe: async () => denied() })).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    )
  })

  test('cap reached stays BYOK and does not throw', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'included-usage.json'), JSON.stringify({ day: utcDay(), count: 4 }))
    const cfg = config({ home, included: includedOn({ sessionCapPerDay: 4 }) })
    const access = await resolveIncludedAccess(cfg, { probe: async () => admitted() })
    expect(access.admitted).toBe(false)
    expect((await providerFromConfig(cfg, { probe: async () => admitted() })).id).toBe('anthropic')
  })

  test('remainingSessions 0 stays BYOK even when the local ledger is empty', async () => {
    const access = await resolveIncludedAccess(config({ included: includedOn() }), {
      probe: async () => admitted({ remainingSessions: 0 }),
    })
    expect(access.admitted).toBe(false)
  })

  test('paid plan uses a higher cap than sessionCapPerDay', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'included-usage.json'), JSON.stringify({ day: utcDay(), count: 4 }))
    const cfg = config({ home, included: includedOn({ sessionCapPerDay: 4 }) })
    expect((await resolveIncludedAccess(cfg, { probe: async () => admitted() })).admitted).toBe(false)
    expect(
      (await resolveIncludedAccess(cfg, { probe: async () => admitted({ hasPaidCapacityPlan: true }) }))
        .admitted,
    ).toBe(true)
  })

  test('admitted session is recorded against the daily cap', async () => {
    const home = tempHome()
    const cfg = config({ home, included: includedOn({ sessionCapPerDay: 1 }) })
    const probe = async () => admitted()
    expect((await resolveIncludedAccess(cfg, { probe })).admitted).toBe(true)
    expect((await resolveIncludedAccess(cfg, { probe })).admitted).toBe(false)
  })

  test('forwards entitlement defaultModel and catalog-coerces to it', async () => {
    const originalFetch = globalThis.fetch
    const sse = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const models: string[] = []
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : ''
      const parsed = JSON.parse(raw) as { model?: string }
      models.push(parsed.model ?? '')
      if (parsed.model === 'gone/model') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'unknown model' }), { status: 404 }),
        )
      }
      return Promise.resolve(
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      )
    }) as typeof fetch

    try {
      const cfg = config({
        model: 'local/byok-model',
        included: includedOn({ defaultModel: 'config/included-model' }),
      })
      const access = await resolveIncludedAccess(cfg, {
        probe: async () => admitted({ defaultModel: 'entitlement/catalog-model' }),
      })
      expect(access.admitted).toBe(true)
      if (access.admitted) expect(access.defaultModel).toBe('entitlement/catalog-model')

      const provider = await providerFromConfig(cfg, { access })
      expect(provider.id).toBe('included-gateway')
      await drainProvider(
        provider.stream(
          {
            model: 'gone/model',
            system: [],
            messages: [
              {
                id: 'u1',
                role: 'user',
                blocks: [{ type: 'text', text: 'hi' }],
                createdAt: 1,
              },
            ],
            tools: [],
            maxTokens: 16,
          },
          new AbortController().signal,
        ),
      )
      expect(models).toEqual(['gone/model', 'entitlement/catalog-model'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('catalog coerce falls back to included.defaultModel when entitlement omits it', async () => {
    const originalFetch = globalThis.fetch
    const sse = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const models: string[] = []
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : ''
      const parsed = JSON.parse(raw) as { model?: string }
      models.push(parsed.model ?? '')
      if (parsed.model === 'gone/model') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'unknown model' }), { status: 404 }),
        )
      }
      return Promise.resolve(
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      )
    }) as typeof fetch

    try {
      const cfg = config({
        model: 'local/byok-model',
        included: includedOn({ defaultModel: 'config/included-model' }),
      })
      const access = await resolveIncludedAccess(cfg, { probe: async () => admitted() })
      expect(access.admitted).toBe(true)
      if (access.admitted) expect(access.defaultModel).toBeUndefined()

      const provider = await providerFromConfig(cfg, { access })
      await drainProvider(
        provider.stream(
          {
            model: 'gone/model',
            system: [],
            messages: [
              {
                id: 'u1',
                role: 'user',
                blocks: [{ type: 'text', text: 'hi' }],
                createdAt: 1,
              },
            ],
            tools: [],
            maxTokens: 16,
          },
          new AbortController().signal,
        ),
      )
      expect(models).toEqual(['gone/model', 'config/included-model'])
    } finally {
      globalThis.fetch = originalFetch
    }
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
