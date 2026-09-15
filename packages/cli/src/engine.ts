import { join } from 'node:path'
import { filterToolsByAllowList } from './allowed-tools'
import { createAskUserBridge, elicitViaAskUser, type AskUserBridge } from './ask-host'
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
  fetchTool,
  globTool,
  grepTool,
  loadConfig,
  loadFileHooks,
  loadLocalPlugins,
  mergeToolPool,
  normalizeOpenAiBaseUrl,
  OLLAMA_DEFAULT_HOST,
  VLLM_DEFAULT_BASE_URL,
  readTool,
  resumeSession,
  skillTool,
  createSkillTool,
  createCronTools,
  createJsonCronStore,
  taskOutputTool,
  taskStopTool,
  taskSteerTool,
  todoWriteTool,
  writeTool,
  listDirTool,
  readSubtreeTool,
  applyPatchTool,
  webSearchTool,
  askUserTool,
  createAskUserTool,
  setOutputTool,
  notebookEditTool,
  enterWorktreeTool,
  exitWorktreeTool,
  createToolSearchTool,
  toolCallTool,
  addDirTool,
  createLspTool,
  createSessionSearchTool,
  memoryTool,
  createStructuredOutputTool,
  enterSessionWorktree,
  addDirectory,
  getAgentDefinition,
  filterChildTools,
  openRavenclawLog,
  type CompactPolicy,
  type ConfigFlags,
  type Funding,
  type Message,
  type ModelProfile,
  type PermissionHook,
  type PermissionMode,
  type Provider,
  type RavenclawLog,
  type ResolvedConfig,
  type RoundEnd,
  type SessionEngine,
  type SessionEngineOptions,
  type SessionLockHolderName,
  type SessionRecord,
  type SessionStore,
  type StreamEvent,
  type SystemPart,
  type Tool,
} from '@ravenclaw/core'
import { createProvider } from '@ravenclaw/providers'
import { startPreventSleep, stopPreventSleep } from './prevent-sleep'
import { probeEntitlement, type Entitlement } from '@ravenclaw/ads'
import { includedCapReached, tryRecordIncludedSession } from './included-usage'
import { loadConfiguredMcpTools, type McpSpawnFn } from './mcp'
import { applyAuxCompactPolicy } from './aux'

export type IncludedAccess =
  | {
      admitted: true
      gatewayUrl: string
      token: string
      defaultModel?: string
      sessionCap: number
      hasPaidCapacityPlan: boolean
      meteredByGateway: boolean
      remainingSessions?: number
    }
  | { admitted: false }

export type EntitlementProbe = (
  baseUrl: string,
  opts?: { token?: string; fetch?: typeof fetch },
) => Promise<Pick<Entitlement, 'admitted'> & Partial<Entitlement>>

export type IncludedSurface = 'interactive' | 'headless'

export interface IncludedAccessOptions {
  probe?: EntitlementProbe
  fetch?: typeof fetch
  access?: IncludedAccess
  consumeCap?: boolean
  preferByok?: boolean
  surface?: IncludedSurface
}

export async function resolveIncludedAccess(
  config: ResolvedConfig,
  opts?: IncludedAccessOptions,
): Promise<IncludedAccess> {
  if (opts?.preferByok === true) return { admitted: false }
  const gateway = includedGatewayUrl(config)
  if (gateway === undefined) return { admitted: false }
  // Gateway is opt-in; OSS/CI stay BYOK unless included.enabled is true.
  if (config.included?.enabled !== true) return { admitted: false }

  const token = includedApiKey(config)
  const probe = opts?.probe ?? probeEntitlement
  const probeOpts: { token?: string; fetch?: typeof fetch } = { token }
  if (opts?.fetch !== undefined) probeOpts.fetch = opts.fetch
  const entitlement = await probe(gateway.probeBase, probeOpts)
  // hasPaidCapacityPlan raises caps; it does not silence ads.
  if (!entitlement.admitted) return { admitted: false }
  const surface = opts?.surface ?? 'interactive'
  // New sessions only. Resume/load must keep an already-stamped included session.
  if (
    opts?.consumeCap !== false &&
    entitlement.placementRequired === true &&
    surface === 'headless'
  ) {
    return { admitted: false }
  }
  if (includedCapacityExhausted(config, entitlement, opts?.consumeCap)) return { admitted: false }
  const meteredByGateway =
    typeof entitlement.remainingSessions === 'number' && Number.isFinite(entitlement.remainingSessions)
  const access: Extract<IncludedAccess, { admitted: true }> = {
    admitted: true,
    gatewayUrl: gateway.chatBase,
    token,
    sessionCap: includedSessionCap(config, entitlement),
    hasPaidCapacityPlan: entitlement.hasPaidCapacityPlan === true,
    meteredByGateway,
  }
  if (typeof entitlement.defaultModel === 'string' && entitlement.defaultModel !== '') {
    access.defaultModel = entitlement.defaultModel
  }
  if (
    typeof entitlement.remainingSessions === 'number' &&
    Number.isFinite(entitlement.remainingSessions)
  ) {
    access.remainingSessions = entitlement.remainingSessions
  }
  return access
}

