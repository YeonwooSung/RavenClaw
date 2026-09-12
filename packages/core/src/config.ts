import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getModelProfile } from './cost/models'
import { ravenclawHome } from './home'
import type { ModelProfile, PermissionMode } from './types'

export type ProviderKind = 'anthropic' | 'openai_compat' | 'ollama' | 'vllm'

export type TerminalBackendKind = 'local' | 'docker'

export interface TerminalConfig {
  backend: TerminalBackendKind
  image?: string
}

export interface IncludedConfig {
  gatewayUrl: string
  enabled?: boolean
  sessionCapPerDay?: number
  defaultModel?: string
}

export type McpTransportKind = 'stdio' | 'http' | 'sse'

export interface McpServerConfig {
  name: string
  type?: McpTransportKind
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** If set, only these server-native tool names are loaded. */
  tools?: string[]
  /** Applied after `tools`. */
  excludeTools?: string[]
  oauth?: McpOAuthConfig
}

export interface McpOAuthConfig {
  clientId: string
  scope?: string
  redirectPort?: number
  authorizationUrl?: string
  tokenUrl?: string
}

export interface McpConfig {
  servers: McpServerConfig[]
}

export interface AuxiliaryConfig {
  compact?: string
  title?: string
}

export interface ToolsConfig {
  network?: boolean
}

export interface ReviewConfig {
  background?: boolean
}

export interface SlackConfig {
  enabled: boolean
  appToken: string
  botToken: string
  allowFrom: string[]
  channels: string[]
  mentionOnly: boolean
}

export interface DiscordConfig {
  enabled: boolean
  token: string
  allowFrom: string[]
  channels: string[]
  mentionOnly: boolean
}

export interface RavenClawConfig {
  model: string
  provider: ProviderKind
  permissionMode: PermissionMode
  maxRounds: number
  childMaxRounds: number
  compact: { enabled: boolean; llmSummarize: boolean }
  ads: { feedUrl: string }
  included?: IncludedConfig
  contextWindow?: number
  prices?: Record<string, ModelPriceFields>
  terminal?: TerminalConfig
  mcp: McpConfig
  auxiliary?: AuxiliaryConfig
  specialistModel?: string
  tools?: ToolsConfig
  slack?: SlackConfig
  discord?: DiscordConfig
  review?: ReviewConfig
}

export interface ModelPriceFields {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

export interface ConfigFlags {
  provider?: ProviderKind
  model?: string
  permissionMode?: PermissionMode
  dontAsk?: boolean
  fallbackModel?: string
  allowedTools?: string[]
  worktree?: boolean | string
  jsonSchema?: string
  agent?: string
  bare?: boolean
  addDir?: string[]
  cwd?: string
  effort?: string
  listen?: string
  verifyOnStop?: boolean
}

export interface ResolvedEnv {
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  OPENAI_BASE_URL?: string
  OLLAMA_HOST?: string
  OLLAMA_API_KEY?: string
  VLLM_BASE_URL?: string
  VLLM_API_KEY?: string
  RAVENCLAW_INCLUDED_TOKEN?: string
}

export interface ResolvedConfig extends RavenClawConfig {
  home: string
  env: ResolvedEnv
  profile: ModelProfile
  fallbackModel?: string
  allowedTools?: string[]
  jsonSchema?: string
  agent?: string
  bare?: boolean
  addDir?: string[]
  effort?: string
}

const PROVIDERS = new Set<ProviderKind>(['anthropic', 'openai_compat', 'ollama', 'vllm'])

export const OLLAMA_DEFAULT_HOST = 'http://127.0.0.1:11434'
export const OLLAMA_DEFAULT_MODEL = 'llama3.2'
export const VLLM_DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1'
export const VLLM_DEFAULT_MODEL = 'local-model'
const PERMISSION_MODES = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
])
const TERMINAL_BACKENDS = new Set<TerminalBackendKind>(['local', 'docker'])

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_BASE_URL',
  'OLLAMA_HOST',
  'OLLAMA_API_KEY',
  'VLLM_BASE_URL',
  'VLLM_API_KEY',
  'RAVENCLAW_INCLUDED_TOKEN',
] as const

export function defaultConfig(): RavenClawConfig {
  return {
    model: 'anthropic/claude-sonnet-4',
    provider: 'anthropic',
    permissionMode: 'default',
    maxRounds: 80,
    childMaxRounds: 30,
    compact: { enabled: true, llmSummarize: true },
    ads: { feedUrl: '' },
    included: { gatewayUrl: '', enabled: false, sessionCapPerDay: 4 },
    mcp: { servers: [] },
  }
}

