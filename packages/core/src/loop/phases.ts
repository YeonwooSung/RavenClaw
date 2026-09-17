import { resolve } from 'node:path'
import type {
  ContentBlock,
  Message,
  ProviderErrorLike,
  ProviderRequest,
  QueryLoopOptions,
  RoundEnd,
  StreamEvent,
  TokenUsage,
  Tool,
  ToolContext,
  Turn,
} from '../types'
import { getLastRequestAt, markLastRequestAt } from '../compact/last-request'
import { shouldAutocompact } from '../compact/policy'
import { getModelProfile } from '../cost/models'
import { takeChildOutput } from '../tools/set-output'
import { applyToolResultBudget, microcompact, runAutocompact } from '../compact/prune'
import { compactSummary } from '../compact/summarize'
import { decidePermission } from '../permissions/pipeline'
import type { PermissionRuleSet } from '../permissions/types'
import {
  appendPermissionRule,
  commandOrPath,
  loadPermissionRules,
  persistAllowAlways,
} from '../permissions/rules'
import { isAbortError, nextOrAbort } from './abort'
import { formatSettledOutput } from './format-output'
import { partitionToolCalls } from '../tools/partition'
import { toolCallTool } from '../tools/tool-call'
import { forgetReadsNotInTail, stampReadMtime } from '../tools/read-files'
import { normalizeTodoWriteItems, type TodoWriteInput } from '../tools/todo'
import { filterToolsForTurn } from '../tools/skill'
import { appendDeferredMcpTools } from '../mcp/tools'
import { estimateTokens, shouldEnterGrace, suffixGraceNotice } from './budget'
import {
  denyText,
  executeFailedText,
  makeToolMessage,
  pairMissing,
  parseFailedText,
  resolveToolAlias,
  unknownToolText,
} from './pairing'
import { repairRoleAlternation, selectProtectedTail } from './repair'
import { loadNearestSubdirAgents } from '../prompt/subdir-agents'
import { injectMidTurnHint } from '../prompt/cache'
import type { PendingAsk } from '../session/pending-asks'

export interface LoopState extends QueryLoopOptions {
  lastHadToolUse: boolean
  pendingText: string
  pendingThinking: string
  pendingToolCalls: Array<{ id: string; name: string; input: unknown }>
  pendingUsage: TokenUsage
  streamAborted: boolean
  assistantMessage: Extract<Message, { role: 'assistant' }> | null
  toolResults: Array<Extract<Message, { role: 'tool' }>>
  compactFailures: number
  overflowCompacted: boolean
  lastStopReason: string | null
  fallbackUsed: boolean
  outputEscalated: boolean
  outputNudges: number
  schemaNudges: number
  emptyNudges: number
  thinkingNudges: number
  stopNudges: number
  verifyNudges: number
  mutatedThisTurn: boolean
  sawVerifyCommand: boolean
  lastEmptyFingerprint?: string
}

const EMPTY_COMPLETION_NUDGE =
  'Your previous reply was empty. Continue the task. Use tools if you need information. Do not apologize.'

const THINKING_ONLY_NUDGE = 'Continue with visible text; do not recap.'

const TRUNCATION_NUDGE =
  'Your previous reply was cut off. Continue from where you left off. Do not recap.'

const STRUCTURED_OUTPUT_NUDGE =
  'Call StructuredOutput now with the final object that matches the required JSON schema. Do not answer in prose.'

const VERIFY_ON_STOP_NUDGE =
  'Code changed this turn but no test or lint command ran. Run the project\'s test or lint command now, or say you are skipping verification.'

const EMPTY_NUDGE_DEFAULT_CAP = 3
const EMPTY_NUDGE_EXPENSIVE_CAP = 1
const EMPTY_NUDGE_COST_USD = 0.25

const VERIFY_COMMAND =
  /\b(test|lint|typecheck|tsc|vitest|jest|bun test|npm test|pytest|cargo test|go test)\b/i

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'ApplyPatch', 'NotebookEdit'])

export type PhaseResult =
  | { action: 'continue' }
  | { action: 'break' }
  | { action: 'return'; end: RoundEnd }

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function abortEnd(turn: Turn): RoundEnd {
  return turn.cancelKind === 'cancel' ? { reason: 'cancelled' } : { reason: 'aborted' }
}