function includedCapacityExhausted(
  config: ResolvedConfig,
  entitlement: Partial<Pick<Entitlement, 'hasPaidCapacityPlan' | 'sessionCap' | 'remainingSessions'>>,
  consumeCap?: boolean,
): boolean {
  // Resume / load must not be gated by remaining new-session slots.
  if (consumeCap === false) return false
  if (typeof entitlement.remainingSessions === 'number' && Number.isFinite(entitlement.remainingSessions)) {
    return entitlement.remainingSessions <= 0
  }
  return includedCapReached(config.home, includedSessionCap(config, entitlement))
}

function includedSessionCap(
  config: ResolvedConfig,
  entitlement: Partial<Pick<Entitlement, 'hasPaidCapacityPlan' | 'sessionCap'>>,
): number {
  const perDay = config.included?.sessionCapPerDay ?? 4
  if (entitlement.hasPaidCapacityPlan === true) {
    const fromProbe = entitlement.sessionCap
    if (typeof fromProbe === 'number' && Number.isFinite(fromProbe)) return fromProbe
    return perDay * 4
  }
  return perDay
}

function hideDeferredFromWire(tool: Tool): Tool {
  return {
    ...tool,
    isEnabled() {
      return false
    },
  }
}

function enableOnWire(tool: Tool): Tool {
  return {
    ...tool,
    isEnabled() {
      return true
    },
  }
}

function cronToolList(): Tool[] {
  const cron = createCronTools(createJsonCronStore())
  return [cron.create, cron.list, cron.remove, cron.setEnabled]
}