export function parseConfigYaml(text: string): Partial<RavenClawConfig> {
  const raw = parseYamlMap(text)
  const out: Partial<RavenClawConfig> = {}

  const model = asString(raw.model)
  if (model !== undefined) out.model = model

  const provider = asString(raw.provider)
  if (provider !== undefined && isProviderKind(provider)) out.provider = provider

  const permissionMode = asString(raw.permissionMode)
  if (permissionMode !== undefined && isPermissionMode(permissionMode)) {
    out.permissionMode = permissionMode
  }

  const maxRounds = asNumber(raw.maxRounds)
  if (maxRounds !== undefined) out.maxRounds = maxRounds

  const childMaxRounds = asNumber(raw.childMaxRounds)
  if (childMaxRounds !== undefined) out.childMaxRounds = childMaxRounds

  const compactRaw = asMap(raw.compact)
  if (compactRaw) {
    const compact: { enabled: boolean; llmSummarize: boolean } = {
      enabled: defaultConfig().compact.enabled,
      llmSummarize: defaultConfig().compact.llmSummarize,
    }
    const enabled = asBoolean(compactRaw.enabled)
    if (enabled !== undefined) compact.enabled = enabled
    const llmSummarize = asBoolean(compactRaw.llmSummarize)
    if (llmSummarize !== undefined) compact.llmSummarize = llmSummarize
    out.compact = compact
  }

  const adsRaw = asMap(raw.ads)
  if (adsRaw) {
    const feedUrl = adsRaw.feedUrl
    out.ads = { feedUrl: feedUrl === undefined || feedUrl === null ? '' : String(feedUrl) }
  }

  const includedRaw = asMap(raw.included)
  if (includedRaw) {
    const gatewayUrl = includedRaw.gatewayUrl
    const included: IncludedConfig = {
      gatewayUrl: gatewayUrl === undefined || gatewayUrl === null ? '' : String(gatewayUrl),
    }
    const enabled = asBoolean(includedRaw.enabled)
    if (enabled !== undefined) included.enabled = enabled
    const sessionCapPerDay = asNumber(includedRaw.sessionCapPerDay)
    if (sessionCapPerDay !== undefined) included.sessionCapPerDay = sessionCapPerDay
    const defaultModel = asString(includedRaw.defaultModel)
    if (defaultModel !== undefined) included.defaultModel = defaultModel
    out.included = included
  }

  const terminalRaw = asMap(raw.terminal)
  if (terminalRaw) {
    const backend = asString(terminalRaw.backend)
    if (backend !== undefined && isTerminalBackendKind(backend)) {
      const terminal: TerminalConfig = { backend }
      const image = asString(terminalRaw.image)
      if (image !== undefined && image !== '') terminal.image = image
      out.terminal = terminal
    }
  }

  const mcpRaw = asMap(raw.mcp)
  if (mcpRaw) out.mcp = parseMcpConfig(mcpRaw)

  const contextWindow = asNumber(raw.contextWindow)
  if (contextWindow !== undefined) out.contextWindow = contextWindow

  const pricesRaw = asMap(raw.prices)
  if (pricesRaw) {
    const prices: Record<string, ModelPriceFields> = {}
    for (const [id, value] of Object.entries(pricesRaw)) {
      const fields = asMap(value)
      if (!fields) continue
      const entry: ModelPriceFields = {}
      const input = asNumber(fields.input)
      if (input !== undefined) entry.input = input
      const output = asNumber(fields.output)
      if (output !== undefined) entry.output = output
      const cacheRead = asNumber(fields.cacheRead)
      if (cacheRead !== undefined) entry.cacheRead = cacheRead
      const cacheWrite = asNumber(fields.cacheWrite)
      if (cacheWrite !== undefined) entry.cacheWrite = cacheWrite
      prices[id] = entry
    }
    out.prices = prices
  }

  const auxiliaryRaw = asMap(raw.auxiliary)
  if (auxiliaryRaw) {
    const auxiliary: AuxiliaryConfig = {}
    const compactModel = asString(auxiliaryRaw.compact)
    if (compactModel !== undefined) auxiliary.compact = compactModel
    const titleModel = asString(auxiliaryRaw.title)
    if (titleModel !== undefined) auxiliary.title = titleModel
    out.auxiliary = auxiliary
  }

  const specialistModel = asString(raw.specialistModel)
  if (specialistModel !== undefined) out.specialistModel = specialistModel

  const toolsRaw = asMap(raw.tools)
  if (toolsRaw) {
    const tools: ToolsConfig = {}
    const network = asBoolean(toolsRaw.network)
    if (network !== undefined) tools.network = network
    out.tools = tools
  }

  const slackRaw = asMap(raw.slack)
  if (slackRaw) out.slack = parseSlackConfig(slackRaw)

  const discordRaw = asMap(raw.discord)
  if (discordRaw) out.discord = parseDiscordConfig(discordRaw)

  const reviewRaw = asMap(raw.review)
  if (reviewRaw) {
    out.review = { background: asBoolean(reviewRaw.background) === true }
  }

  return out
}