function resetPending(state: LoopState): void {
  state.pendingText = ''
  state.pendingThinking = ''
  state.pendingToolCalls = []
  state.pendingUsage = { ...ZERO_USAGE }
  state.streamAborted = false
  state.assistantMessage = null
  state.toolResults = []
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isProviderErrorLike(error: unknown): error is ProviderErrorLike {
  return typeof error === 'object' && error !== null && 'retryable' in error
}

function isAuthError(error: unknown): boolean {
  if (!isProviderErrorLike(error)) return false
  return error.status === 401 || error.status === 403
}

function isTruncatedStop(reason: string | null): boolean {
  if (reason === null || reason === '') return false
  const n = reason.toLowerCase()
  return n.includes('max_token') || n.includes('length') || n === 'max_output_tokens'
}

const ESCALATED_OUTPUT_TOKENS = 64_000
const ESCALATE_CONTEXT_GUARD = 1_000

export function escalatedOutputTokens(model: { contextWindow: number; reserveOutputTokens: number }): number | null {
  const next = Math.min(ESCALATED_OUTPUT_TOKENS, model.contextWindow - ESCALATE_CONTEXT_GUARD)
  if (!Number.isFinite(next) || next <= model.reserveOutputTokens) return null
  return next
}

function requestMaxTokens(state: LoopState): number {
  if (!state.outputEscalated) return state.model.reserveOutputTokens
  return escalatedOutputTokens(state.model) ?? state.model.reserveOutputTokens
}

function isRetryable(error: unknown): boolean {
  if (isAuthError(error)) return false
  return isProviderErrorLike(error) && error.retryable
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function buildAssistantMessage(
  state: LoopState,
): Extract<Message, { role: 'assistant' }> {
  const blocks: ContentBlock[] = []
  if (state.pendingThinking) blocks.push({ type: 'thinking', text: state.pendingThinking })
  if (state.pendingText) blocks.push({ type: 'text', text: state.pendingText })
  for (const call of state.pendingToolCalls) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
  }
  const msg: Extract<Message, { role: 'assistant' }> = {
    id: crypto.randomUUID(),
    role: 'assistant',
    blocks,
    createdAt: Date.now(),
  }
  if (
    state.pendingUsage.input ||
    state.pendingUsage.output ||
    state.pendingUsage.cacheRead ||
    state.pendingUsage.cacheWrite
  ) {
    msg.usage = { ...state.pendingUsage }
  }
  return msg
}

async function deletePendingForResults(
  state: LoopState,
  results: Array<Extract<Message, { role: 'tool' }>>,
): Promise<void> {
  for (const row of results) {
    await state.store.deletePendingAsk(row.toolUseId)
  }
}

export async function persistResultsWithRetry(
  state: LoopState,
  results: Array<Extract<Message, { role: 'tool' }>>,
): Promise<RoundEnd | undefined> {
  try {
    await state.store.persistToolResults(state.turn.sessionId, results)
  } catch (first) {
    const incomplete = pairMissing(
      results.map((row) => row.toolUseId),
      'incomplete',
    )
    try {
      await state.store.persistToolResults(state.turn.sessionId, incomplete)
    } catch (second) {
      return { reason: 'results_persist_failed', error: second }
    }
    for (const row of incomplete) {
      const idx = state.turn.messages.findIndex(
        (msg) => msg.role === 'tool' && msg.toolUseId === row.toolUseId,
      )
      if (idx >= 0) state.turn.messages[idx] = row
    }
    state.toolResults = incomplete
    await deletePendingForResults(state, incomplete)
    return { reason: 'results_persist_failed', error: first }
  }
  await deletePendingForResults(state, results)
  return undefined
}

export async function* beginRound(state: LoopState): AsyncGenerator<StreamEvent, PhaseResult> {
  if (state.turn.abort.signal.aborted) {
    return { action: 'return', end: abortEnd(state.turn) }
  }

  if (shouldEnterGrace(state.turn, state.lastHadToolUse)) {
    state.turn.graceUsed = true
    resetPending(state)
    yield { type: 'round_start', round: state.turn.round, turnId: state.turn.id }
    return { action: 'continue' }
  }

  if (state.turn.round >= state.turn.maxRounds) {
    return { action: 'return', end: { reason: 'max_rounds', round: state.turn.round } }
  }

  state.turn.round += 1
  resetPending(state)
  yield { type: 'round_start', round: state.turn.round, turnId: state.turn.id }
  return { action: 'continue' }
}

export async function prepareContext(state: LoopState): Promise<PhaseResult> {
  const before = new Set(state.turn.messages.map((msg) => msg.id))
  const open = await state.store.listPendingAsks(state.turn.sessionId)
  const repaired = repairRoleAlternation(
    state.turn.messages,
    new Set(open.map((row) => row.callId)),
  )
  state.turn.messages = repaired
  const inserted = repaired.filter(
    (msg): msg is Extract<Message, { role: 'tool' }> =>
      msg.role === 'tool' && !before.has(msg.id),
  )
  if (inserted.length > 0) {
    await state.store.persistToolResults(state.turn.sessionId, inserted)
  }
  await injectSteering(state)
  return { action: 'continue' }
}

function lastAnchoredTokens(messages: Message[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'assistant' && msg.usage) {
      return msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite
    }
  }
  return undefined
}

function compactDecision(state: LoopState): 'skip' | 'compact' | 'context_full' {
  const anchoredTokens = lastAnchoredTokens(state.turn.messages)
  const lastRequestAt = getLastRequestAt(state.turn.sessionId)
  const opts: Parameters<typeof shouldAutocompact>[0] = {
    enabled: state.compact.enabled,
    estimatedTokens: estimateTokens(state.turn.messages),
    model: state.model,
    compact: state.compact,
    consecutiveFailures: state.compactFailures,
  }
  if (anchoredTokens !== undefined) opts.anchoredTokens = anchoredTokens
  if (lastRequestAt !== undefined) opts.lastRequestAt = lastRequestAt
  return shouldAutocompact(opts)
}

export async function* maybeCompact(
  state: LoopState,
): AsyncGenerator<StreamEvent, PhaseResult> {
  const decision = compactDecision(state)
  if (!state.compact.enabled || state.compactFailures >= state.compact.maxConsecutiveFailures) {
    if (decision === 'context_full') {
      return { action: 'return', end: { reason: 'context_full' } }
    }
    return { action: 'continue' }
  }

  state.turn.messages = applyToolResultBudget(state.turn.messages)
  state.turn.messages = microcompact(state.turn.messages, state.compact.protectLastMessages)
  forgetReadsNotInTail(state.turn, state.turn.messages)

  const afterCheap = compactDecision(state)
  if (afterCheap === 'context_full') {
    return { action: 'return', end: { reason: 'context_full' } }
  }
  if (afterCheap !== 'compact') return { action: 'continue' }

  const tail = selectProtectedTail(state.turn.messages, state.compact.protectLastMessages)
  const cut = state.turn.messages.length - tail.length
  if (cut <= 0) return { action: 'continue' }

  const middle = state.turn.messages.slice(0, cut)
  try {
    const summary = await compactSummary(
      middle,
      state.compact,
      state.provider,
      state.model,
      state.turn.abort.signal,
    )
    const result = await runAutocompact({
      messages: state.turn.messages,
      compact: state.compact,
      model: state.model,
      store: state.store,
      sessionId: state.turn.sessionId,
      generation: state.turn.compactGeneration,
      summary,
      cwd: state.turn.projectCwd ?? state.turn.cwd,
      ...(state.todos !== undefined ? { todos: state.todos } : {}),
    })
    state.turn.messages = result.messages
    forgetReadsNotInTail(state.turn, result.messages)
    state.turn.compactGeneration = result.generation
    state.compactFailures = 0
    state.overflowCompacted = true
    yield { type: 'compact', summary, generation: result.generation }
    return { action: 'continue' }
  } catch {
    state.compactFailures += 1
    if (
      state.compactFailures >= state.compact.maxConsecutiveFailures &&
      compactDecision(state) === 'context_full'
    ) {
      return { action: 'return', end: { reason: 'context_full' } }
    }
    return { action: 'continue' }
  }
}