export function createRootTools(
  store: SessionStore,
  bash: Tool = bashTool,
  ask: Tool = askUserTool,
  network = false,
): Tool[] {
  const plan = createPlanModeTools(store)
  const list = [
    readTool,
    grepTool,
    globTool,
    listDirTool,
    readSubtreeTool,
    editTool,
    writeTool,
    applyPatchTool,
    notebookEditTool,
    bash,
    skillTool,
    todoWriteTool,
    taskOutputTool,
    taskStopTool,
    taskSteerTool,
    ask,
    setOutputTool,
    addDirTool,
    createSessionSearchTool(store),
    memoryTool,
    createLspTool(),
    enterWorktreeTool,
    exitWorktreeTool,
    ...cronToolList(),
    plan.enter,
    plan.exit,
  ]
  if (network) list.push(enableOnWire(fetchTool), enableOnWire(webSearchTool))
  return list
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
  hooks?: PermissionHook[]
  askTool?: Tool
  network?: boolean
  deferredCatalog?: Tool[]
}): Tool[] {
  const networkOn = opts.network === true
  const root = createRootTools(opts.store, opts.bash ?? bashTool, opts.askTool, networkOn)
  const deferredNetwork = networkOn ? [] : [fetchTool, webSearchTool].map(hideDeferredFromWire)
  const deferredMcp = (opts.mcpTools ?? []).map(hideDeferredFromWire)
  const deferred = opts.deferredCatalog ?? []
  if (deferred.length === 0) deferred.push(...deferredNetwork, ...deferredMcp)
  const always = [...root, ...deferredNetwork]
  if (deferred.length > 0) {
    always.push(
      createToolSearchTool({
        deferred,
      }),
      toolCallTool,
    )
  }
  const childPool = deferredMcp.length > 0 ? mergeToolPool(always, deferredMcp) : always
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
  if (opts.hooks !== undefined) agentOpts.hooks = opts.hooks
  const agent = createAgentTool(agentOpts)
  if (deferredMcp.length === 0) return [...always, agent]
  return mergeToolPool([...always, agent], deferredMcp)
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
  id?: string
}): SessionRecord {
  const now = Date.now()
  return {
    id: opts.id ?? crypto.randomUUID(),
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

export interface CliRuntimeBase {
  engine?: SessionEngine
  store: SessionStore
  provider: Provider
  config: ResolvedConfig
  cwd: string
  ask: AskBridge
  askQuestions?: AskUserBridge
  mcpCloser?: () => Promise<void>
  mcpErrors?: Array<{ name: string; message: string }>
  status?: string
  hasPaidCapacityPlan?: boolean
  probe?: EntitlementProbe
  fetch?: typeof fetch
  preferByok?: boolean
  surface?: IncludedSurface
  remainingSessions?: number
  lockHolderId: string
  lockHolderName: SessionLockHolderName
  verifyOnStop?: boolean
  askUserHost?: boolean
}

export type CliRuntime = CliRuntimeBase & { engine: SessionEngine }

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
  tools?: Tool[]
  maxRounds?: number
  lockHolderId?: string
  lockHolderName?: SessionLockHolderName
  skipLock?: boolean
  verifyOnStop?: boolean
  askUserHost?: boolean
  backgroundReview?: boolean
}): Promise<{
  engine: SessionEngine
  mcpCloser?: () => Promise<void>
  askQuestions: AskUserBridge
  mcpErrors: Array<{ name: string; message: string }>
}> {
  const askQuestions = createAskUserBridge()
  const session = opts.session ?? newSessionRecord({
    cwd: opts.cwd,
    model: opts.config.model,
    permissionMode: opts.config.permissionMode,
    funding: opts.funding ?? 'byok',
  })
  if (!opts.session) await opts.store.createSession(session)
  const lockHolderId = opts.lockHolderId ?? crypto.randomUUID()
  const lockHolderName = opts.lockHolderName ?? 'sdk'
  let acquired = false
  if (opts.skipLock !== true) {
    await opts.store.acquireSessionLock(session.id, {
      holderId: lockHolderId,
      holderName: lockHolderName,
    })
    acquired = true
  }

  try {
    return await finishOpenEngine(opts, {
      session,
      lockHolderId,
      askQuestions,
      acquired,
    })
  } catch (error) {
    if (acquired) {
      try {
        await opts.store.releaseSessionLock(session.id, lockHolderId)
      } catch {
        // keep the original error
      }
    }
    throw error
  }
}