export function loadDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const trimmed = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    out[key] = stripWrappingQuotes(trimmed.slice(eq + 1).trim())
  }
  return out
}

export function resolveProviderModel(opts: {
  flags?: ConfigFlags
  config: Partial<Pick<RavenClawConfig, 'provider' | 'model'>>
  env: ResolvedEnv
}): { provider: ProviderKind; model: string } {
  const provider =
    opts.flags?.provider ?? opts.config.provider ?? inferProviderFromEnv(opts.env)
  if (provider === undefined) {
    throw new Error(
      'No provider configured. Set provider in config.yaml (anthropic | openai_compat | ollama | vllm) or export ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_HOST / VLLM_BASE_URL.',
    )
  }
  const model =
    opts.flags?.model ?? opts.config.model ?? defaultModelForProvider(provider)
  return { provider, model }
}

export function defaultModelForProvider(provider: ProviderKind): string {
  if (provider === 'ollama') return OLLAMA_DEFAULT_MODEL
  if (provider === 'vllm') return VLLM_DEFAULT_MODEL
  return defaultConfig().model
}

export function normalizeOpenAiBaseUrl(raw: string): string {
  let url = raw.trim()
  if (url === '') return url
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) url = `http://${url}`
  url = url.replace(/\/+$/, '')
  if (!url.endsWith('/v1')) url = `${url}/v1`
  return url
}

export function loadConfig(opts?: { home?: string; flags?: ConfigFlags }): ResolvedConfig {
  const home = opts?.home ?? ravenclawHome()
  const flags = opts?.flags
  const yamlText = readIfExists(join(home, 'config.yaml'))
  const parsed = yamlText === undefined ? {} : parseConfigYaml(yamlText)
  const fileEnv = loadDotEnv(readIfExists(join(home, '.env')) ?? '')
  const env = resolveEnv(fileEnv)
  const { provider, model } = resolveProviderModel({
    flags,
    config: pickedProviderModel(parsed),
    env,
  })

  const base = defaultConfig()
  const permissionMode = flags?.dontAsk
    ? 'dontAsk'
    : (flags?.permissionMode ?? parsed.permissionMode ?? base.permissionMode)

  const resolved: ResolvedConfig = {
    model,
    provider,
    permissionMode,
    maxRounds: parsed.maxRounds ?? base.maxRounds,
    childMaxRounds: parsed.childMaxRounds ?? base.childMaxRounds,
    compact: {
      enabled: parsed.compact?.enabled ?? base.compact.enabled,
      llmSummarize: parsed.compact?.llmSummarize ?? base.compact.llmSummarize,
    },
    ads: { feedUrl: parsed.ads?.feedUrl ?? base.ads.feedUrl },
    included: resolveIncluded(parsed.included, base.included),
    mcp: { servers: parsed.mcp?.servers ?? base.mcp.servers },
    home,
    env,
    profile: getModelProfile(model, profileOverrides(model, parsed)),
  }
  if (parsed.contextWindow !== undefined) resolved.contextWindow = parsed.contextWindow
  if (parsed.prices !== undefined) resolved.prices = parsed.prices
  if (parsed.terminal !== undefined) resolved.terminal = parsed.terminal
  if (parsed.auxiliary !== undefined) resolved.auxiliary = parsed.auxiliary
  if (parsed.specialistModel !== undefined) resolved.specialistModel = parsed.specialistModel
  if (parsed.tools !== undefined) resolved.tools = parsed.tools
  if (parsed.slack !== undefined) resolved.slack = resolveSlackConfig(parsed.slack, fileEnv)
  if (parsed.discord !== undefined) resolved.discord = resolveDiscordConfig(parsed.discord, fileEnv)
  if (parsed.review !== undefined) resolved.review = parsed.review
  if (flags?.fallbackModel !== undefined) resolved.fallbackModel = flags.fallbackModel
  if (flags?.allowedTools !== undefined && flags.allowedTools.length > 0) {
    resolved.allowedTools = flags.allowedTools
  }
  if (flags?.jsonSchema !== undefined) resolved.jsonSchema = flags.jsonSchema
  if (flags?.agent !== undefined) resolved.agent = flags.agent
  if (flags?.bare === true) resolved.bare = true
  if (flags?.addDir !== undefined && flags.addDir.length > 0) resolved.addDir = flags.addDir
  if (flags?.effort !== undefined) resolved.effort = flags.effort
  return resolved
}

