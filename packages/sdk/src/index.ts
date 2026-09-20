import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  bashTool,
  buildSystemParts,
  createAgentTool,
  createBashTool,
  createMemoryStore,
  createPlanModeTools,
  createSessionEngine,
  createSqliteStore,
  createTerminalBackend,
  defaultCompactPolicy,
  editTool,
  fetchTool,
  globTool,
  grepTool,
  loadConfig,
  normalizeOpenAiBaseUrl,
  OLLAMA_DEFAULT_HOST,
  ravenclawHome,
  readTool,
  skillTool,
  createCronTools,
  createJsonCronStore,
  taskOutputTool,
  taskStopTool,
  todoWriteTool,
  VLLM_DEFAULT_BASE_URL,
  writeTool,
  listDirTool,
  readSubtreeTool,
  applyPatchTool,
  webSearchTool,
  askUserTool,
  setOutputTool,
  createSessionSearchTool,
  memoryTool,
  createToolSearchTool,
  toolCallTool,
  type CompactPolicy,
  type ConfigFlags,
  type Funding,
  type Message,
  type ModelProfile,
  type PermissionMode,
  type Provider,
  type ResolvedConfig,
  type RoundEnd,
  type SessionEngine,
  type SessionEngineOptions,
  type SessionRecord,
  type SessionStore,
  type StreamEvent,
  type SystemPart,
  type Tool,
} from '@ravenclaw/core'
import { createProvider } from '@ravenclaw/providers'

export type {
  ConfigFlags,
  Message,
  PermissionMode,
  Provider,
  ResolvedConfig,
  RoundEnd,
  SessionEngine,
  SessionEngineOptions,
  SessionRecord,
  SessionStore,
  StreamEvent,
  Tool,
}

export interface CreateRavenSessionOptions {
  cwd: string
  home?: string
  provider?: Provider
  store?: SessionStore | 'memory'
  tools?: Tool[]
  askUser?: SessionEngineOptions['askUser']
  flags?: ConfigFlags
  permissionMode?: PermissionMode
  session?: SessionRecord
  messages?: Message[]
}

export interface RavenSession {
  engine: SessionEngine
  store: SessionStore
  provider: Provider
  config: ResolvedConfig
  submit(prompt: string): AsyncGenerator<StreamEvent, RoundEnd>
  close(): Promise<void>
}

type ClosableStore = SessionStore & { close(): void }