async function finishOpenEngine(
  opts: Parameters<typeof openEngine>[0],
  ready: {
    session: SessionRecord
    lockHolderId: string
    askQuestions: AskUserBridge
    acquired: boolean
  },
): Promise<{
  engine: SessionEngine
  mcpCloser?: () => Promise<void>
  askQuestions: AskUserBridge
  mcpErrors: Array<{ name: string; message: string }>
}> {
  const { session, lockHolderId, askQuestions } = ready
  const compact = compactPolicyFromConfig(opts.config.compact)
  applyAuxCompactPolicy(compact, {
    config: opts.config,
    funding: session.funding,
    sessionModel: session.model,
    liveProvider: opts.provider,
  })
  if (opts.config.specialistModel !== undefined && opts.config.specialistModel !== '') {
    compact.specialistModel = opts.config.specialistModel
  }
  const system = buildSystemParts({
    cwd: session.cwd,
    permissionMode: session.permissionMode,
    ...(opts.config.bare === true ? { bare: true } : {}),
    ...(opts.config.effort !== undefined ? { effort: opts.config.effort } : {}),
  })
  const terminal = opts.config.terminal
  const bash = createBashTool(
    createTerminalBackend(terminal?.backend ?? 'local', {
      ...(terminal?.image !== undefined ? { image: terminal.image } : {}),
    }),
  )
  const servers = opts.tools !== undefined ? [] : (opts.config.mcp?.servers ?? [])
  let mcpTools: Tool[] = []
  let mcpCloser: (() => Promise<void>) | undefined
  let refreshMcp: (() => Promise<Tool[]>) | undefined
  const mcpErrors: Array<{ name: string; message: string }> = []
  const deferredCatalog: Tool[] = []
  try {
  if (servers.length > 0) {
    const loaded = await loadConfiguredMcpTools(servers, {
      ...(opts.spawnMcp ? { spawn: opts.spawnMcp } : {}),
      elicit: async (params, signal) => {
        if (opts.askUserHost !== true) return { action: 'cancel' }
        if (session.permissionMode === 'dontAsk') return { action: 'cancel' }
        return elicitViaAskUser(askQuestions, params, signal)
      },
    })
    mcpTools = loaded.tools
    mcpCloser = loaded.close
    refreshMcp = () => loaded.refresh()
    mcpErrors.push(...loaded.errors)
  }
  if (opts.tools === undefined) {
    const plugins = loadLocalPlugins(session.cwd, opts.config.home, { project: true })
    if (plugins.length > 0) mcpTools = mergeToolPool(mcpTools, plugins)
  }
  const hooks = opts.config.bare === true ? [] : loadFileHooks(session.cwd)
  const built =
    opts.tools ??
    createSessionTools({
      store: opts.store,
      provider: opts.provider,
      compact,
      model: opts.config.profile,
      askUser: opts.askUser,
      childMaxRounds: opts.config.childMaxRounds,
      system,
      bash,
      mcpTools,
      deferredCatalog,
      hooks,
      askTool:
        opts.askUserHost === true
          ? createAskUserTool((input, signal) => askQuestions.ask(input, signal))
          : askUserTool,
      network: (opts.config as { tools?: { network?: boolean } }).tools?.network === true,
    }).map((tool) =>
      tool.name === 'Skill' ? createSkillTool(session.cwd, opts.config.home) : tool,
    )
  let pooled = built
  let jsonSchema: unknown
  if (opts.config.jsonSchema !== undefined && opts.config.jsonSchema !== '') {
    try {
      jsonSchema = JSON.parse(opts.config.jsonSchema) as unknown
    } catch {
      throw new Error('--json-schema is not valid JSON')
    }
    if (!jsonSchema || typeof jsonSchema !== 'object' || Array.isArray(jsonSchema)) {
      throw new Error('--json-schema must be a JSON object')
    }
    pooled = [...pooled, createStructuredOutputTool(jsonSchema)]
  }
  if (opts.config.agent !== undefined && opts.config.agent !== '') {
    const definition = getAgentDefinition(opts.config.agent, session.cwd)
    if (!definition) throw new Error(`unknown agent: ${opts.config.agent}`)
    pooled = filterChildTools(pooled, definition)
  }
  let extraDirs: string[] = []
  for (const path of opts.config.addDir ?? []) {
    const added = addDirectory(extraDirs, session.cwd, path)
    if (!added.ok) throw new Error(`--add-dir ${path}: ${added.error}`)
    extraDirs = added.list
  }
  const tools = filterToolsByAllowList(pooled, opts.config.allowedTools)
  const engineOpts: SessionEngineOptions = {
    session,
    provider: opts.provider,
    store: opts.store,
    tools,
    compact,
    model: opts.config.profile,
    maxRounds: opts.maxRounds ?? opts.config.maxRounds,
    askUser: opts.askUser,
    system,
    terminalBackend: opts.config.terminal?.backend ?? 'local',
  }
  if (opts.messages) engineOpts.messages = opts.messages
  if (hooks.length > 0) engineOpts.hooks = hooks
  if (opts.config.fallbackModel !== undefined) engineOpts.fallbackModel = opts.config.fallbackModel
  if (jsonSchema !== undefined) engineOpts.jsonSchema = jsonSchema
  if (opts.config.bare === true) engineOpts.bare = true
  if (extraDirs.length > 0) engineOpts.additionalDirectories = extraDirs
  engineOpts.sessionLock = { holderId: lockHolderId }
  if (opts.verifyOnStop === true) engineOpts.verifyOnStop = true
  if (opts.backgroundReview === true) engineOpts.backgroundReview = true
  if (refreshMcp !== undefined) {
    engineOpts.refreshTools = async () => {
      try {
        const added = await refreshMcp()
        const hidden = added.map(hideDeferredFromWire)
        for (const tool of hidden) {
          if (!deferredCatalog.some((row) => row.name === tool.name)) deferredCatalog.push(tool)
        }
        return hidden
      } catch {
        return []
      }
    }
  }
  const log = openRavenclawLog(opts.config.home)
  for (const err of mcpErrors) {
    log.write({
      type: 'mcp_load_error',
      sessionId: session.id,
      error: `${err.name}: ${err.message}`,
    })
  }
  return {
    engine: attachRavenclawLog(createSessionEngine(engineOpts), log),
    mcpCloser,
    askQuestions,
    mcpErrors,
  }
  } catch (error) {
    if (mcpCloser) {
      try {
        await mcpCloser()
      } catch {
        // keep the original error
      }
    }
    throw error
  }
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
      defaultModel: firstNonEmpty(
        access.defaultModel,
        config.included?.defaultModel,
        config.model,
      ),
    })
  }
  return byokProviderFromConfig(config)
}