export function assembleRequest(state: LoopState): ProviderRequest {
  let messages = state.turn.graceUsed
    ? suffixGraceNotice(state.turn.messages)
    : state.turn.messages
  if (!state.model.supportsThinking) {
    messages = messages.map((msg) => {
      if (msg.role !== 'assistant') return msg
      return { ...msg, blocks: msg.blocks.filter((block) => block.type !== 'thinking') }
    })
  }
  const tools = state.turn.graceUsed ? [] : wireToolsForTurn(state)
  return {
    model: state.turn.model,
    system: state.system ?? [],
    messages,
    tools,
    maxTokens: requestMaxTokens(state),
  }
}

const STALL_TEXT = 'stall: same tool+args+result repeated 3 times; change approach.'
const TOOLCALL_BRIDGES = new Set(['ToolCall', 'ToolSearch'])

function snapshotFrozenNames(state: LoopState): string[] {
  return filterToolsForTurn(state.tools, state.turn).map((tool) => tool.name)
}

function wireToolsForTurn(
  state: LoopState,
): Array<{ name: string; description: string; inputSchema: unknown }> {
  if (state.turn.frozenToolNames === undefined) {
    state.turn.frozenToolNames = snapshotFrozenNames(state)
  }
  const byName = new Map(state.tools.map((tool) => [tool.name, tool]))
  const tools: Array<{ name: string; description: string; inputSchema: unknown }> = []
  for (const name of state.turn.frozenToolNames) {
    const tool = byName.get(name)
    if (!tool) continue
    tools.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })
  }
  return tools
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function stableValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stableValue)
  const rec = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(rec).sort()) {
    out[key] = stableValue(rec[key])
  }
  return out
}

function stallPrefix(name: string, input: unknown): string {
  return `${name}\0${stableJson(input)}\0`
}

function stallKey(name: string, input: unknown, resultText: string): string {
  return `${stallPrefix(name, input)}${resultText}`
}

function isStalled(state: LoopState, name: string, input: unknown): boolean {
  const counts = state.turn.stallCounts
  if (!counts) return false
  const prefix = stallPrefix(name, input)
  for (const [key, count] of Object.entries(counts)) {
    if (key.startsWith(prefix) && count >= 3) return true
  }
  return false
}

function recordStall(state: LoopState, name: string, input: unknown, resultText: string): void {
  const key = stallKey(name, input, resultText)
  if (!state.turn.stallCounts) state.turn.stallCounts = {}
  state.turn.stallCounts[key] = (state.turn.stallCounts[key] ?? 0) + 1
}

function toolCallTargetText(name: string): string {
  return `unknown_tool: '${name}' is not a deferred ToolCall target.`
}

function resolveCallTool(
  state: LoopState,
  call: { id: string; name: string; input: unknown },
):
  | { ok: true; tool: Tool; name: string; input: unknown }
  | { ok: false; message: string } {
  const enabled = filterToolsForTurn(state.tools, state.turn)
  if (call.name !== 'ToolCall') {
    const tool = enabled.find((entry) => entry.name === call.name)
    if (tool) return { ok: true, tool, name: call.name, input: call.input }
    const alias = resolveToolAlias(
      call.name,
      enabled.map((entry) => entry.name),
    )
    if (alias) {
      const aliased = enabled.find((entry) => entry.name === alias)
      if (aliased) return { ok: true, tool: aliased, name: alias, input: call.input }
    }
    return { ok: false, message: unknownToolText(call.name) }
  }

  const bridge = enabled.find((entry) => entry.name === 'ToolCall')
  if (!bridge) return { ok: false, message: unknownToolText('ToolCall') }
  const parsed = toolCallTool.parse(call.input)
  if (!parsed.ok) return { ok: false, message: parseFailedText(parsed.message) }
  const requested = parsed.value.name
  const alias = resolveToolAlias(
    requested,
    state.tools.map((entry) => entry.name),
  )
  const realName = alias ?? requested
  if (TOOLCALL_BRIDGES.has(realName)) return { ok: false, message: toolCallTargetText(realName) }
  const frozen = state.turn.frozenToolNames ?? snapshotFrozenNames(state)
  if (frozen.includes(realName)) return { ok: false, message: toolCallTargetText(realName) }
  const real = state.tools.find((entry) => entry.name === realName)
  if (!real) return { ok: false, message: unknownToolText(requested) }
  if (!skillAllowsName(state.turn, realName)) {
    return { ok: false, message: unknownToolText(requested) }
  }
  return { ok: true, tool: real, name: realName, input: parsed.value.arguments }
}

function skillAllowsName(turn: Turn, name: string): boolean {
  if (turn.skillAllowedTools === undefined) return true
  if (turn.skillAllowedTools.includes(name)) return true
  return name === 'Skill' || name === 'EnterPlanMode' || name === 'ExitPlanMode' || name === 'Agent'
}

const CONTEXT_OVERFLOW = /prompt too long|context.?length|too many tokens/i

function isContextOverflow(error: unknown): boolean {
  if (isProviderErrorLike(error) && error.status === 413) return true
  return CONTEXT_OVERFLOW.test(errorMessage(error))
}

