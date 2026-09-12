import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultConfig,
  loadConfig,
  loadDotEnv,
  normalizeOpenAiBaseUrl,
  parseConfigYaml,
  resolveProviderModel,
} from './config'

const ENV_KEYS = [
  'RAVENCLAW_HOME',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_BASE_URL',
  'OLLAMA_HOST',
  'OLLAMA_API_KEY',
  'VLLM_BASE_URL',
  'VLLM_API_KEY',
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
    expect(cfg.included).toEqual({ gatewayUrl: '', enabled: false, sessionCapPerDay: 4 })
    expect(cfg.terminal).toBeUndefined()
    expect(cfg.mcp).toEqual({ servers: [] })
    expect(cfg.auxiliary).toBeUndefined()
    expect(cfg.specialistModel).toBeUndefined()
    expect(cfg.tools).toBeUndefined()
    expect(cfg.slack).toBeUndefined()
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
    expect(cfg.included).toEqual({ gatewayUrl: '', enabled: false, sessionCapPerDay: 4 })
    expect(cfg.mcp).toEqual({ servers: [] })
    expect(cfg.home).toBe(home)
  })

  test('empty or absent included.gatewayUrl stays BYOK and does not change inference', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const emptyHome = tempHome()
    writeFileSync(
      join(emptyHome, 'config.yaml'),
      [
        'provider: anthropic',
        'model: anthropic/claude-sonnet-4',
        'included:',
        '  gatewayUrl: ""',
        '',
      ].join('\n'),
    )
    const empty = loadConfig({ home: emptyHome })
    expect(empty.provider).toBe('anthropic')
    expect(empty.included).toEqual({ gatewayUrl: '', enabled: false, sessionCapPerDay: 4 })

    const urlHome = tempHome()
    writeFileSync(
      join(urlHome, 'config.yaml'),
      [
        'included:',
        '  gatewayUrl: https://gw.example.com/v1',
        '',
      ].join('\n'),
    )
    const withUrl = loadConfig({ home: urlHome })
    expect(withUrl.provider).toBe('anthropic')
    expect(withUrl.included).toEqual({
      gatewayUrl: 'https://gw.example.com/v1',
      enabled: false,
      sessionCapPerDay: 4,
    })
    expect(withUrl.env.ANTHROPIC_API_KEY).toBe('sk-ant-test')

    delete process.env.ANTHROPIC_API_KEY
    expect(() => loadConfig({ home: tempHome() })).toThrow(/config\.yaml|API key|OLLAMA_HOST|VLLM_BASE_URL/i)
  })

  test('included.enabled is false by default and yaml overlay works', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const defaults = loadConfig({ home: tempHome() })
    expect(defaults.included).toEqual({ gatewayUrl: '', enabled: false, sessionCapPerDay: 4 })

    const home = tempHome()
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'included:',
        '  gatewayUrl: https://gw.example.com/v1',
        '  enabled: true',
        '  sessionCapPerDay: 8',
        '  defaultModel: openai/gpt-4o',
        '',
      ].join('\n'),
    )
    const overlay = loadConfig({ home })
    expect(overlay.included).toEqual({
      gatewayUrl: 'https://gw.example.com/v1',
      enabled: true,
      sessionCapPerDay: 8,
      defaultModel: 'openai/gpt-4o',
    })
  })

  test('yaml provider ollama loads without cloud API keys', () => {
    const home = tempHome()
    writeFileSync(join(home, 'config.yaml'), 'provider: ollama\nmodel: qwen2.5-coder\n')
    const cfg = loadConfig({ home })
    expect(cfg.provider).toBe('ollama')
    expect(cfg.model).toBe('qwen2.5-coder')
  })

  test('OLLAMA_HOST in .env infers ollama', () => {
    const home = tempHome()
    writeFileSync(join(home, '.env'), 'OLLAMA_HOST=127.0.0.1:11434\n')
    const cfg = loadConfig({ home })
    expect(cfg.provider).toBe('ollama')
    expect(cfg.model).toBe('llama3.2')
    expect(cfg.env.OLLAMA_HOST).toBe('127.0.0.1:11434')
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

  test('yaml auxiliary, specialistModel, and tools.network flow into resolved config', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const home = tempHome()
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'provider: anthropic',
        'model: anthropic/claude-sonnet-4',
        'auxiliary:',
        '  compact: anthropic/claude-haiku-4.5',
        '  title: anthropic/claude-haiku-4.5',
        'specialistModel: ollama/qwen',
        'tools:',
        '  network: true',
        '',
      ].join('\n'),
    )
    const cfg = loadConfig({ home })
    expect(cfg.auxiliary).toEqual({
      compact: 'anthropic/claude-haiku-4.5',
      title: 'anthropic/claude-haiku-4.5',
    })
    expect(cfg.specialistModel).toBe('ollama/qwen')
    expect(cfg.tools).toEqual({ network: true })
  })

  test('yaml mcp.servers flows into resolved config', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const home = tempHome()
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'provider: anthropic',
        'mcp:',
        '  servers:',
        '    - name: filesystem',
        '      command: npx',
        '      args: ["-y", "@modelcontextprotocol/server-filesystem", "."]',
        '      env: { FOO: "bar" }',
        '',
      ].join('\n'),
    )
    const cfg = loadConfig({ home })
    expect(cfg.mcp.servers).toEqual([
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        env: { FOO: 'bar' },
      },
    ])
  })

  test('yaml slack block defaults fail closed and interpolates $ENV tokens', () => {
    const savedApp = process.env.SLACK_APP_TOKEN
    const savedBot = process.env.SLACK_BOT_TOKEN
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    process.env.SLACK_APP_TOKEN = 'xapp-from-env'
    process.env.SLACK_BOT_TOKEN = 'xoxb-from-env'
    try {
      const home = tempHome()
      writeFileSync(
        join(home, 'config.yaml'),
        [
          'provider: anthropic',
          'slack:',
          '  enabled: true',
          '  appToken: $SLACK_APP_TOKEN',
          '  botToken: ${SLACK_BOT_TOKEN}',
          '  allowFrom:',
          '    - U1',
          '  channels:',
          '    - C1',
          '',
        ].join('\n'),
      )
      const cfg = loadConfig({ home })
      expect(cfg.slack).toEqual({
        enabled: true,
        appToken: 'xapp-from-env',
        botToken: 'xoxb-from-env',
        allowFrom: ['U1'],
        channels: ['C1'],
        mentionOnly: true,
      })
    } finally {
      if (savedApp === undefined) delete process.env.SLACK_APP_TOKEN
      else process.env.SLACK_APP_TOKEN = savedApp
      if (savedBot === undefined) delete process.env.SLACK_BOT_TOKEN
      else process.env.SLACK_BOT_TOKEN = savedBot
    }
  })

  test('slack enabled defaults false; empty allowFrom/channels deny/DM-only', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const home = tempHome()
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'provider: anthropic',
        'slack:',
        '  appToken: xapp-literal',
        '  botToken: xoxb-literal',
        '',
      ].join('\n'),
    )
    const cfg = loadConfig({ home })
    expect(cfg.slack).toEqual({
      enabled: false,
      appToken: 'xapp-literal',
      botToken: 'xoxb-literal',
      allowFrom: [],
      channels: [],
      mentionOnly: true,
    })
  })

  test('slack tokens fall back to .env when yaml omits them', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const home = tempHome()
    writeFileSync(join(home, 'config.yaml'), ['provider: anthropic', 'slack:', '  enabled: true', ''].join('\n'))
    writeFileSync(join(home, '.env'), 'SLACK_APP_TOKEN=xapp-file\nSLACK_BOT_TOKEN=xoxb-file\n')
    const cfg = loadConfig({ home })
    expect(cfg.slack?.appToken).toBe('xapp-file')
    expect(cfg.slack?.botToken).toBe('xoxb-file')
    expect(cfg.slack?.enabled).toBe(true)
  })

  test('yaml discord block defaults mentionOnly true and resolves DISCORD_BOT_TOKEN from .env', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const home = tempHome()
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'provider: anthropic',
        'discord:',
        '  enabled: true',
        '  allowFrom:',
        '    - U1',
        '  channels:',
        '    - C1',
        '',
      ].join('\n'),
    )
    writeFileSync(join(home, '.env'), 'DISCORD_BOT_TOKEN=tok\n')
    const cfg = loadConfig({ home })
    expect(cfg.discord).toEqual({
      enabled: true,
      token: 'tok',
      allowFrom: ['U1'],
      channels: ['C1'],
      mentionOnly: true,
    })
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

  test('OLLAMA_HOST infers ollama and default model llama3.2', () => {
    const resolved = resolveProviderModel({
      config: {},
      env: { OLLAMA_HOST: 'http://127.0.0.1:11434' },
    })
    expect(resolved).toEqual({ provider: 'ollama', model: 'llama3.2' })
  })

  test('VLLM_BASE_URL infers vllm and default model local-model', () => {
    const resolved = resolveProviderModel({
      config: {},
      env: { VLLM_BASE_URL: 'http://127.0.0.1:8000/v1' },
    })
    expect(resolved).toEqual({ provider: 'vllm', model: 'local-model' })
  })

  test('yaml provider ollama wins without cloud keys', () => {
    const resolved = resolveProviderModel({
      config: { provider: 'ollama', model: 'qwen2.5-coder' },
      env: {},
    })
    expect(resolved).toEqual({ provider: 'ollama', model: 'qwen2.5-coder' })
  })
})