function byokProviderFromConfig(config: ResolvedConfig): Provider {
  if (config.provider === 'ollama') {
    return createProvider({
      provider: 'ollama',
      apiKey: firstNonEmpty(config.env.OLLAMA_API_KEY) ?? 'ollama',
      baseUrl: normalizeOpenAiBaseUrl(config.env.OLLAMA_HOST ?? OLLAMA_DEFAULT_HOST),
      defaultModel: config.model,
    })
  }
  if (config.provider === 'vllm') {
    return createProvider({
      provider: 'vllm',
      apiKey: firstNonEmpty(config.env.VLLM_API_KEY, config.env.OPENAI_API_KEY) ?? 'vllm',
      baseUrl: normalizeOpenAiBaseUrl(config.env.VLLM_BASE_URL ?? VLLM_DEFAULT_BASE_URL),
      defaultModel: config.model,
    })
  }
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

export function normalizeIncludedGatewayUrl(
  raw: string,
): { probeBase: string; chatBase: string } | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    const path = parsed.pathname.replace(/\/+$/, '')
    const withOrigin = `${parsed.origin}${path === '/' ? '' : path}`
    const probeBase = withOrigin.replace(/\/v1$/, '') || parsed.origin
    return { probeBase, chatBase: `${probeBase}/v1` }
  } catch {
    return undefined
  }
}

function includedGatewayUrl(config: ResolvedConfig): { probeBase: string; chatBase: string } | undefined {
  return normalizeIncludedGatewayUrl(config.included?.gatewayUrl ?? '')
}

function reserveIncludedFunding(
  config: ResolvedConfig,
  access: IncludedAccess,
): Extract<IncludedAccess, { admitted: true }> | { admitted: false } {
  if (!access.admitted) return access
  // Gateway remainingSessions is the source of truth; do not inflate the local ledger.
  if (access.meteredByGateway) return access
  return tryRecordIncludedSession(config.home, access.sessionCap) ? access : { admitted: false }
}

function includedApiKey(config: ResolvedConfig): string {
  return (
    firstNonEmpty(process.env.RAVENCLAW_INCLUDED_TOKEN, config.env.RAVENCLAW_INCLUDED_TOKEN) ??
    'included'
  )
}