export async function* streamModel(
  state: LoopState,
  req: ProviderRequest,
): AsyncGenerator<StreamEvent, PhaseResult> {
  const maxTries = 8
  const baseMs = 500
  let compactRetried = false
  let current = req

  for (let attempt = 0; attempt < maxTries; attempt++) {
    if (state.turn.abort.signal.aborted) {
      state.streamAborted = true
      return { action: 'continue' }
    }

    state.pendingText = ''
    state.pendingThinking = ''
    state.pendingToolCalls = []
    state.streamAborted = false
    state.lastStopReason = null

    try {
      const iterator = state.provider
        .stream(current, state.turn.abort.signal)
        [Symbol.asyncIterator]()
      markLastRequestAt(state.turn.sessionId)
      while (true) {
        const step = await nextOrAbort(iterator, state.turn.abort.signal)
        if (step === 'aborted') {
          state.streamAborted = true
          try {
            await iterator.return?.()
          } catch {
            // ignore iterator cleanup
          }
          return { action: 'continue' }
        }
        if (step.done) break
        const chunk = step.value
        switch (chunk.type) {
          case 'text_delta':
            state.pendingText += chunk.text
            yield { type: 'text_delta', text: chunk.text }
            break
          case 'thinking_delta':
            state.pendingThinking += chunk.text
            yield { type: 'thinking_delta', text: chunk.text }
            break
          case 'tool_call':
            state.pendingToolCalls.push({
              id: chunk.id,
              name: chunk.name,
              input: chunk.input,
            })
            yield { type: 'tool_call', id: chunk.id, name: chunk.name, input: chunk.input }
            break
          case 'usage':
            state.pendingUsage = chunk.usage
            state.turn.usage = addUsage(state.turn.usage, chunk.usage)
            yield { type: 'usage', usage: chunk.usage }
            break
          case 'stop':
            state.lastStopReason = chunk.reason
            break
        }
      }
      const bumped = escalatedOutputTokens(state.model)
      if (
        bumped !== null &&
        !state.outputEscalated &&
        current.maxTokens < bumped &&
        state.pendingToolCalls.length === 0 &&
        isTruncatedStop(state.lastStopReason)
      ) {
        state.outputEscalated = true
        current = { ...current, maxTokens: bumped }
        yield { type: 'status', message: 'output truncated; escalating' }
        continue
      }
      return { action: 'continue' }
    } catch (error) {
      if (isAbortError(error) || state.turn.abort.signal.aborted) {
        state.streamAborted = true
        return { action: 'continue' }
      }
      if (isContextOverflow(error)) {
        if (compactRetried || state.overflowCompacted) {
          return { action: 'return', end: { reason: 'context_full' } }
        }
        compactRetried = true
        const recovered = yield* reactiveCompact(state)
        if (recovered.aborted) {
          state.streamAborted = true
          return { action: 'continue' }
        }
        if (!recovered.ok) {
          return { action: 'return', end: { reason: 'model_error', error } }
        }
        current = assembleRequest(state)
        attempt = -1
        continue
      }
      if (isAuthError(error) || !isRetryable(error)) {
        return { action: 'return', end: { reason: 'model_error', error } }
      }
      const fallback = state.fallbackModel
      if (
        fallback !== undefined &&
        fallback !== '' &&
        fallback !== state.turn.model &&
        !state.fallbackUsed
      ) {
        state.fallbackUsed = true
        state.turn.model = fallback
        state.model = getModelProfile(fallback)
        yield { type: 'status', message: `fallback model ${fallback}` }
        current = assembleRequest(state)
        attempt = -1
        continue
      }
      if (attempt === maxTries - 1) {
        return { action: 'return', end: { reason: 'model_error', error } }
      }
      const backoff = baseMs * 2 ** attempt
      const jitter = Math.random() * backoff * 0.25
      await sleep(backoff + jitter)
    }
  }

  return {
    action: 'return',
    end: { reason: 'model_error', error: new Error('retries exhausted') },
  }
}

async function* reactiveCompact(
  state: LoopState,
): AsyncGenerator<StreamEvent, { ok: boolean; aborted: boolean }> {
  if (state.turn.abort.signal.aborted) return { ok: false, aborted: true }
  try {
    const tail = selectProtectedTail(state.turn.messages, state.compact.protectLastMessages)
    const cut = state.turn.messages.length - tail.length
    if (cut <= 0) return { ok: false, aborted: false }
    const middle = state.turn.messages.slice(0, cut)
    const summary = await compactSummary(
      middle,
      state.compact,
      state.provider,
      state.model,
      state.turn.abort.signal,
    )
    if (state.turn.abort.signal.aborted) return { ok: false, aborted: true }
    const result = await runAutocompact({
      messages: state.turn.messages,
      compact: state.compact,
      model: state.model,
      store: state.store,
      sessionId: state.turn.sessionId,
      generation: state.turn.compactGeneration,
      summary,
      cwd: state.turn.projectCwd ?? state.turn.cwd,
      ...(state.todos !== undefined ? { todos: state.todos } : {}),
    })
    state.turn.messages = result.messages
    forgetReadsNotInTail(state.turn, result.messages)
    state.turn.compactGeneration = result.generation
    state.overflowCompacted = true
    yield { type: 'compact', summary, generation: result.generation }
    return { ok: true, aborted: false }
  } catch (error) {
    if (isAbortError(error) || state.turn.abort.signal.aborted) {
      return { ok: false, aborted: true }
    }
    return { ok: false, aborted: false }
  }
}

