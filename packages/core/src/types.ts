export type ApiMode = 'openai_compat' | 'anthropic_messages' | 'openai_responses'
export type SystemTier = 'stable' | 'context' | 'volatile'

export interface SystemPart {
  tier: SystemTier
  text: string
  cacheBreakpoint?: boolean
}

export interface ModelProfile {
  id: string
  contextWindow: number
  reserveOutputTokens: number // min(20_000, floor(0.10 * contextWindow))
  inputUsdPerMTok: number
  outputUsdPerMTok: number
  cacheReadUsdPerMTok: number
  cacheWriteUsdPerMTok: number
  supportsThinking: boolean
}

export interface ProviderRequest {
  model: string
  system: SystemPart[]
  messages: Message[]
  tools: Array<{ name: string; description: string; inputSchema: unknown }>
  maxTokens: number
}

export type ProviderChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'stop'; reason: string | null }

export interface ProviderErrorLike {
  retryable: boolean
  status?: number
  bytes?: number
}

export interface Provider {
  readonly id: string
  readonly apiMode: ApiMode
  profile(model: string): ModelProfile
  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk>
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk'
export type PermissionReason = 'rule' | 'mode' | 'safety' | 'user' | 'hook'
export type PermissionScope = 'session' | 'project' | 'user'
export type Funding = 'byok' | 'included'
export type PersistErrorCode = 'busy' | 'locked' | 'corrupt' | 'readonly' | 'unknown'
export type SessionLockHolderName = 'tui' | 'serve' | 'exec' | 'cron' | 'acp' | 'sdk'

export const SESSION_LOCK_TTL_MS = 120_000
export const SESSION_LOCK_RENEW_MS = 30_000

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'image'; mediaType: string; data: string }

export type UserOrToolBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }

export type Message =
  | {
      id: string
      role: 'user'
      blocks: UserOrToolBlock[]
      createdAt: number
    }
  | {
      id: string
      role: 'assistant'
      blocks: ContentBlock[]
      createdAt: number
      usage?: TokenUsage
    }
  | {
      id: string
      role: 'tool'
      toolUseId: string
      ok: boolean
      blocks: UserOrToolBlock[]
      persistPath?: string
      createdAt: number
    }

export interface Turn {
  id: string
  sessionId: string
  messages: Message[]
  round: number
  maxRounds: number
  graceUsed: boolean
  abort: AbortController
  permissionMode: PermissionMode
  prePlanMode?: PermissionMode
  usage: TokenUsage
  compactGeneration: number
  funding: Funding
  cwd: string
  /** Project root for permissions/skills. Unset means `cwd`. Isolated worktrees set this to the parent. */
  projectCwd?: string
  /** Extra working roots for path checks (AddDir). Unset means cwd only. */
  additionalDirectories?: string[]
  model: string
  readFiles: Set<string>
  skillAllowedTools?: string[]
  /** Realpaths of subdirectory AGENTS.md files already injected this session. */
  injectedAgentsDirs?: Set<string>
  /** MCP / plugin names selected via ToolSearch this turn. */
  unlockedToolNames?: string[]
  /** isEnabled snapshot for the wire prefix; later assembles look these up by name. */
  frozenToolNames?: string[]
  /** Same tool+args+result repeats this turn. Key is name + args + result text. */
  stallCounts?: Record<string, number>
}

export interface Round {
  index: number
  startedAt: number
  model: string
  toolCalls: Array<{ id: string; name: string; input: unknown }>
  toolResults: ToolResult[]
  end?: RoundEnd
}

export type StreamEvent =
  | { type: 'round_start'; round: number }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_progress'; id: string; text: string }
  | { type: 'tool_result'; id: string; result: ToolResult }
  | { type: 'status'; message: string }
  | { type: 'compact'; summary: string; generation: number }
  | {
      type: 'permission_ask'
      id: string
      tool: string
      input: unknown
      message: string
      saveAs?: PermissionScope
    }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'round_end'; end: RoundEnd }