function formatMcpLoadErrors(errors: Array<{ name: string; message: string }>): string {
  return errors.map((error) => `MCP server ${error.name} failed: ${error.message}`).join('\n')
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

type BootCliOpts = {
  flags: ConfigFlags
  cwd?: string
  ask?: AskBridge
  tools?: Tool[]
  maxRounds?: number
  lockHolder?: SessionLockHolderName
} & IncludedAccessOptions

export async function bootCli(opts: BootCliOpts & { createSession: false }): Promise<CliRuntimeBase>
export async function bootCli(opts: BootCliOpts): Promise<CliRuntime>
export async function bootCli(
  opts: BootCliOpts & { createSession?: boolean },
): Promise<CliRuntime | CliRuntimeBase> {
  const home = await ensureHomeDir()
  openRavenclawLog(home)
  const config = loadConfig({ home, flags: opts.flags })
  const store = createSqliteStore(join(home, 'state.db'))
  const createSession = opts.createSession !== false
  const lockHolderId = crypto.randomUUID()
  const lockHolderName: SessionLockHolderName =
    opts.lockHolder ?? (opts.surface === 'headless' ? 'exec' : 'tui')
  const probed =
    opts.access ??
    (await resolveIncludedAccess(config, {
      probe: opts.probe,
      fetch: opts.fetch,
      consumeCap: createSession,
      preferByok: opts.flags.provider !== undefined,
      surface: opts.surface,
    }))
  // Reserve before picking the provider so a failed local cap cannot keep
  // the included gateway while stamping funding: byok.
  const access = createSession ? reserveIncludedFunding(config, probed) : probed
  const provider = await providerFromConfig(config, { access })
  const cwd = opts.flags.cwd ?? opts.cwd ?? process.cwd()
  const ask = opts.ask ?? createAskBridge()
  const paid = access.admitted ? access.hasPaidCapacityPlan : undefined
  const extras: Pick<
    CliRuntimeBase,
    | 'hasPaidCapacityPlan'
    | 'probe'
    | 'fetch'
    | 'preferByok'
    | 'surface'
    | 'remainingSessions'
    | 'verifyOnStop'
    | 'askUserHost'
  > = {
    hasPaidCapacityPlan: paid,
  }
  if (opts.probe !== undefined) extras.probe = opts.probe
  if (opts.fetch !== undefined) extras.fetch = opts.fetch
  if (opts.flags.provider !== undefined) extras.preferByok = true
  if (opts.surface !== undefined) extras.surface = opts.surface
  if (opts.flags.verifyOnStop === true) extras.verifyOnStop = true
  if ((opts.surface ?? 'interactive') !== 'headless') extras.askUserHost = true
  if (access.admitted && access.remainingSessions !== undefined) {
    extras.remainingSessions = access.remainingSessions
  }
  if (!createSession) {
    return { store, provider, config, cwd, ask, lockHolderId, lockHolderName, ...extras }
  }
  const engineOpts: Parameters<typeof openEngine>[0] = {
    provider,
    store,
    config,
    cwd,
    askUser: ask.ask,
    funding: access.admitted ? 'included' : 'byok',
    lockHolderId,
    lockHolderName,
  }
  if (opts.tools !== undefined) engineOpts.tools = opts.tools
  if (opts.maxRounds !== undefined) engineOpts.maxRounds = opts.maxRounds
  if ((opts.surface ?? 'interactive') !== 'headless' || opts.flags.verifyOnStop === true) {
    engineOpts.verifyOnStop = true
  }
  if ((opts.surface ?? 'interactive') !== 'headless') engineOpts.askUserHost = true
  if (wantBackgroundReview(config, opts.surface, access.admitted ? 'included' : 'byok')) {
    engineOpts.backgroundReview = true
  }
  const { engine, mcpCloser, askQuestions, mcpErrors } = await openEngine(engineOpts)
  const mcpStatus = mcpErrors.length > 0 ? formatMcpLoadErrors(mcpErrors) : undefined
  const wt = opts.flags.worktree
  if (wt !== undefined && wt !== false) {
    const name = wt === true ? undefined : wt
    const entered = enterSessionWorktree(engine.session.id, cwd, name)
    if (entered.ok) {
      engine.session.cwd = entered.cwd
      await store.upsertSession(engine.session)
      return {
        engine,
        store,
        provider,
        config,
        cwd: entered.cwd,
        ask,
        mcpCloser,
        askQuestions,
        mcpErrors,
        ...(mcpStatus !== undefined ? { status: mcpStatus } : {}),
        lockHolderId,
        lockHolderName,
        ...extras,
      }
    }
  }
  return {
    engine,
    store,
    provider,
    config,
    cwd,
    ask,
    mcpCloser,
    askQuestions,
    mcpErrors,
    ...(mcpStatus !== undefined ? { status: mcpStatus } : {}),
    lockHolderId,
    lockHolderName,
    ...extras,
  }
}

export const INCLUDED_RESUME_UNAVAILABLE =
  'This session used included capacity. The included gateway is not available, so RavenClaw will not silently switch to your API keys. Re-run when the gateway is up, or start a new BYOK session.'

export class IncludedResumeError extends Error {
  constructor(message = INCLUDED_RESUME_UNAVAILABLE) {
    super(message)
    this.name = 'IncludedResumeError'
  }
}

export async function resumeRuntime(
  runtime: CliRuntimeBase,
  sessionId: string,
): Promise<CliRuntime> {
  const prevEngine = runtime.engine
  const loaded = await resumeSession(runtime.store, sessionId)
  const lockHolderId = runtime.lockHolderId ?? crypto.randomUUID()
  const lockHolderName = runtime.lockHolderName ?? 'tui'
  await runtime.store.acquireSessionLock(loaded.session.id, {
    holderId: lockHolderId,
    holderName: lockHolderName,
  })
  try {
  await runtime.mcpCloser?.()
  const resumed = await providerForResumedSession(runtime, loaded.session)
  const { engine, mcpCloser, askQuestions, mcpErrors } = await openEngine({
    provider: resumed.provider,
    store: runtime.store,
    config: runtime.config,
    cwd: loaded.session.cwd,
    askUser: runtime.ask.ask,
    session: loaded.session,
    messages: loaded.messages,
    lockHolderId,
    lockHolderName,
    skipLock: true,
    ...((runtime.surface ?? 'interactive') !== 'headless' || runtime.verifyOnStop === true
      ? { verifyOnStop: true }
      : {}),
    ...((runtime.surface ?? 'interactive') !== 'headless' || runtime.askUserHost === true
      ? { askUserHost: true }
      : {}),
    ...(wantBackgroundReview(
      runtime.config,
      runtime.surface,
      loaded.session.funding,
    )
      ? { backgroundReview: true }
      : {}),
  })
  if (prevEngine) {
    await prevEngine.close({ releaseLock: prevEngine.session.id !== engine.session.id })
  }
  const mcpStatus = mcpErrors.length > 0 ? formatMcpLoadErrors(mcpErrors) : undefined
  return {
    ...runtime,
    engine,
    provider: resumed.provider,
    cwd: loaded.session.cwd,
    mcpCloser,
    askQuestions,
    mcpErrors,
    status: mcpStatus,
    hasPaidCapacityPlan: resumed.hasPaidCapacityPlan,
    lockHolderId,
    lockHolderName,
  }
  } catch (error) {
    try {
      await runtime.store.releaseSessionLock(loaded.session.id, lockHolderId)
    } catch {
      // keep the original error
    }
    throw error
  }
}

export async function openNewSession(
  runtime: CliRuntimeBase,
  opts?: { sessionId?: string },
): Promise<CliRuntime> {
  const probed = await resolveIncludedAccess(runtime.config, {
    consumeCap: true,
    probe: runtime.probe,
    fetch: runtime.fetch,
    preferByok: runtime.preferByok,
    surface: runtime.surface,
  })
  const access = reserveIncludedFunding(runtime.config, probed)
  const provider = await providerFromConfig(runtime.config, { access })
  const funding = access.admitted ? 'included' : 'byok'
  const session = newSessionRecord({
    cwd: runtime.cwd,
    model: runtime.config.model,
    permissionMode: runtime.config.permissionMode,
    funding,
    ...(opts?.sessionId !== undefined ? { id: opts.sessionId } : {}),
  })
  await runtime.store.createSession(session)
  const prevEngine = runtime.engine
  const lockHolderId = runtime.lockHolderId ?? crypto.randomUUID()
  const lockHolderName = runtime.lockHolderName ?? 'tui'
  const { engine, mcpCloser, askQuestions, mcpErrors } = await openEngine({
    provider,
    store: runtime.store,
    config: runtime.config,
    cwd: runtime.cwd,
    askUser: runtime.ask.ask,
    session,
    lockHolderId,
    lockHolderName,
    ...((runtime.surface ?? 'interactive') !== 'headless' || runtime.verifyOnStop === true
      ? { verifyOnStop: true }
      : {}),
    ...((runtime.surface ?? 'interactive') !== 'headless' || runtime.askUserHost === true
      ? { askUserHost: true }
      : {}),
    ...(wantBackgroundReview(runtime.config, runtime.surface, funding)
      ? { backgroundReview: true }
      : {}),
  })
  if (prevEngine && prevEngine.session.id !== engine.session.id) {
    await prevEngine.close?.()
  }
  const mcpStatus = mcpErrors.length > 0 ? formatMcpLoadErrors(mcpErrors) : undefined
  return {
    ...runtime,
    engine,
    provider,
    mcpCloser,
    askQuestions,
    mcpErrors,
    status: mcpStatus,
    hasPaidCapacityPlan: access.admitted ? access.hasPaidCapacityPlan : false,
    remainingSessions: access.admitted ? access.remainingSessions : undefined,
    lockHolderId,
    lockHolderName,
  }
}

async function providerForResumedSession(
  runtime: CliRuntimeBase,
  session: SessionRecord,
): Promise<{ provider: Provider; hasPaidCapacityPlan?: boolean }> {
  if (session.funding !== 'included') {
    return { provider: byokProviderFromConfig(runtime.config), hasPaidCapacityPlan: false }
  }
  const access = await resolveIncludedAccess(runtime.config, {
    consumeCap: false,
    probe: runtime.probe,
    fetch: runtime.fetch,
    surface: runtime.surface,
  })
  if (access.admitted) {
    return {
      provider: await providerFromConfig(runtime.config, { access }),
      hasPaidCapacityPlan: access.hasPaidCapacityPlan,
    }
  }
  // Included sessions stay on the included gateway; never fall back to BYOK.
  throw new IncludedResumeError()
}

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
] as const satisfies readonly PermissionMode[]