function resolveIncluded(
  parsed: IncludedConfig | undefined,
  base: IncludedConfig | undefined,
): IncludedConfig {
  const included: IncludedConfig = {
    gatewayUrl: parsed?.gatewayUrl ?? base?.gatewayUrl ?? '',
    enabled: parsed?.enabled ?? base?.enabled ?? false,
    sessionCapPerDay: parsed?.sessionCapPerDay ?? base?.sessionCapPerDay ?? 4,
  }
  const defaultModel = parsed?.defaultModel ?? base?.defaultModel
  if (defaultModel !== undefined && defaultModel !== '') included.defaultModel = defaultModel
  return included
}

function pickedProviderModel(
  parsed: Partial<RavenClawConfig>,
): Partial<Pick<RavenClawConfig, 'provider' | 'model'>> {
  const out: Partial<Pick<RavenClawConfig, 'provider' | 'model'>> = {}
  if (parsed.provider !== undefined) out.provider = parsed.provider
  if (parsed.model !== undefined) out.model = parsed.model
  return out
}

function profileOverrides(
  model: string,
  parsed: Partial<RavenClawConfig>,
): { contextWindow?: number; prices?: ModelPriceFields } | undefined {
  const out: { contextWindow?: number; prices?: ModelPriceFields } = {}
  if (parsed.contextWindow !== undefined) out.contextWindow = parsed.contextWindow
  const prices = parsed.prices?.[model]
  if (prices !== undefined) out.prices = prices
  if (out.contextWindow === undefined && out.prices === undefined) return undefined
  return out
}

function resolveEnv(fileEnv: Record<string, string>): ResolvedEnv {
  const env: ResolvedEnv = {}
  for (const key of ENV_KEYS) {
    const value = firstNonEmpty(process.env[key], fileEnv[key])
    if (value !== undefined) env[key] = value
  }
  return env
}

function inferProviderFromEnv(env: ResolvedEnv): ProviderKind | undefined {
  if (firstNonEmpty(env.ANTHROPIC_API_KEY) !== undefined) return 'anthropic'
  if (firstNonEmpty(env.OLLAMA_HOST, env.OLLAMA_API_KEY) !== undefined) return 'ollama'
  if (firstNonEmpty(env.VLLM_BASE_URL, env.VLLM_API_KEY) !== undefined) return 'vllm'
  if (
    firstNonEmpty(env.OPENAI_API_KEY) !== undefined ||
    firstNonEmpty(env.OPENAI_BASE_URL) !== undefined
  ) {
    return 'openai_compat'
  }
  return undefined
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function readIfExists(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf8')
}

function isProviderKind(value: string): value is ProviderKind {
  return PROVIDERS.has(value as ProviderKind)
}

function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODES.has(value as PermissionMode)
}

function isTerminalBackendKind(value: string): value is TerminalBackendKind {
  return TERMINAL_BACKENDS.has(value as TerminalBackendKind)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asMap(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') out.push(item)
    else if (typeof item === 'number' && Number.isFinite(item)) out.push(String(item))
  }
  return out
}

function parseSlackConfig(raw: Record<string, unknown>): SlackConfig {
  return {
    enabled: asBoolean(raw.enabled) ?? false,
    appToken: asString(raw.appToken) ?? '',
    botToken: asString(raw.botToken) ?? '',
    allowFrom: asStringList(raw.allowFrom) ?? [],
    channels: asStringList(raw.channels) ?? [],
    mentionOnly: asBoolean(raw.mentionOnly) ?? true,
  }
}