export async function* normalizeResponse(
  state: LoopState,
): AsyncGenerator<StreamEvent, PhaseResult> {
  const asst = buildAssistantMessage(state)
  state.assistantMessage = asst
  const aborted = state.streamAborted || state.turn.abort.signal.aborted
  const hasTools = state.pendingToolCalls.length > 0

  if (aborted) {
    if (hasTools) {
      state.turn.messages.push(asst)
      try {
        await state.store.persistToolCalls(state.turn.sessionId, asst)
      } catch {
        // still pair in memory
      }
      const paired = pairMissing(
        state.pendingToolCalls.map((call) => call.id),
        'aborted',
      )
      state.turn.messages.push(...paired)
      try {
        await state.store.persistToolResults(state.turn.sessionId, paired)
      } catch {
        // abort still wins
      }
    } else if (state.pendingText || state.pendingThinking) {
      state.turn.messages.push(asst)
    }
    yield { type: 'status', message: 'interrupted' }
    return { action: 'return', end: abortEnd(state.turn) }
  }

  if (!hasTools) {
    if (isTruncatedStop(state.lastStopReason) && state.outputNudges < 3) {
      state.outputNudges += 1
      const fail = await applyMidTurnHint(state, asst, TRUNCATION_NUDGE)
      if (fail) return { action: 'return', end: fail }
      yield { type: 'status', message: 'output truncated; continuing' }
      return { action: 'continue' }
    }
    if (isEmptyCompletion(state)) {
      if (state.pendingThinking.trim() !== '' && state.thinkingNudges < 2) {
        state.thinkingNudges += 1
        const fail = await applyMidTurnHint(state, asst, THINKING_ONLY_NUDGE)
        if (fail) return { action: 'return', end: fail }
        yield { type: 'status', message: 'thinking-only; continuing' }
        return { action: 'continue' }
      }
      const fp = emptyFingerprint(state)
      const identical =
        state.lastEmptyFingerprint !== undefined && state.lastEmptyFingerprint === fp
      const cap = emptyNudgeCap(state)
      state.lastEmptyFingerprint = fp
      if (!identical && state.emptyNudges < cap) {
        state.emptyNudges += 1
        const fail = await applyMidTurnHint(state, asst, EMPTY_COMPLETION_NUDGE)
        if (fail) return { action: 'return', end: fail }
        yield { type: 'status', message: 'empty completion; retrying' }
        return { action: 'continue' }
      }
    }
    if (state.turn.graceUsed) {
      const stopped = yield* runStopHook(state, asst, { reason: 'max_rounds', round: state.turn.round })
      if (stopped) return stopped
      const fail = await persistAssistantOnce(state, asst)
      if (fail) return { action: 'return', end: fail }
      return { action: 'return', end: { reason: 'max_rounds', round: state.turn.round } }
    }
    if (
      state.jsonSchema !== undefined &&
      takeChildOutput(state.turn.sessionId) === undefined &&
      state.schemaNudges < 2
    ) {
      state.schemaNudges += 1
      const fail = await applyMidTurnHint(state, asst, STRUCTURED_OUTPUT_NUDGE)
      if (fail) return { action: 'return', end: fail }
      yield { type: 'status', message: 'structured output required' }
      return { action: 'continue' }
    }
    if (shouldVerifyOnStop(state)) {
      state.verifyNudges += 1
      const fail = await applyMidTurnHint(state, asst, VERIFY_ON_STOP_NUDGE)
      if (fail) return { action: 'return', end: fail }
      yield { type: 'status', message: 'verify on stop; retrying' }
      return { action: 'continue' }
    }
    const stopped = yield* runStopHook(state, asst, { reason: 'completed' })
    if (stopped) return stopped
    const fail = await persistAssistantOnce(state, asst)
    if (fail) return { action: 'return', end: fail }
    return { action: 'return', end: { reason: 'completed' } }
  }

  if (state.turn.graceUsed) {
    state.turn.messages.push(asst)
    try {
      await state.store.persistToolCalls(state.turn.sessionId, asst)
    } catch (error) {
      const paired = pairMissing(
        state.pendingToolCalls.map((call) => call.id),
        'persist_failed',
      )
      state.turn.messages.push(...paired)
      return { action: 'return', end: { reason: 'persist_failed', error } }
    }
    const omitted = pairMissing(
      state.pendingToolCalls.map((call) => call.id),
      'tools_omitted',
    )
    state.turn.messages.push(...omitted)
    const fail = await persistResultsWithRetry(state, omitted)
    if (fail) return { action: 'return', end: fail }
    return { action: 'return', end: { reason: 'max_rounds', round: state.turn.round } }
  }

  return { action: 'continue' }
}

export async function* runToolRound(
  state: LoopState,
): AsyncGenerator<StreamEvent, PhaseResult> {
  const asst = state.assistantMessage ?? buildAssistantMessage(state)
  state.assistantMessage = asst
  if (!state.turn.messages.some((msg) => msg.id === asst.id)) {
    state.turn.messages.push(asst)
  }

  try {
    await state.store.persistToolCalls(state.turn.sessionId, asst)
  } catch (error) {
    const paired = pairMissing(
      state.pendingToolCalls.map((call) => call.id),
      'persist_failed',
    )
    state.turn.messages.push(...paired)
    return { action: 'return', end: { reason: 'persist_failed', error } }
  }

  const results: Array<Extract<Message, { role: 'tool' }>> = []
  const calls = state.pendingToolCalls
  const box: { rules: PermissionRuleSet } = {
    rules: await loadPermissionRules({
      cwd: state.turn.projectCwd ?? state.turn.cwd,
      store: state.store,
      sessionId: state.turn.sessionId,
    }),
  }
  const serializedAsk = createAskSerializer()
  const batches = partitionToolCalls(calls, state.tools)
  let abortRest = false

  for (const batch of batches) {
    if (abortRest || state.turn.abort.signal.aborted) {
      const leftover = calls.filter(
        (call) => !results.some((row) => row.toolUseId === call.id),
      )
      if (leftover.length > 0) {
        results.push(...pairMissing(leftover.map((row) => row.id), 'aborted'))
      }
      break
    }

    const signal =
      batch.length > 1
        ? mergeAbortSignals(state.turn.abort.signal, BATCH_TIMEOUT_MS)
        : state.turn.abort.signal
    const live = createLiveEvents()
    const work = Promise.all(
      batch.map((call) => executeOneCall(state, call, box, serializedAsk, signal, live.emit)),
    )
    yield* live.drain(work.then(() => undefined))
    const settled = await work
    for (const item of settled) {
      results.push(...item.messages)
      for (const event of item.events) yield event
      if (item.abortRest) abortRest = true
    }
  }

  if (abortRest || state.turn.abort.signal.aborted) {
    const leftover = calls.filter(
      (call) => !results.some((row) => row.toolUseId === call.id),
    )
    if (leftover.length > 0) {
      results.push(...pairMissing(leftover.map((row) => row.id), 'aborted'))
    }
  }

  state.toolResults = results
  state.turn.messages.push(...results)
  state.lastHadToolUse = true

  if (state.turn.abort.signal.aborted) {
    const fail = await persistResultsWithRetry(state, results)
    if (fail) return { action: 'return', end: fail }
    yield { type: 'status', message: 'interrupted' }
    return { action: 'return', end: abortEnd(state.turn) }
  }

  await applyRefreshTools(state)
  return { action: 'continue' }
}

async function applyRefreshTools(state: LoopState): Promise<void> {
  if (!state.refreshTools) return
  try {
    const added = await state.refreshTools()
    if (!added || added.length === 0) return
    state.tools = appendDeferredMcpTools(state.tools, added)
  } catch {
    // one dead MCP server must not abort the session
  }
}

export async function* finalizeRound(
  state: LoopState,
): AsyncGenerator<StreamEvent, PhaseResult> {
  const fail = await persistResultsWithRetry(state, state.toolResults)
  if (fail) return { action: 'return', end: fail }
  const queued = await injectQueued(state)
  if (queued !== undefined) {
    yield { type: 'status', message: `queued: ${steerPreview(queued)}` }
  }
  const steered = await injectSteering(state)
  for (const text of steered) {
    yield { type: 'status', message: `steered: ${steerPreview(text)}` }
  }
  return { action: 'continue' }
}

