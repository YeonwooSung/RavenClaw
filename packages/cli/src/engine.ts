import { join } from 'node:path'
import {
  bashTool,
  buildSystemParts,
  createPlanModeTools,
  createSessionEngine,
  createSqliteStore,
  defaultCompactPolicy,
  editTool,
  ensureHomeDir,
  globTool,
  grepTool,
  loadConfig,
  readTool,
  resumeSession,
  skillTool,
  writeTool,
  type CompactPolicy,
  type ConfigFlags,
  type Message,
  type PermissionMode,
  type Provider,
  type ResolvedConfig,
  type SessionEngine,
  type SessionEngineOptions,
  type SessionRecord,
  type SessionStore,
  type Tool,
} from '@ravenclaw/core'
import { createProvider } from '@ravenclaw/providers'

export function createRootTools(store: SessionStore): Tool[] {
  const plan = createPlanModeTools(store)
  return [
    readTool,
    grepTool,
    globTool,
    editTool,
    writeTool,
    bashTool,
    skillTool,
    plan.enter,
    plan.exit,
  ]
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
    funding: 'byok',
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
}

export async function openEngine(opts: {
  provider: Provider
  store: SessionStore
  config: ResolvedConfig
  cwd: string
  askUser: SessionEngineOptions['askUser']
  session?: SessionRecord
  messages?: Message[]
}): Promise<SessionEngine> {
  const session = opts.session ?? newSessionRecord({
    cwd: opts.cwd,
    model: opts.config.model,
    permissionMode: opts.config.permissionMode,
  })
  if (!opts.session) await opts.store.createSession(session)

  const engineOpts: SessionEngineOptions = {
    session,
    provider: opts.provider,
    store: opts.store,
    tools: createRootTools(opts.store),
    compact: compactPolicyFromConfig(opts.config.compact),
    model: opts.config.profile,
    maxRounds: opts.config.maxRounds,
    askUser: opts.askUser,
    system: buildSystemParts({
      cwd: session.cwd,
      permissionMode: session.permissionMode,
    }),
  }
  if (opts.messages) engineOpts.messages = opts.messages
  return createSessionEngine(engineOpts)
}

export function providerFromConfig(config: ResolvedConfig): Provider {
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

export async function bootCli(opts: {
  flags: ConfigFlags
  cwd?: string
  ask?: AskBridge
}): Promise<CliRuntime> {
  const home = await ensureHomeDir()
  const config = loadConfig({ home, flags: opts.flags })
  const store = createSqliteStore(join(home, 'state.db'))
  const provider = providerFromConfig(config)
  const cwd = opts.cwd ?? process.cwd()
  const ask = opts.ask ?? createAskBridge()
  const engine = await openEngine({
    provider,
    store,
    config,
    cwd,
    askUser: ask.ask,
  })
  return { engine, store, provider, config, cwd, ask }
}

export async function resumeRuntime(
  runtime: CliRuntime,
  sessionId: string,
): Promise<CliRuntime> {
  const loaded = await resumeSession(runtime.store, sessionId)
  const engine = await openEngine({
    provider: runtime.provider,
    store: runtime.store,
    config: runtime.config,
    cwd: loaded.session.cwd,
    askUser: runtime.ask.ask,
    session: loaded.session,
    messages: loaded.messages,
  })
  return { ...runtime, engine, cwd: loaded.session.cwd }
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