function resolveSlackConfig(slack: SlackConfig, fileEnv: Record<string, string>): SlackConfig {
  return {
    ...slack,
    appToken: resolveSecretRef(slack.appToken, 'SLACK_APP_TOKEN', fileEnv),
    botToken: resolveSecretRef(slack.botToken, 'SLACK_BOT_TOKEN', fileEnv),
  }
}

function parseDiscordConfig(raw: Record<string, unknown>): DiscordConfig {
  return {
    enabled: asBoolean(raw.enabled) ?? false,
    token: asString(raw.token) ?? '',
    allowFrom: asStringList(raw.allowFrom) ?? [],
    channels: asStringList(raw.channels) ?? [],
    mentionOnly: asBoolean(raw.mentionOnly) ?? true,
  }
}

function resolveDiscordConfig(discord: DiscordConfig, fileEnv: Record<string, string>): DiscordConfig {
  return {
    ...discord,
    token: resolveSecretRef(discord.token, 'DISCORD_BOT_TOKEN', fileEnv),
  }
}

function resolveSecretRef(
  value: string,
  fallbackKey: string,
  fileEnv: Record<string, string>,
): string {
  const expanded = expandEnvRef(value, fileEnv)
  if (expanded !== '') return expanded
  return firstNonEmpty(process.env[fallbackKey], fileEnv[fallbackKey]) ?? ''
}

function expandEnvRef(value: string, fileEnv: Record<string, string>): string {
  const trimmed = value.trim()
  const match =
    /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed) ??
    /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed)
  if (!match) return trimmed
  const key = match[1]
  if (key === undefined) return ''
  return firstNonEmpty(process.env[key], fileEnv[key]) ?? ''
}

function parseMcpConfig(raw: Record<string, unknown>): McpConfig {
  const servers: McpServerConfig[] = []
  if (Array.isArray(raw.servers)) {
    for (const item of raw.servers) {
      const rec = asMap(item)
      if (!rec) continue
      const parsed = parseMcpServer(rec)
      if (parsed) servers.push(parsed)
    }
  }
  return { servers }
}