export type RoundEnd =
  | { reason: 'completed' }
  | { reason: 'max_rounds'; round: number }
  | { reason: 'aborted' }
  | { reason: 'context_full' }
  | { reason: 'model_error'; error: unknown }
  | { reason: 'persist_failed'; error: unknown }
  | { reason: 'results_persist_failed'; error: unknown }

export interface Tool<I = unknown, O = unknown> {
  name: string
  description: string
  inputSchema: unknown
  isEnabled?(ctx: ToolContext): boolean
  parse(input: unknown): { ok: true; value: I } | { ok: false; message: string }
  isConcurrencySafe(input: I): boolean
  isReadOnly(input: I): boolean
  checkPermissions(input: I, ctx: ToolContext): Promise<PermissionDecision>
  execute(input: I, ctx: ToolContext): Promise<O>
  renderResult?(output: O): string
  interruptBehavior?(): 'cancel' | 'block'
}

export interface UserImage {
  mediaType: string
  data: string
}

export type UserSubmitInput =
  | string
  | {
      text?: string
      images?: UserImage[]
    }

export interface ToolContext {
  turn: Turn
  signal: AbortSignal
  onProgress: (text: string) => void
  tasks?: import('./tasks/registry').TaskRegistry
  fileHistory?: import('./session/file-history').FileHistory
}

export interface ToolResult {
  toolUseId: string
  ok: boolean
  content: string
  persistPath?: string
}

export type PermissionDecision =
  | { behavior: 'allow'; reason: PermissionReason }
  | { behavior: 'deny'; reason: PermissionReason; message: string }
  | { behavior: 'ask'; message: string; saveAs?: PermissionScope }

export interface CompactPolicy {
  enabled: boolean
  autoCompactBuffer: number
  blockingBufferWhenManual: number
  protectLastMessages: number
  keepRecentFiles: number
  maxCharsPerRestoredFile: number
  maxCharsRestoredFilesTotal: number
  maxCharsPerRestoredSkill: number
  maxCharsRestoredSkillsTotal: number
  maxConsecutiveFailures: number
  llmSummarize: boolean
  cacheExpiryMs?: number
  cacheExpiryMinTokens?: number
}

export interface AgentDefinition {
  id: string
  displayName: string
  model?: string
  toolNames: string[]
  spawnableAgents: string[]
  systemPrompt?: string
  inheritParentSystemPrompt?: boolean
  includeMessageHistory: boolean
  maxRounds: number
  compactContext?: CompactPolicy
  outputMode: 'last_message' | 'all_messages'
}

export interface SessionRecord {
  id: string
  createdAt: number
  updatedAt: number
  cwd: string
  model: string
  permissionMode: PermissionMode
  prePlanMode?: PermissionMode
  compactGeneration: number
  usage: TokenUsage
  title?: string
  parentSessionId?: string
  funding: Funding
}

export interface SessionListFilter {
  cwd?: string
  parentSessionId?: string | null
  limit?: number
}

export interface PermissionRule {
  id: string
  sessionId: string
  tool: string
  spec: unknown
  behavior: 'allow' | 'deny' | 'ask'
}

export class PersistError extends Error {
  readonly code: PersistErrorCode
  constructor(code: PersistErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'PersistError'
  }
}

export class SessionLockError extends Error {
  readonly holderName?: string
  readonly expiresAt?: number
  constructor(message: string, info?: { holderName?: string; expiresAt?: number }) {
    super(message)
    this.name = 'SessionLockError'
    if (info?.holderName !== undefined) this.holderName = info.holderName
    if (info?.expiresAt !== undefined) this.expiresAt = info.expiresAt
  }
}

export function sessionLockedMessage(holderName: string | undefined, expiresAt: number): string {
  const who = holderName !== undefined && holderName !== '' ? holderName : 'another process'
  return `session locked by ${who} until ${new Date(expiresAt).toISOString()}`
}