function wantBackgroundReview(
  config: ResolvedConfig,
  surface: IncludedSurface | undefined,
  funding: Funding,
): boolean {
  return (
    (surface ?? 'interactive') !== 'headless' &&
    config.review?.background === true &&
    config.permissionMode !== 'dontAsk' &&
    funding !== 'included'
  )
}

export function parsePermissionMode(raw: string): PermissionMode | undefined {
  const key = raw.trim().toLowerCase()
  if (key === 'acceptedits') return 'acceptEdits'
  if (key === 'dontask') return 'dontAsk'
  if (key === 'default' || key === 'plan') return key
  return undefined
}

function attachRavenclawLog(engine: SessionEngine, log: RavenclawLog): SessionEngine {
  return {
    get session() {
      return engine.session
    },
    get tasks() {
      return engine.tasks
    },
    get fileHistory() {
      return engine.fileHistory
    },
    submitMessage(input) {
      return withPreventSleep(logSubmit(engine.submitMessage(input), engine.session.id, log))
    },
    applyAskAnswer(callId, answer) {
      return engine.applyAskAnswer(callId, answer)
    },
    replayPendingAsks() {
      return engine.replayPendingAsks()
    },
    enqueueSteer(text) {
      engine.enqueueSteer(text)
    },
    drainSteering() {
      return engine.drainSteering()
    },
    bindDrainQueued(fn) {
      engine.bindDrainQueued(fn)
    },
    rewindLast() {
      return engine.rewindLast()
    },
    compactNow() {
      return engine.compactNow()
    },
    setModel(profile) {
      return engine.setModel(profile)
    },
    setPermissionMode(mode) {
      return engine.setPermissionMode(mode)
    },
    reloadSystem(system) {
      engine.reloadSystem(system)
    },
    abort() {
      engine.abort()
    },
    async close(closeOpts) {
      try {
        await engine.close(closeOpts)
      } finally {
        log.close()
      }
    },
  }
}

async function* withPreventSleep(
  gen: AsyncGenerator<StreamEvent, RoundEnd>,
): AsyncGenerator<StreamEvent, RoundEnd> {
  startPreventSleep()
  try {
    return yield* gen
  } finally {
    stopPreventSleep()
  }
}

async function* logSubmit(
  gen: AsyncGenerator<StreamEvent, RoundEnd>,
  sessionId: string,
  log: RavenclawLog,
): AsyncGenerator<StreamEvent, RoundEnd> {
  const end = yield* gen
  log.write({ type: 'round_end', sessionId, reason: end.reason })
  if (end.reason === 'persist_failed' || end.reason === 'results_persist_failed') {
    const error = stringifyLogError('error' in end ? end.error : undefined)
    log.write({
      type: end.reason,
      sessionId,
      ...(error !== undefined ? { error } : {}),
    })
  }
  return end
}

function stringifyLogError(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return 'error'
}