function parseMcpServer(rec: Record<string, unknown>): McpServerConfig | undefined {
  const name = asString(rec.name)
  if (name === undefined || name === '') return undefined
  const typeRaw = asString(rec.type)
  const type: McpTransportKind | undefined =
    typeRaw === 'http' || typeRaw === 'sse' || typeRaw === 'stdio' ? typeRaw : undefined
  const command = asString(rec.command)
  const url = asString(rec.url)
  const kind = type ?? (url ? 'http' : 'stdio')
  if (kind === 'stdio') {
    if (command === undefined || command === '') return undefined
  } else if (url === undefined || url === '') {
    return undefined
  }
  const server: McpServerConfig = { name }
  if (kind !== 'stdio') server.type = kind
  if (command !== undefined && command !== '') server.command = command
  if (url !== undefined && url !== '') server.url = url
  const args = asStringList(rec.args)
  if (args !== undefined) server.args = args
  const envRaw = asMap(rec.env)
  if (envRaw) {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(envRaw)) {
      const text = asString(value)
      if (text !== undefined) env[key] = text
      else if (typeof value === 'number' && Number.isFinite(value)) env[key] = String(value)
      else if (typeof value === 'boolean') env[key] = value ? 'true' : 'false'
    }
    server.env = env
  }
  const headersRaw = asMap(rec.headers)
  if (headersRaw) {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(headersRaw)) {
      const text = asString(value)
      if (text !== undefined) headers[key] = text
    }
    if (Object.keys(headers).length > 0) server.headers = headers
  }
  const tools = asStringList(rec.tools)
  if (tools !== undefined) server.tools = tools
  const excludeTools = asStringList(rec.excludeTools)
  if (excludeTools !== undefined) server.excludeTools = excludeTools
  const oauthRaw = asMap(rec.oauth)
  if (oauthRaw) {
    const clientId = asString(oauthRaw.clientId) ?? asString(oauthRaw.client_id)
    if (clientId !== undefined && clientId !== '') {
      const oauth: McpOAuthConfig = { clientId }
      const scope = asString(oauthRaw.scope)
      if (scope !== undefined) oauth.scope = scope
      const redirectPort = asNumber(oauthRaw.redirectPort) ?? asNumber(oauthRaw.redirect_port)
      if (redirectPort !== undefined) oauth.redirectPort = redirectPort
      const authorizationUrl = asString(oauthRaw.authorizationUrl) ?? asString(oauthRaw.authorization_url)
      if (authorizationUrl !== undefined) oauth.authorizationUrl = authorizationUrl
      const tokenUrl = asString(oauthRaw.tokenUrl) ?? asString(oauthRaw.token_url)
      if (tokenUrl !== undefined) oauth.tokenUrl = tokenUrl
      server.oauth = oauth
    }
  }
  return server
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2) {
    const start = value[0]
    const end = value[value.length - 1]
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

function parseYamlMap(text: string): Record<string, YamlValue> {
  const lines = text.split(/\r?\n/)
  const { value } = parseYamlBlock(lines, 0, 0)
  return value
}

function parseYamlBlock(
  lines: string[],
  start: number,
  minIndent: number,
): { value: Record<string, YamlValue>; next: number } {
  const out: Record<string, YamlValue> = {}
  let i = start
  while (i < lines.length) {
    const raw = lines[i] ?? ''
    if (isBlankOrComment(raw)) {
      i++
      continue
    }
    const indent = leadingSpaces(raw)
    if (indent < minIndent) break
    const parsed = parseKeyedLine(raw.slice(indent))
    if (!parsed) {
      i++
      continue
    }
    i++
    if (parsed.value === undefined) {
      const next = nextMeaningful(lines, i)
      const nextIndent = next === undefined ? -1 : leadingSpaces(lines[next] ?? '')
      if (next !== undefined && nextIndent > indent) {
        const nested = parseYamlNested(lines, i, nextIndent)
        out[parsed.key] = nested.value
        i = nested.next
      } else {
        out[parsed.key] = null
      }
    } else {
      out[parsed.key] = parsed.value
    }
  }
  return { value: out, next: i }
}

function parseKeyedLine(content: string): { key: string; value: YamlValue | undefined } | undefined {
  const trimmed = stripYamlComment(content).trim()
  if (trimmed === '') return undefined
  const keyMatch = trimmed.match(/^(?:"([^"]*)"|'([^']*)'|([^:#{}[\],]+?))\s*:(\s+.*)?$/)
  if (!keyMatch) return undefined
  const key = keyMatch[1] ?? keyMatch[2] ?? (keyMatch[3] ?? '').trim()
  if (key === '') return undefined
  const rest = (keyMatch[4] ?? '').trim()
  if (rest === '') return { key, value: undefined }
  return { key, value: parseYamlScalar(rest) }
}

function parseYamlNested(
  lines: string[],
  start: number,
  minIndent: number,
): { value: YamlValue; next: number } {
  const next = nextMeaningful(lines, start)
  if (next === undefined) return { value: null, next: start }
  const indent = leadingSpaces(lines[next] ?? '')
  if (indent < minIndent) return { value: null, next: start }
  const content = (lines[next] ?? '').slice(indent)
  if (isYamlListItem(content)) return parseYamlList(lines, start, indent)
  return parseYamlBlock(lines, start, indent)
}

function parseYamlList(
  lines: string[],
  start: number,
  minIndent: number,
): { value: YamlValue[]; next: number } {
  const out: YamlValue[] = []
  let i = start
  while (i < lines.length) {
    const raw = lines[i] ?? ''
    if (isBlankOrComment(raw)) {
      i++
      continue
    }
    const indent = leadingSpaces(raw)
    if (indent < minIndent) break
    if (indent > minIndent) {
      i++
      continue
    }
    const content = raw.slice(indent)
    if (!isYamlListItem(content)) break
    const rest = content.replace(/^-/, '').trim()
    i++
    if (rest === '') {
      const next = nextMeaningful(lines, i)
      const nextIndent = next === undefined ? -1 : leadingSpaces(lines[next] ?? '')
      if (next !== undefined && nextIndent > indent) {
        const nested = parseYamlNested(lines, i, nextIndent)
        out.push(nested.value)
        i = nested.next
      } else {
        out.push(null)
      }
      continue
    }
    const keyed = parseKeyedLine(rest)
    if (keyed) {
      const item: Record<string, YamlValue> = {}
      if (keyed.value === undefined) {
        const next = nextMeaningful(lines, i)
        const nextIndent = next === undefined ? -1 : leadingSpaces(lines[next] ?? '')
        if (next !== undefined && nextIndent > indent) {
          const nested = parseYamlNested(lines, i, nextIndent)
          item[keyed.key] = nested.value
          i = nested.next
        } else {
          item[keyed.key] = null
        }
      } else {
        item[keyed.key] = keyed.value
      }
      const siblings = parseYamlBlock(lines, i, indent + 1)
      Object.assign(item, siblings.value)
      i = siblings.next
      out.push(item)
    } else {
      out.push(parseYamlScalar(rest))
    }
  }
  return { value: out, next: i }
}

function isYamlListItem(content: string): boolean {
  return content === '-' || content.startsWith('- ')
}

function parseYamlScalar(raw: string): YamlValue {
  const text = stripYamlComment(raw).trim()
  if (text === '' || text === '~' || text === 'null' || text === 'Null' || text === 'NULL') {
    return null
  }
  if (text === 'true' || text === 'True' || text === 'TRUE') return true
  if (text === 'false' || text === 'False' || text === 'FALSE') return false
  if (text.startsWith('{') && text.endsWith('}')) {
    return parseInlineMap(text)
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return parseInlineList(text)
  }
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1)
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) {
    return Number(text)
  }
  return text
}

