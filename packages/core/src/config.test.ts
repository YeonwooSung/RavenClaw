import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultConfig,
  loadConfig,
  loadDotEnv,
  parseConfigYaml,
  resolveProviderModel,
} from './config'

const ENV_KEYS = [
  'RAVENCLAW_HOME',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_BASE_URL',
] as const

let savedEnv: Record<string, string | undefined>
const tempDirs: string[] = []

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-config-'))
  tempDirs.push(dir)
  return dir
}

describe('defaultConfig', () => {
  test('matches documented defaults including empty ads.feedUrl', () => {
    const cfg = defaultConfig()
    expect(cfg.model).toBe('anthropic/claude-sonnet-4')
    expect(cfg.provider).toBe('anthropic')
    expect(cfg.permissionMode).toBe('default')
    expect(cfg.maxRounds).toBe(80)
    expect(cfg.childMaxRounds).toBe(30)
    expect(cfg.compact).toEqual({ enabled: true, llmSummarize: true })
    expect(cfg.ads.feedUrl).toBe('')
    expect(cfg.terminal).toBeUndefined()
  })
})

describe('loadConfig', () => {
  test('missing files use defaults', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const home = tempHome()
    const cfg = loadConfig({ home })
    expect(cfg.model).toBe('anthropic/claude-sonnet-4')
    expect(cfg.provider).toBe('anthropic')
    expect(cfg.maxRounds).toBe(80)
    expect(cfg.childMaxRounds).toBe(30)
    expect(cfg.permissionMode).toBe('default')
    expect(cfg.ads.feedUrl).toBe('')
    expect(cfg.home).toBe(home)
  })

  test('empty ads.feedUrl stays empty from defaults and from yaml', () => {
    const fromDefaults = defaultConfig()
    expect(fromDefaults.ads.feedUrl).toBe('')
    expect(fromDefaults.ads.feedUrl).not.toMatch(/^https?:/)

    const home = tempHome()
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'provider: anthropic',
        'model: anthropic/claude-sonnet-4',
        'ads:',
        '  feedUrl: ""',
        '',
      ].join('\n'),
    )
    const cfg = loadConfig({ home })
    expect(cfg.ads.feedUrl).toBe('')
    expect(cfg.ads.feedUrl).not.toMatch(/^https?:/)
  })

  test('flags.model and flags.provider win over yaml', () => {
    const home = tempHome()
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'provider: anthropic',
        'model: anthropic/claude-sonnet-4',
        '',
      ].join('\n'),
    )
    const cfg = loadConfig({
      home,
      flags: { provider: 'openai_compat', model: 'openai/gpt-4o' },
    })
    expect(cfg.provider).toBe('openai_compat')
    expect(cfg.model).toBe('openai/gpt-4o')
    expect(cfg.profile.id).toBe('openai/gpt-4o')
  })

  test('yaml provider wins over env keys', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-stale'
    const home = tempHome()
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'provider: anthropic',
        'model: anthropic/claude-sonnet-4',
        '',
      ].join('\n'),
    )
    const cfg = loadConfig({ home })
    expect(cfg.provider).toBe('anthropic')
    expect(cfg.model).toBe('anthropic/claude-sonnet-4')
    expect(cfg.env.OPENAI_API_KEY).toBe('sk-openai-stale')
  })

  test('no flags, no yaml, only OPENAI_API_KEY → openai_compat', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-only'
    const cfg = loadConfig({ home: tempHome() })
    expect(cfg.provider).toBe('openai_compat')
    expect(cfg.env.OPENAI_API_KEY).toBe('sk-openai-only')
  })

  test('no flags, no yaml, only ANTHROPIC_API_KEY → anthropic', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-only'
    const cfg = loadConfig({ home: tempHome() })
    expect(cfg.provider).toBe('anthropic')
    expect(cfg.env.ANTHROPIC_API_KEY).toBe('sk-ant-only')
  })

  test('no flags, no yaml, no keys → throws setup hint', () => {
    expect(() => loadConfig({ home: tempHome() })).toThrow(/config\.yaml|API key/i)
  })

  test('flags.dontAsk forces dontAsk over yaml permissionMode', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const home = tempHome()
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'provider: anthropic',
        'permissionMode: acceptEdits',
        '',
      ].join('\n'),
    )
    const cfg = loadConfig({ home, flags: { dontAsk: true } })
    expect(cfg.permissionMode).toBe('dontAsk')
  })

  test('yaml compact flags + prices/contextWindow flow into profile', () => {
    const home = tempHome()
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'provider: anthropic',
        'model: anthropic/claude-sonnet-4',
        'compact:',
        '  enabled: false',
        '  llmSummarize: false',
        'contextWindow: 50000',
        'prices:',
        '  anthropic/claude-sonnet-4:',
        '    input: 1.25',
        '    output: 6.5',
        '',
      ].join('\n'),
    )
    const cfg = loadConfig({ home })
    expect(cfg.compact.enabled).toBe(false)
    expect(cfg.compact.llmSummarize).toBe(false)
    expect(cfg.contextWindow).toBe(50_000)
    expect(cfg.profile.id).toBe('anthropic/claude-sonnet-4')
    expect(cfg.profile.contextWindow).toBe(50_000)
    expect(cfg.profile.reserveOutputTokens).toBe(5_000)
    expect(cfg.profile.inputUsdPerMTok).toBe(1.25)
    expect(cfg.profile.outputUsdPerMTok).toBe(6.5)
    expect(cfg.profile.cacheReadUsdPerMTok).toBe(0.3)
    expect(cfg.profile.supportsThinking).toBe(true)
  })

  test('.env loads ANTHROPIC_API_KEY without putting it in ads or model fields', () => {
    const home = tempHome()
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'provider: anthropic',
        'model: anthropic/claude-sonnet-4',
        'ads:',
        '  feedUrl: ""',
        '',
      ].join('\n'),
    )
    writeFileSync(join(home, '.env'), 'ANTHROPIC_API_KEY="sk-from-dotenv"\n')
    const cfg = loadConfig({ home })
    expect(cfg.env.ANTHROPIC_API_KEY).toBe('sk-from-dotenv')
    expect(cfg.ads.feedUrl).toBe('')
    expect(cfg.model).toBe('anthropic/claude-sonnet-4')
    expect(cfg.ads.feedUrl).not.toContain('sk-from-dotenv')
    expect(cfg.model).not.toContain('sk-from-dotenv')
  })

  test('yaml terminal.backend docker + image is preserved', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const home = tempHome()
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'provider: anthropic',
        'model: anthropic/claude-sonnet-4',
        'terminal:',
        '  backend: docker',
        '  image: bash:5',
        '',
      ].join('\n'),
    )
    const cfg = loadConfig({ home })
    expect(cfg.terminal).toEqual({ backend: 'docker', image: 'bash:5' })
  })
})