async function injectQueued(state: LoopState): Promise<string | undefined> {
  const text = state.drainQueued?.()
  if (text === undefined || text.trim() === '') return undefined
  const injected = await injectHintTexts(state, [text])
  return injected[0]
}

async function injectSteering(state: LoopState): Promise<string[]> {
  return injectHintTexts(state, state.drainSteering?.() ?? [])
}

async function injectHintTexts(state: LoopState, texts: string[]): Promise<string[]> {
  if (texts.length === 0) return []
  const injected: string[] = []
  for (const text of texts) {
    const before = state.turn.messages
    let after = injectMidTurnHint(before, text)
    let mutation = hintMutation(before, after)
    try {
      await persistHintMutation(state, mutation)
    } catch {
      if (mutation.kind !== 'assistant') continue
      after = appendHintUser(before, text)
      mutation = hintMutation(before, after)
      try {
        await persistHintMutation(state, mutation)
      } catch {
        continue
      }
    }
    state.turn.messages = after
    injected.push(text)
  }
  return injected
}

function emptyNudgeCap(state: LoopState): number {
  const tokens = estimateTokens(state.turn.messages)
  const costUsd = (tokens * state.model.inputUsdPerMTok) / 1e6
  return costUsd > EMPTY_NUDGE_COST_USD ? EMPTY_NUDGE_EXPENSIVE_CAP : EMPTY_NUDGE_DEFAULT_CAP
}

function emptyFingerprint(state: LoopState): string {
  return `${state.pendingText}|${state.pendingThinking}|${state.lastStopReason}`
}

function assistantHasPersistableContent(
  asst: Extract<Message, { role: 'assistant' }>,
): boolean {
  return asst.blocks.some(
    (block) =>
      block.type === 'tool_use' ||
      (block.type === 'thinking' && block.text !== '') ||
      (block.type === 'text' && block.text.trim() !== ''),
  )
}

function dropAssistantRow(
  messages: Message[],
  asst: Extract<Message, { role: 'assistant' }>,
): Message[] {
  return messages.filter((msg) => msg.id !== asst.id)
}

function pushAssistantIfNeeded(
  state: LoopState,
  asst: Extract<Message, { role: 'assistant' }>,
): void {
  if (!state.turn.messages.some((msg) => msg.id === asst.id)) {
    state.turn.messages.push(asst)
  }
}

export async function persistAssistantOnce(
  state: LoopState,
  asst: Extract<Message, { role: 'assistant' }>,
): Promise<RoundEnd | undefined> {
  if (!assistantHasPersistableContent(asst)) {
    state.turn.messages = dropAssistantRow(state.turn.messages, asst)
    return undefined
  }
  pushAssistantIfNeeded(state, asst)
  try {
    await state.store.persistAssistant(state.turn.sessionId, asst)
    return undefined
  } catch (error) {
    return { reason: 'persist_failed', error }
  }
}

async function* runStopHook(
  state: LoopState,
  asst: Extract<Message, { role: 'assistant' }>,
  end: Extract<RoundEnd, { reason: 'completed' | 'max_rounds' }>,
): AsyncGenerator<StreamEvent, PhaseResult | undefined> {
  if (!state.lifecycle) return undefined
  const stop = await state.lifecycle.run('Stop', {
    sessionId: state.turn.sessionId,
    reason: end.reason,
  })
  if (!stop) return undefined
  if (stop.preventContinuation === true) {
    const fail = await persistAssistantOnce(state, asst)
    if (fail) return { action: 'return', end: fail }
    if (stop.message) yield { type: 'status', message: stop.message }
    return { action: 'return', end: { reason: 'hook_stopped' } }
  }
  if (stop.message && end.reason === 'completed' && state.stopNudges < 1) {
    state.stopNudges += 1
    const fail = await applyMidTurnHint(state, asst, stop.message)
    if (fail) return { action: 'return', end: fail }
    yield { type: 'status', message: 'stop hook; continuing' }
    return { action: 'continue' }
  }
  if (stop.message) yield { type: 'status', message: stop.message }
  return undefined
}

async function applyMidTurnHint(
  state: LoopState,
  asst: Extract<Message, { role: 'assistant' }>,
  hint: string,
): Promise<RoundEnd | undefined> {
  pushAssistantIfNeeded(state, asst)
  const before = state.turn.messages
  const after = injectMidTurnHint(before, hint)
  const mutation = hintMutation(before, after)
  const hintedAsst =
    mutation.kind === 'assistant' && mutation.row?.role === 'assistant' && mutation.row.id === asst.id
      ? mutation.row
      : asst
  const persistable = assistantHasPersistableContent(hintedAsst)
  const next = persistable ? after : dropAssistantRow(after, asst)
  try {
    if (mutation.kind === 'assistant' && mutation.row?.role === 'assistant') {
      if (assistantHasPersistableContent(mutation.row)) {
        await state.store.persistAssistant(state.turn.sessionId, mutation.row)
      }
      state.turn.messages = next
      return undefined
    }
    if (persistable) {
      await state.store.persistAssistant(state.turn.sessionId, asst)
    }
    await persistHintMutation(state, mutation)
    state.turn.messages = next
    return undefined
  } catch (error) {
    return { reason: 'persist_failed', error }
  }
}

function hintMutation(
  before: Message[],
  after: Message[],
): { kind: 'tool' | 'assistant' | 'user' | 'none'; row: Message | null } {
  if (after.length === before.length) {
    for (let i = after.length - 1; i >= 0; i--) {
      const row = after[i]
      if (!row || row === before[i]) continue
      if (row.role === 'tool' || row.role === 'assistant' || row.role === 'user') {
        return { kind: row.role, row }
      }
    }
    return { kind: 'none', row: null }
  }
  const row = after[after.length - 1]
  if (row?.role === 'user') return { kind: 'user', row }
  return { kind: 'none', row: null }
}

function appendHintUser(messages: Message[], text: string): Message[] {
  const user: Extract<Message, { role: 'user' }> = {
    id: crypto.randomUUID(),
    role: 'user',
    blocks: [{ type: 'text', text }],
    createdAt: Date.now(),
  }
  return [...messages, user]
}