function parseInlineList(text: string): YamlValue[] {
  const inner = text.slice(1, -1).trim()
  if (inner === '') return []
  const out: YamlValue[] = []
  let i = 0
  while (i < inner.length) {
    while (i < inner.length && (inner[i] === ' ' || inner[i] === ',')) i++
    if (i >= inner.length) break
    const valuePart = readInlineValue(inner, i)
    out.push(valuePart.value)
    i = valuePart.next
  }
  return out
}

function parseInlineMap(text: string): Record<string, YamlValue> {
  const inner = text.slice(1, -1).trim()
  if (inner === '') return {}
  const out: Record<string, YamlValue> = {}
  let i = 0
  while (i < inner.length) {
    while (i < inner.length && (inner[i] === ' ' || inner[i] === ',')) i++
    if (i >= inner.length) break
    const keyPart = readInlineKey(inner, i)
    i = keyPart.next
    while (i < inner.length && inner[i] === ' ') i++
    if (inner[i] !== ':') break
    i++
    while (i < inner.length && inner[i] === ' ') i++
    const valuePart = readInlineValue(inner, i)
    out[keyPart.key] = valuePart.value
    i = valuePart.next
  }
  return out
}

function readInlineKey(text: string, start: number): { key: string; next: number } {
  if (text[start] === '"' || text[start] === "'") {
    const quote = text[start]
    let i = start + 1
    while (i < text.length && text[i] !== quote) i++
    return { key: text.slice(start + 1, i), next: i < text.length ? i + 1 : i }
  }
  let i = start
  while (i < text.length && text[i] !== ':' && text[i] !== ',') i++
  return { key: text.slice(start, i).trim(), next: i }
}

function readInlineValue(
  text: string,
  start: number,
): { value: YamlValue; next: number } {
  if (text[start] === '{') {
    let depth = 0
    let i = start
    while (i < text.length) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) {
          return { value: parseInlineMap(text.slice(start, i + 1)), next: i + 1 }
        }
      }
      i++
    }
    return { value: parseInlineMap(text.slice(start)), next: text.length }
  }
  if (text[start] === '[') {
    let depth = 0
    let i = start
    while (i < text.length) {
      if (text[i] === '[') depth++
      else if (text[i] === ']') {
        depth--
        if (depth === 0) {
          return { value: parseInlineList(text.slice(start, i + 1)), next: i + 1 }
        }
      }
      i++
    }
    return { value: parseInlineList(text.slice(start)), next: text.length }
  }
  if (text[start] === '"' || text[start] === "'") {
    const quote = text[start]
    let i = start + 1
    while (i < text.length && text[i] !== quote) i++
    const end = i < text.length ? i + 1 : i
    return { value: parseYamlScalar(text.slice(start, end)), next: end }
  }
  let i = start
  while (i < text.length && text[i] !== ',') i++
  return { value: parseYamlScalar(text.slice(start, i)), next: i }
}

function stripYamlComment(text: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t') {
        return text.slice(0, i)
      }
    }
  }
  return text
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

function leadingSpaces(line: string): number {
  let i = 0
  while (i < line.length && line[i] === ' ') i++
  return i
}

function nextMeaningful(lines: string[], start: number): number | undefined {
  for (let i = start; i < lines.length; i++) {
    if (!isBlankOrComment(lines[i] ?? '')) return i
  }
  return undefined
}
