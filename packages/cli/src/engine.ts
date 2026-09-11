import { join } from 'node:path'
import {
  bashTool,
  buildSystemParts,
  createAgentTool,
  createBashTool,
  createTerminalBackend,
  createPlanModeTools,
  createSessionEngine,
  createSqliteStore,
  defaultCompactPolicy,
  editTool,
  ensureHomeDir,
  globTool,
  grepTool,
  loadConfig,
  mergeToolPool,
  readTool,
  resumeSession,
  skillTool,
  writeTool,
  type CompactPolicy,
  type ConfigFlags,
  type Funding,
  type Message,
  type ModelProfile,
  type PermissionMode,
  type Provider,
  type ResolvedConfig,
  type SessionEngine,
  type SessionEngineOptions,
  type SessionRecord,
  type SessionStore,
  type SystemPart,
  type Tool,
} from '@ravenclaw/core'
import { createProvider } from '@ravenclaw/providers'
import { probeEntitlement, type Entitlement } from '@ravenclaw/ads'
import { loadConfiguredMcpTools, type McpSpawnFn } from './mcp'

export type IncludedAccess =
  | { admitted: true; gatewayUrl: string; token: string }
  | { admitted: false }

export type EntitlementProbe = (
  baseUrl: string,
  opts?: { token?: string; fetch?: typeof fetch },
) => Promise<Pick<Entitlement, 'admitted'>>

export interface IncludedAccessOptions {
  probe?: EntitlementProbe
  fetch?: typeof fetch
  access?: IncludedAccess
}

export async function resolveIncludedAccess(
  config: ResolvedConfig,
  opts?: IncludedAccessOptions,
): Promise<IncludedAccess> {
  const gatewayUrl = includedGatewayUrl(config)
  if (gatewayUrl === undefined) return { admitted: false }

  const token = includedApiKey(config)
  const probe = opts?.probe ?? probeEntitlement
  const probeOpts: { token?: string; fetch?: typeof fetch } = { token }
  if (opts?.fetch !== undefined) probeOpts.fetch = opts.fetch
  const entitlement = await probe(gatewayUrl, probeOpts)
  // hasPaidCapacityPlan raises caps; it does not silence ads.
  if (!entitlement.admitted) return { admitted: false }
  return { admitted: true, gatewayUrl, token }
}

export function createRootTools(store: SessionStore, bash: Tool = bashTool): Tool[] {
  const plan = createPlanModeTools(store)
  return [
    readTool,
    grepTool,
    globTool,
    editTool,
    writeTool,
    bash,
    skillTool,
    plan.enter,
    plan.exit,
  ]
}

export function createSessionTools(opts: {
  store: SessionStore
  provider: Provider
  compact: CompactPolicy
  model: ModelProfile
  askUser: SessionEngineOptions['askUser']
  childMaxRounds: number
  system?: SystemPart[]
  bash?: Tool
  mcpTools?: Tool[]
}): Tool[] {
  const base = createRootTools(opts.store, opts.bash ?? bashTool)
  const mcpTools = opts.mcpTools ?? []
  const childPool = mcpTools.length > 0 ? mergeToolPool(base, mcpTools) : base
  const agentOpts: Parameters<typeof createAgentTool>[0] = {
    store: opts.store,
    provider: opts.provider,
    tools: childPool,
    compact: opts.compact,
    model: opts.model,
    askUser: opts.askUser,
    childMaxRounds: opts.childMaxRounds,
  }
  if (opts.system !== undefined) agentOpts.system = opts.system
  const agent = createAgentTool(agentOpts)
  if (mcpTools.length === 0) return [...base, agent]
  return mergeToolPool([...base, agent], mcpTools)
}

export function compactPolicyFromConfig(compact: {
  enabled: boolean
  llmSummarize: boolean
}): CompactPolicy {
  return {
    ...defaultCompactPolicy(),
    enabled: compact.enabled,
    llmSummarize: compact.llmSummarize,
  }
}

export function newSessionRecord(opts: {
  cwd: string
  model: string
  permissionMode: PermissionMode
  funding?: Funding
}): SessionRecord {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    cwd: opts.cwd,
    model: opts.model,
    permissionMode: opts.permissionMode,
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: opts.funding ?? 'byok',
  }
}

export interface AskBridge {
  ask: SessionEngineOptions['askUser']
  bind(fn: SessionEngineOptions['askUser']): void
}

export function createAskBridge(): AskBridge {
  let impl: SessionEngineOptions['askUser'] | undefined
  return {
    async ask(event, signal) {
      if (!impl) return 'deny'
      return impl(event, signal)
    },
    bind(fn) {
      impl = fn
    },
  }
}

export interface CliRuntime {
  engine: SessionEngine
  store: SessionStore
  provider: Provider
  config: ResolvedConfig
  cwd: string
  ask: AskBridge
  mcpCloser?: () => Promise<void>
}