describe('normalizeOpenAiBaseUrl', () => {
  test('adds http and /v1', () => {
    expect(normalizeOpenAiBaseUrl('127.0.0.1:11434')).toBe('http://127.0.0.1:11434/v1')
    expect(normalizeOpenAiBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434/v1')
    expect(normalizeOpenAiBaseUrl('http://localhost:8000/v1')).toBe('http://localhost:8000/v1')
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

  test('parses included.gatewayUrl including quoted empty', () => {
    const empty = parseConfigYaml(['included:', '  gatewayUrl: ""', ''].join('\n'))
    expect(empty.included).toEqual({ gatewayUrl: '' })
    const set = parseConfigYaml(
      ['included:', '  gatewayUrl: https://gw.example.com/v1', ''].join('\n'),
    )
    expect(set.included).toEqual({ gatewayUrl: 'https://gw.example.com/v1' })
  })

  test('parses included.enabled, sessionCapPerDay, and defaultModel', () => {
    const parsed = parseConfigYaml(
      [
        'included:',
        '  gatewayUrl: https://gw.example.com/v1',
        '  enabled: true',
        '  sessionCapPerDay: 8',
        '  defaultModel: openai/gpt-4o',
        '',
      ].join('\n'),
    )
    expect(parsed.included).toEqual({
      gatewayUrl: 'https://gw.example.com/v1',
      enabled: true,
      sessionCapPerDay: 8,
      defaultModel: 'openai/gpt-4o',
    })
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

  test('parses mcp.servers with name, command, optional args and env', () => {
    const parsed = parseConfigYaml(
      [
        'mcp:',
        '  servers:',
        '    - name: filesystem',
        '      command: npx',
        '      args: ["-y", "@modelcontextprotocol/server-filesystem", "."]',
        '      env: { FOO: "bar" }',
        '    - name: git',
        '      command: uvx',
        '      args:',
        '        - mcp-server-git',
        '',
      ].join('\n'),
    )
    expect(parsed.mcp?.servers).toEqual([
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        env: { FOO: 'bar' },
      },
      {
        name: 'git',
        command: 'uvx',
        args: ['mcp-server-git'],
      },
    ])
  })

  test('absent mcp key is left unset so loadConfig defaults to no servers', () => {
    const parsed = parseConfigYaml('model: anthropic/claude-sonnet-4\n')
    expect(parsed.mcp).toBeUndefined()
  })

  test('parses mcp http/sse servers by url', () => {
    const parsed = parseConfigYaml(
      [
        'mcp:',
        '  servers:',
        '    - name: remote',
        '      type: http',
        '      url: https://example.com/mcp',
        '      headers: { Authorization: "Bearer tok" }',
        '    - name: events',
        '      type: sse',
        '      url: https://example.com/sse',
        '',
      ].join('\n'),
    )
    expect(parsed.mcp?.servers).toEqual([
      {
        name: 'remote',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer tok' },
      },
      {
        name: 'events',
        type: 'sse',
        url: 'https://example.com/sse',
      },
    ])
  })

  test('parses mcp server tools and excludeTools', () => {
    const parsed = parseConfigYaml(
      [
        'mcp:',
        '  servers:',
        '    - name: filesystem',
        '      command: npx',
        '      tools: [read_file, list_dir]',
        '      excludeTools: [write_file]',
        '    - name: git',
        '      command: uvx',
        '      tools:',
        '        - git_status',
        '      excludeTools:',
        '        - git_push',
        '',
      ].join('\n'),
    )
    expect(parsed.mcp?.servers).toEqual([
      {
        name: 'filesystem',
        command: 'npx',
        tools: ['read_file', 'list_dir'],
        excludeTools: ['write_file'],
      },
      {
        name: 'git',
        command: 'uvx',
        tools: ['git_status'],
        excludeTools: ['git_push'],
      },
    ])
  })

  test('parses auxiliary compact/title, specialistModel, and tools.network', () => {
    const parsed = parseConfigYaml(
      [
        'auxiliary:',
        '  compact: anthropic/claude-haiku-4.5',
        '  title: anthropic/claude-haiku-4.5',
        'specialistModel: ollama/qwen',
        'tools:',
        '  network: true',
        '',
      ].join('\n'),
    )
    expect(parsed.auxiliary).toEqual({
      compact: 'anthropic/claude-haiku-4.5',
      title: 'anthropic/claude-haiku-4.5',
    })
    expect(parsed.specialistModel).toBe('ollama/qwen')
    expect(parsed.tools).toEqual({ network: true })
  })

  test('absent auxiliary, specialistModel, and tools stay unset', () => {
    const parsed = parseConfigYaml('model: anthropic/claude-sonnet-4\n')
    expect(parsed.auxiliary).toBeUndefined()
    expect(parsed.specialistModel).toBeUndefined()
    expect(parsed.tools).toBeUndefined()
  })

  test('parses review.background and defaults it off', () => {
    expect(parseConfigYaml('model: anthropic/claude-sonnet-4\n').review).toBeUndefined()
    expect(parseConfigYaml(['review:', '  background: true', ''].join('\n')).review).toEqual({
      background: true,
    })
    expect(parseConfigYaml(['review:', '  background: false', ''].join('\n')).review).toEqual({
      background: false,
    })
  })

  test('skips mcp servers that lack name or command', () => {
    const parsed = parseConfigYaml(
      [
        'mcp:',
        '  servers:',
        '    - name: only-name',
        '    - command: only-command',
        '    - name: ok',
        '      command: npx',
        '',
      ].join('\n'),
    )
    expect(parsed.mcp?.servers).toEqual([{ name: 'ok', command: 'npx' }])
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