export interface SessionStore {
  createSession(session: SessionRecord): Promise<void>
  upsertSession(session: SessionRecord): Promise<void>
  listSessions(filter?: SessionListFilter): Promise<SessionRecord[]>
  loadSession(sessionId: string): Promise<{ session: SessionRecord; messages: Message[] }>
  deleteSession(sessionId: string): Promise<void>
  persistUser(sessionId: string, message: Extract<Message, { role: 'user' }>): Promise<void>
  /**
   * Text-only assistant completions (no tool_use). Do not call for a tool-use round.
   */
  persistAssistant(sessionId: string, message: Extract<Message, { role: 'assistant' }>): Promise<void>
  /**
   * Persist-before-execute; this IS the durable write of the assistant row with tool_use.
   * Do not also call persistAssistant for the same row.
   */
  persistToolCalls(sessionId: string, message: Extract<Message, { role: 'assistant' }>): Promise<void>
  persistToolResults(sessionId: string, messages: Array<Extract<Message, { role: 'tool' }>>): Promise<void>
  setPermissionRules(sessionId: string, rules: PermissionRule[]): Promise<void>
  listPermissionRules(sessionId: string): Promise<PermissionRule[]>
  recordCompact(
    sessionId: string,
    generation: number,
    summary: string,
    inactivatedIds: string[],
  ): Promise<void>
  enqueueAgentMail(parentSessionId: string, text: string): Promise<void>
  peekAgentMail(parentSessionId: string): Promise<string[]>
  drainAgentMail(parentSessionId: string): Promise<string[]>
  acquireSessionLock(
    sessionId: string,
    opts: {
      holderId: string
      holderName: string
      ttlMs?: number
    },
  ): Promise<void>
  renewSessionLock(sessionId: string, holderId: string, ttlMs?: number): Promise<void>
  releaseSessionLock(sessionId: string, holderId: string): Promise<void>
  withWrite<T>(fn: () => Promise<T>): Promise<T>
}

export interface SessionEngineOptions {
  session: SessionRecord
  messages?: Message[]
  provider: Provider
  store: SessionStore
  tools: Tool[]
  compact: CompactPolicy
  model: ModelProfile
  maxRounds: number
  system?: SystemPart[]
  hooks?: import('./permissions/hooks').PermissionHook[]
  fallbackModel?: string
  jsonSchema?: unknown
  bare?: boolean
  additionalDirectories?: string[]
  sessionLock?: {
    holderId: string
    ttlMs?: number
  }
  /** When true, nudge if the turn mutated files without a test/lint command. Default off. */
  verifyOnStop?: boolean
  askUser: (
    e: Extract<StreamEvent, { type: 'permission_ask' }>,
    signal: AbortSignal,
  ) => Promise<'allow' | 'deny' | 'allow_always'>
}

export interface SessionEngine {
  readonly session: SessionRecord
  readonly tasks: import('./tasks/registry').TaskRegistry
  readonly fileHistory: import('./session/file-history').FileHistory
  submitMessage(input: UserSubmitInput): AsyncGenerator<StreamEvent, RoundEnd>
  enqueueSteer(text: string): void
  drainSteering(): string[]
  rewindLast(): Promise<{ ok: boolean; notice: string }>
  compactNow(): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  reloadSystem(system: SystemPart[]): void
  abort(): void
  /** Fire SessionEnd once, then release the session lock. Safe to call more than once. */
  close(opts?: { releaseLock?: boolean }): Promise<void>
}

export interface QueryLoopOptions {
  turn: Turn
  tools: Tool[]
  provider: Provider
  store: SessionStore
  compact: CompactPolicy
  model: ModelProfile
  system?: SystemPart[]
  hooks?: SessionEngineOptions['hooks']
  askUser: SessionEngineOptions['askUser']
  tasks?: import('./tasks/registry').TaskRegistry
  fileHistory?: import('./session/file-history').FileHistory
  drainSteering?: () => string[]
  fallbackModel?: string
  jsonSchema?: unknown
  verifyOnStop?: boolean
  lifecycle?: {
    run(
      event: string,
      payload: Record<string, unknown>,
    ): Promise<
      | {
          preventContinuation?: boolean
          message?: string
          updatedInput?: Record<string, unknown>
        }
      | undefined
    >
  }
}