async function persistHintMutation(
  state: LoopState,
  mutation: { kind: 'tool' | 'assistant' | 'user' | 'none'; row: Message | null },
): Promise<void> {
  if (mutation.kind === 'tool' && mutation.row?.role === 'tool') {
    await state.store.persistToolResults(state.turn.sessionId, [mutation.row])
    return
  }
  if (mutation.kind === 'assistant' && mutation.row?.role === 'assistant') {
    await state.store.persistAssistant(state.turn.sessionId, mutation.row)
    return
  }
  if (mutation.kind === 'user' && mutation.row?.role === 'user') {
    await state.store.persistUser(state.turn.sessionId, mutation.row)
  }
}

function steerPreview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= 80 ? line : `${line.slice(0, 77)}...`
}

const BATCH_TIMEOUT_MS = 300_000

function mergeAbortSignals(parent: AbortSignal, timeoutMs: number): AbortSignal {
  const extra = new AbortController()
  const timer = setTimeout(() => extra.abort(), timeoutMs)
  const onParent = () => extra.abort()
  if (parent.aborted) extra.abort()
  else parent.addEventListener('abort', onParent, { once: true })
  extra.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer)
      parent.removeEventListener('abort', onParent)
    },
    { once: true },
  )
  return extra.signal
}

type SerializedAsk = <T>(fn: () => Promise<T>) => Promise<T>

function createLiveEvents(): {
  emit: (event: StreamEvent) => void
  drain: (done: Promise<void>) => AsyncGenerator<StreamEvent, void>
} {
  const queue: StreamEvent[] = []
  let notify: (() => void) | undefined
  return {
    emit(event) {
      queue.push(event)
      notify?.()
    },
    async *drain(done) {
      let settled = false
      const finished = done.then(
        () => {
          settled = true
          notify?.()
        },
        () => {
          settled = true
          notify?.()
        },
      )
      try {
        while (true) {
          if (queue.length > 0) {
            const next = queue.shift()
            if (next) yield next
            continue
          }
          if (settled) return
          await new Promise<void>((resolve) => {
            notify = resolve
            if (queue.length > 0 || settled) resolve()
          })
          notify = undefined
        }
      } finally {
        await finished
      }
    },
  }
}

async function executeOneCall(
  state: LoopState,
  call: { id: string; name: string; input: unknown },
  box: { rules: PermissionRuleSet },
  serializedAsk: SerializedAsk,
  signal: AbortSignal,
  emit: (event: StreamEvent) => void,
): Promise<{
  messages: Array<Extract<Message, { role: 'tool' }>>
  events: StreamEvent[]
  abortRest: boolean
}> {
  const events: StreamEvent[] = []
  if (signal.aborted) {
    return { messages: pairMissing([call.id], 'aborted'), events, abortRest: true }
  }

  const resolved = resolveCallTool(state, call)
  if (!resolved.ok) {
    return {
      messages: [makeToolMessage(call.id, false, resolved.message)],
      events,
      abortRest: false,
    }
  }
  const tool = resolved.tool
  const callName = resolved.name

  const parsed = tool.parse(resolved.input)
  if (!parsed.ok) {
    return {
      messages: [makeToolMessage(call.id, false, parseFailedText(parsed.message))],
      events,
      abortRest: false,
    }
  }
  let input = parsed.value

  if (state.lifecycle) {
    const pre = await state.lifecycle.run('PreToolUse', { name: callName, input })
    if (pre?.preventContinuation === true) {
      return {
        messages: [makeToolMessage(call.id, false, denyText(pre.message ?? 'stopped by hook'))],
        events,
        abortRest: false,
      }
    }
    if (pre?.updatedInput !== undefined) {
      const reparsed = tool.parse(pre.updatedInput)
      if (!reparsed.ok) {
        return {
          messages: [makeToolMessage(call.id, false, parseFailedText(reparsed.message))],
          events,
          abortRest: false,
        }
      }
      input = reparsed.value
    }
  }

  const progress: StreamEvent[] = []
  const ctx: ToolContext = {
    turn: state.turn,
    signal,
    onProgress: (text) => {
      progress.push({ type: 'tool_progress', id: call.id, text })
    },
  }
  if (state.tasks) ctx.tasks = state.tasks
  if (state.fileHistory) ctx.fileHistory = state.fileHistory
  if (state.store) ctx.store = state.store
  if (state.session) ctx.session = state.session

  let allowed = false
  try {
    const decision = await decidePermission({
      tool,
      name: callName,
      input,
      ctx,
      mode: state.turn.permissionMode,
      rules: box.rules,
      ...(state.hooks !== undefined ? { hooks: state.hooks } : {}),
    })
    if (decision.behavior === 'deny') {
      return {
        messages: [makeToolMessage(call.id, false, denyText(decision.message))],
        events,
        abortRest: false,
      }
    }
    if (decision.behavior === 'ask') {
      const event: Extract<StreamEvent, { type: 'permission_ask' }> = {
        type: 'permission_ask',
        id: call.id,
        tool: callName,
        input,
        message: decision.message,
      }
      if (decision.saveAs !== undefined) event.saveAs = decision.saveAs
      if (state.parentSessionId !== undefined) event.childSessionId = state.turn.sessionId
      try {
        const answer = await serializedAsk(async () => {
          const pending: PendingAsk = {
            callId: call.id,
            sessionId: state.turn.sessionId,
            kind: tool.name === 'AskUser' ? 'ask_user' : 'leftover',
            tool: tool.name,
            message: decision.message ?? '',
            input: call.input,
            createdAt: Date.now(),
          }
          if (decision.saveAs !== undefined) pending.saveAs = decision.saveAs
          if (state.assistantMessage?.id !== undefined) {
            pending.withheldAssistantId = state.assistantMessage.id
          }
          await state.store.upsertPendingAsk(pending)
          emit(event)
          return state.askUser(event, signal)
        })
        if (answer === 'deny') {
          return {
            messages: [makeToolMessage(call.id, false, denyText(decision.message))],
            events,
            abortRest: false,
          }
        }
        if (answer === 'allow_always') {
          const scope = decision.saveAs ?? 'session'
          const policyCwd = state.turn.projectCwd ?? state.turn.cwd
          const saved = await persistAllowAlways({
            store: state.store,
            sessionId: state.turn.sessionId,
            cwd: policyCwd,
            scope,
            tool: callName,
            spec: commandOrPath(input) ?? {},
          })
          box.rules = appendPermissionRule(box.rules, saved, scope)
        }
        allowed = true
      } catch (error) {
        if (error instanceof Error && error.name === 'AskWaiterExpired') {
          return { messages: [], events, abortRest: false }
        }
        return {
          messages: pairMissing([call.id], 'aborted'),
          events,
          abortRest: signal.aborted,
        }
      }
    } else {
      allowed = true
    }
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return { messages: pairMissing([call.id], 'aborted'), events, abortRest: true }
    }
    return {
      messages: [makeToolMessage(call.id, false, executeFailedText(errorMessage(error)))],
      events,
      abortRest: false,
    }
  }

  const blockInterrupt = tool.interruptBehavior?.() === 'block'
  if (!allowed || signal.aborted) {
    return {
      messages: pairMissing([call.id], 'aborted'),
      events,
      abortRest: signal.aborted,
    }
  }

  if (isStalled(state, callName, input)) {
    return {
      messages: [makeToolMessage(call.id, false, STALL_TEXT)],
      events,
      abortRest: false,
    }
  }

  const executeSignal = blockInterrupt ? new AbortController().signal : signal
  const executeCtx: ToolContext = { ...ctx, signal: executeSignal }

  try {
    const output = await tool.execute(input, executeCtx)
    events.push(...progress)
    const formatted = formatSettledOutput(tool, output)
    if (
      callName === 'TodoWrite' &&
      typeof output === 'string' &&
      output.startsWith('TodoWrite failed:')
    ) {
      events.push({
        type: 'tool_result',
        id: call.id,
        result: { toolUseId: call.id, ok: false, content: formatted.content },
      })
      return {
        messages: [makeToolMessage(call.id, false, formatted.content)],
        events,
        abortRest: false,
      }
    }
    noteToolSideEffects(state, callName, input)
    if (callName === 'TodoWrite') applyWrittenTodos(state, input)
    const content = appendSubdirAgents(state, input, formatted.content, formatted.persistPath)
    recordStall(state, callName, input, content)
    if (state.lifecycle) {
      const hook = await state.lifecycle.run('PostToolUse', {
        name: callName,
        input,
        output: content,
      })
      if (hook?.preventContinuation === true) {
        const msg = makeToolMessage(call.id, true, content, formatted.persistPath)
        stampReadMtime(state.turn, callName, input, msg)
        events.push({ type: 'tool_result', id: call.id, result: {
          toolUseId: call.id,
          ok: true,
          content,
        } })
        events.push({ type: 'status', message: hook.message ?? 'stopped by hook' })
        return { messages: [msg], events, abortRest: true }
      }
    }
    const result: Extract<StreamEvent, { type: 'tool_result' }>['result'] = {
      toolUseId: call.id,
      ok: true,
      content,
    }
    if (formatted.persistPath !== undefined) result.persistPath = formatted.persistPath
    events.push({
      type: 'tool_result',
      id: call.id,
      result,
    })
    const success = makeToolMessage(call.id, true, content, formatted.persistPath)
    stampReadMtime(state.turn, callName, input, success)
    return {
      messages: [success],
      events,
      abortRest: false,
    }
  } catch (error) {
    events.push(...progress)
    if (!blockInterrupt && (isAbortError(error) || signal.aborted)) {
      return { messages: pairMissing([call.id], 'aborted'), events, abortRest: true }
    }
    const content = executeFailedText(errorMessage(error))
    events.push({
      type: 'tool_result',
      id: call.id,
      result: { toolUseId: call.id, ok: false, content },
    })
    return {
      messages: [makeToolMessage(call.id, false, content)],
      events,
      abortRest: false,
    }
  }
}