describe('resolveProviderModel', () => {
  test('OPENAI_BASE_URL alone infers openai_compat', () => {
    const resolved = resolveProviderModel({
      config: {},
      env: { OPENAI_BASE_URL: 'http://127.0.0.1:8080/v1' },
    })
    expect(resolved.provider).toBe('openai_compat')
  })
})

describe('parseConfigYaml', () => {
  test('parses quoted empty feedUrl and nested maps', () => {
    const parsed = parseConfigYaml(
      [
        'ads:',
        '  feedUrl: ""',
        'compact:',
        '  enabled: true',
        '  llmSummarize: false',
        '',
      ].join('\n'),
    )
    expect(parsed.ads?.feedUrl).toBe('')
    expect(parsed.compact?.enabled).toBe(true)
    expect(parsed.compact?.llmSummarize).toBe(false)
  })

  test('parses terminal.backend docker and terminal.image', () => {
    const parsed = parseConfigYaml(
      [
        'terminal:',
        '  backend: docker',
        '  image: alpine:3.20',
        '',
      ].join('\n'),
    )
    expect(parsed.terminal).toEqual({ backend: 'docker', image: 'alpine:3.20' })
  })
})

describe('loadDotEnv', () => {
  test('parses KEY=VALUE, comments, blanks, and optional quotes', () => {
    const env = loadDotEnv(
      [
        '# comment',
        '',
        'ANTHROPIC_API_KEY="sk-quoted"',
        'OPENAI_API_KEY=sk-plain',
        "OPENAI_BASE_URL='http://localhost'",
        'IGNORED=nope',
        '',
      ].join('\n'),
    )
    expect(env.ANTHROPIC_API_KEY).toBe('sk-quoted')
    expect(env.OPENAI_API_KEY).toBe('sk-plain')
    expect(env.OPENAI_BASE_URL).toBe('http://localhost')
    expect(env.IGNORED).toBe('nope')
  })
})