function sdkCronTools(): Tool[] {
  const cron = createCronTools(createJsonCronStore())
  return [cron.create, cron.list, cron.remove, cron.setEnabled]
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

export function createRootTools(
  store: SessionStore,
  bash: Tool = bashTool,
  network = false,
): Tool[] {
  const plan = createPlanModeTools(store)
  const list: Tool[] = [
    readTool,
    grepTool,
    globTool,
    listDirTool,
    readSubtreeTool,
    editTool,
    writeTool,
    applyPatchTool,
    bash,
    skillTool,
    todoWriteTool,
    createSessionSearchTool(store),
    memoryTool,
    taskOutputTool,
    taskStopTool,
    askUserTool,
    setOutputTool,
    ...sdkCronTools(),
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
  network?: boolean
}): Tool[] {
  const networkOn = opts.network === true
  const base = createRootTools(opts.store, opts.bash ?? bashTool, networkOn)
  const deferred = networkOn ? [] : [fetchTool, webSearchTool].map(hideDeferredFromWire)
  const always = [...base, ...deferred]
  if (deferred.length > 0) {
    always.push(
      createToolSearchTool({
        deferred,
      }),
      toolCallTool,
    )
  }
  const agentOpts: Parameters<typeof createAgentTool>[0] = {
    store: opts.store,
    provider: opts.provider,
    tools: always,
    compact: opts.compact,
    model: opts.model,
    askUser: opts.askUser,
    childMaxRounds: opts.childMaxRounds,
  }
  if (opts.system !== undefined) agentOpts.system = opts.system
  return [...always, createAgentTool(agentOpts)]
}

export async function createRavenSession(
  opts: CreateRavenSessionOptions,
): Promise<RavenSession> {
  const home = opts.home ?? ravenclawHome()
  const config = loadSdkConfig(home, opts.flags, opts.provider !== undefined)
  const provider = opts.provider ?? byokProviderFromConfig(config)
  const { store, closer } = await openStore(home, opts.store)

  const permissionMode = opts.permissionMode ?? opts.session?.permissionMode ?? config.permissionMode
  const session =
    opts.session ??
    newSessionRecord({
      cwd: opts.cwd,
      model: config.model,
      permissionMode,
      funding: 'byok',
    })
  if (opts.session !== undefined && opts.permissionMode !== undefined) {
    session.permissionMode = opts.permissionMode
  }
  if (opts.session === undefined) await store.createSession(session)
  const lockHolderId = crypto.randomUUID()
  await store.acquireSessionLock(session.id, {
    holderId: lockHolderId,
    holderName: 'sdk',
  })

  const compact = compactPolicyFromConfig(config.compact)
  const system = buildSystemParts({
    cwd: session.cwd,
    permissionMode: session.permissionMode,
  })
  const askUser = opts.askUser ?? defaultAskUser
  const tools = opts.tools ?? defaultSessionTools({ store, provider, config, compact, system, askUser })

  const engineOpts: SessionEngineOptions = {
    session,
    provider,
    store,
    tools,
    compact,
    model: config.profile,
    maxRounds: config.maxRounds,
    askUser,
    system,
  }
  if (opts.messages !== undefined) engineOpts.messages = opts.messages
  engineOpts.sessionLock = { holderId: lockHolderId }

  const engine = await createSessionEngine(engineOpts)
  return {
    engine,
    store,
    provider,
    config,
    submit(prompt: string) {
      return engine.submitMessage(prompt)
    },
    async close() {
      await engine.close()
      closer?.()
    },
  }
}

function defaultAskUser(): Promise<'deny'> {
  return Promise.resolve('deny')
}

function defaultSessionTools(opts: {
  store: SessionStore
  provider: Provider
  config: ResolvedConfig
  compact: CompactPolicy
  system: SystemPart[]
  askUser: SessionEngineOptions['askUser']
}): Tool[] {
  const terminal = opts.config.terminal
  const backendOpts: { image?: string } = {}
  if (terminal?.image !== undefined) backendOpts.image = terminal.image
  const bash = createBashTool(createTerminalBackend(terminal?.backend ?? 'local', backendOpts))
  return createSessionTools({
    store: opts.store,
    provider: opts.provider,
    compact: opts.compact,
    model: opts.config.profile,
    askUser: opts.askUser,
    childMaxRounds: opts.config.childMaxRounds,
    system: opts.system,
    bash,
    network: (opts.config as { tools?: { network?: boolean } }).tools?.network === true,
  })
}

function compactPolicyFromConfig(compact: {
  enabled: boolean
  llmSummarize: boolean
}): CompactPolicy {
  return {
    ...defaultCompactPolicy(),
    enabled: compact.enabled,
    llmSummarize: compact.llmSummarize,
  }
}

function newSessionRecord(opts: {
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

async function openStore(
  home: string,
  store: CreateRavenSessionOptions['store'],
): Promise<{ store: SessionStore; closer?: () => void }> {
  if (store === 'memory') return { store: createMemoryStore() }
  if (store !== undefined) return { store }
  await mkdir(home, { recursive: true })
  const sqlite = createSqliteStore(join(home, 'state.db')) as ClosableStore
  return { store: sqlite, closer: () => sqlite.close() }
}

function loadSdkConfig(
  home: string,
  flags: ConfigFlags | undefined,
  hasHostProvider: boolean,
): ResolvedConfig {
  const opts: { home: string; flags?: ConfigFlags } = { home }
  if (flags !== undefined) opts.flags = flags
  try {
    return loadConfig(opts)
  } catch (error) {
    if (!hasHostProvider) throw error
    const retryFlags: ConfigFlags = flags !== undefined ? { ...flags } : {}
    if (retryFlags.provider === undefined) retryFlags.provider = 'anthropic'
    return loadConfig({ home, flags: retryFlags })
  }
}

// BYOK only — the included gateway is a CLI concern.
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
    config.provider === 'anthropic' ? config.env.ANTHROPIC_API_KEY : config.env.OPENAI_API_KEY
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

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== '') return value
  }
  return undefined
}