function isEmptyCompletion(state: LoopState): boolean {
  return state.pendingText.trim() === ''
}

function shouldVerifyOnStop(state: LoopState): boolean {
  if (state.verifyOnStop !== true) return false
  if (state.verifyNudges >= 2) return false
  if (state.sawVerifyCommand) return false
  if (state.mutatedThisTurn) return true
  return (state.fileHistory?.turnWriteCount() ?? 0) > 0
}

function noteToolSideEffects(state: LoopState, name: string, input: unknown): void {
  if (MUTATING_TOOLS.has(name)) state.mutatedThisTurn = true
  if (name === 'Bash') {
    const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
    if (typeof command === 'string' && VERIFY_COMMAND.test(command)) state.sawVerifyCommand = true
  }
}

function applyWrittenTodos(state: LoopState, input: unknown): void {
  const items = normalizeTodoWriteItems((input as TodoWriteInput).items ?? [])
  state.todos = items
  if (state.session) state.session.todos = items
}

function appendSubdirAgents(
  state: LoopState,
  input: unknown,
  content: string,
  persistPath?: string,
): string {
  const path = extractToolPath(input, persistPath, content)
  if (path === undefined) return content
  const seen = state.turn.injectedAgentsDirs ?? new Set<string>()
  if (!state.turn.injectedAgentsDirs) state.turn.injectedAgentsDirs = seen
  const injection = loadNearestSubdirAgents(state.turn.cwd, resolve(state.turn.cwd, path), seen)
  if (injection === undefined) return content
  return `${content}\n\n${injection}`
}

function extractToolPath(input: unknown, persistPath?: string, resultContent?: string): string | undefined {
  if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>
    if (typeof rec.path === 'string' && rec.path.length > 0) return rec.path
    if (typeof rec.file_path === 'string' && rec.file_path.length > 0) return rec.file_path
    if (Array.isArray(rec.operations)) {
      const first = rec.operations[0]
      if (first && typeof first === 'object' && typeof (first as { path?: unknown }).path === 'string') {
        const opPath = (first as { path: string }).path
        if (opPath.length > 0) return opPath
      }
    }
  }
  if (typeof persistPath === 'string' && persistPath.length > 0) return persistPath
  if (typeof resultContent === 'string' && resultContent.length > 0) {
    const first = resultContent.split(/\r?\n/).find((line) => line.trim() !== '')
    if (first === undefined) return undefined
    const hit = /^(.+?):(\d+):/.exec(first)
    if (hit?.[1] && hit[1].length > 0) return hit[1]
    if (first.length < 512 && !first.includes(' ') && !first.startsWith('[')) return first
  }
  return undefined
}

function createAskSerializer(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve()
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = tail
    let release!: () => void
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