export async function openEngine(opts: {
  provider: Provider
  store: SessionStore
  config: ResolvedConfig
  cwd: string
  askUser: SessionEngineOptions['askUser']
  session?: SessionRecord
  messages?: Message[]
  spawnMcp?: McpSpawnFn
  funding?: Funding
}): Promise<{ engine: SessionEngine; mcpCloser?: () => Promise<void> }> {
  const session = opts.session ?? newSessionRecord({
    cwd: opts.cwd,
    model: opts.config.model,
    permissionMode: opts.config.permissionMode,
    funding: opts.funding ?? 'byok',
  })
  if (!opts.session) await opts.store.createSession(session)

  const compact = compactPolicyFromConfig(opts.config.compact)
  const system = buildSystemParts({
    cwd: session.cwd,
    permissionMode: session.permissionMode,
  })
  const terminal = opts.config.terminal
  const bash = createBashTool(
    createTerminalBackend(terminal?.backend ?? 'local', {
      ...(terminal?.image !== undefined ? { image: terminal.image } : {}),
    }),
  )
  const servers = opts.config.mcp?.servers ?? []
  let mcpTools: Tool[] = []
  let mcpCloser: (() => Promise<void>) | undefined
  if (servers.length > 0) {
    const loaded = await loadConfiguredMcpTools(servers, {
      ...(opts.spawnMcp ? { spawn: opts.spawnMcp } : {}),
    })
    mcpTools = loaded.tools
    mcpCloser = loaded.close
  }
  const engineOpts: SessionEngineOptions = {
    session,
    provider: opts.provider,
    store: opts.store,
    tools: createSessionTools({
      store: opts.store,
      provider: opts.provider,
      compact,
      model: opts.config.profile,
      askUser: opts.askUser,
      childMaxRounds: opts.config.childMaxRounds,
      system,
      bash,
      mcpTools,
    }),
    compact,
    model: opts.config.profile,
    maxRounds: opts.config.maxRounds,
    askUser: opts.askUser,
    system,
  }
  if (opts.messages) engineOpts.messages = opts.messages
  return { engine: createSessionEngine(engineOpts), mcpCloser }
}

export async function providerFromConfig(
  config: ResolvedConfig,
  opts?: IncludedAccessOptions,
): Promise<Provider> {
  const access = opts?.access ?? (await resolveIncludedAccess(config, opts))
  if (access.admitted) {
    return createProvider({
      provider: 'included',
      apiKey: access.token,
      gatewayUrl: access.gatewayUrl,
      defaultModel: config.model,
    })
  }
  return byokProviderFromConfig(config)
}

function byokProviderFromConfig(config: ResolvedConfig): Provider {
  const apiKey =
    config.provider === 'anthropic'
      ? config.env.ANTHROPIC_API_KEY
      : config.env.OPENAI_API_KEY
  if (apiKey === undefined || apiKey === '') {
    const hint =
      config.provider === 'anthropic'
        ? 'Set ANTHROPIC_API_KEY in $RAVENCLAW_HOME/.env or the environment.'
        : 'Set OPENAI_API_KEY in $RAVENCLAW_HOME/.env or the environment.'
    throw new Error(hint)
  }
  const ctor: Parameters<typeof createProvider>[0] = {
    provider: config.provider,
    apiKey,
    defaultModel: config.model,
  }
  if (config.provider === 'openai_compat' && config.env.OPENAI_BASE_URL) {
    ctor.baseUrl = config.env.OPENAI_BASE_URL
  }
  return createProvider(ctor)
}

function includedGatewayUrl(config: ResolvedConfig): string | undefined {
  const raw = config.included?.gatewayUrl?.trim() ?? ''
  if (raw === '') return undefined
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return raw
  } catch {
    return undefined
  }
}

function includedApiKey(config: ResolvedConfig): string {
  return firstNonEmpty(process.env.RAVENCLAW_INCLUDED_TOKEN, config.env.OPENAI_API_KEY) ?? 'included'
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

export async function bootCli(opts: {
  flags: ConfigFlags
  cwd?: string
  ask?: AskBridge
}): Promise<CliRuntime> {
  const home = await ensureHomeDir()
  const config = loadConfig({ home, flags: opts.flags })
  const store = createSqliteStore(join(home, 'state.db'))
  const access = await resolveIncludedAccess(config)
  const provider = await providerFromConfig(config, { access })
  const cwd = opts.cwd ?? process.cwd()
  const ask = opts.ask ?? createAskBridge()
  const { engine, mcpCloser } = await openEngine({
    provider,
    store,
    config,
    cwd,
    askUser: ask.ask,
    funding: access.admitted ? 'included' : 'byok',
  })
  return { engine, store, provider, config, cwd, ask, mcpCloser }
}

export async function resumeRuntime(
  runtime: CliRuntime,
  sessionId: string,
): Promise<CliRuntime> {
  const loaded = await resumeSession(runtime.store, sessionId)
  await runtime.mcpCloser?.()
  const { engine, mcpCloser } = await openEngine({
    provider: runtime.provider,
    store: runtime.store,
    config: runtime.config,
    cwd: loaded.session.cwd,
    askUser: runtime.ask.ask,
    session: loaded.session,
    messages: loaded.messages,
  })
  return { ...runtime, engine, cwd: loaded.session.cwd, mcpCloser }
}

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
] as const satisfies readonly PermissionMode[]

export function parsePermissionMode(raw: string): PermissionMode | undefined {
  const key = raw.trim().toLowerCase()
  if (key === 'acceptedits') return 'acceptEdits'
  if (key === 'dontask') return 'dontAsk'
  if (key === 'default' || key === 'plan') return key
  return undefined
}
