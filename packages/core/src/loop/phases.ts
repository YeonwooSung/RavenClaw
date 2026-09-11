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
} from '../types'
import { getLastRequestAt, markLastRequestAt } from '../compact/last-request'
import { shouldAutocompact } from '../compact/policy'
import { getModelProfile } from '../cost/models'
import { takeChildOutput } from '../tools/set-output'
import { applyToolResultBudget, microcompact, runAutocompact } from '../compact/prune'
import { compactSummary } from '../compact/summarize'
import { decidePermission } from '../permissions/pipeline'
import type { PermissionRuleSet } from '../permissions/types'
import { commandOrPath, loadPermissionRules, persistAllowAlways } from '../permissions/rules'
import { isAbortError, nextOrAbort } from './abort'
import { partitionToolCalls } from '../tools/partition'
import { filterToolsForTurn } from '../tools/skill'
import { estimateTokens, shouldEnterGrace, suffixGraceNotice } from './budget'
import {
  denyText,
  executeFailedText,
  makeToolMessage,
  pairMissing,
  parseFailedText,
  unknownToolText,
} from './pairing'
import { repairRoleAlternation, selectProtectedTail } from './repair'

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
  outputNudges: number
  schemaNudges: number
}

export type PhaseResult =
  | { action: 'continue' }
  | { action: 'break' }
  | { action: 'return'; end: RoundEnd }

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

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

function isRetryable(error: unknown): boolean {
  if (isAuthError(error)) return false
  return isProviderErrorLike(error) && error.retryable
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function persistPathOf(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined
  if (!('persistPath' in output)) return undefined
  const path = (output as { persistPath?: unknown }).persistPath
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

function formatOutput(
  tool: Tool,
  output: unknown,
): { content: string; persistPath?: string } {
  const persistPath = persistPathOf(output)
  let content: string
  if (typeof output === 'string') content = output
  else if (tool.renderResult) content = tool.renderResult(output)
  else if (output === undefined || output === null) content = ''
  else if (typeof output === 'object') {
    const body = (output as { content?: unknown }).content
    content = typeof body === 'string' ? body : JSON.stringify(output)
  } else {
    content = String(output)
  }
  return persistPath !== undefined ? { content, persistPath } : { content }
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

export async function persistResultsWithRetry(
  state: LoopState,
  results: Array<Extract<Message, { role: 'tool' }>>,
): Promise<RoundEnd | undefined> {
  try {
    await state.store.persistToolResults(state.turn.sessionId, results)
    return undefined
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
    return { reason: 'results_persist_failed', error: first }
  }
}

export async function* beginRound(state: LoopState): AsyncGenerator<StreamEvent, PhaseResult> {
  if (state.turn.abort.signal.aborted) {
    return { action: 'return', end: { reason: 'aborted' } }
  }

  if (shouldEnterGrace(state.turn, state.lastHadToolUse)) {
    state.turn.graceUsed = true
    resetPending(state)
    yield { type: 'round_start', round: state.turn.round }
    return { action: 'continue' }
  }

  if (state.turn.round >= state.turn.maxRounds) {
    return { action: 'return', end: { reason: 'max_rounds', round: state.turn.round } }
  }

  state.turn.round += 1
  resetPending(state)
  yield { type: 'round_start', round: state.turn.round }
  return { action: 'continue' }
}

export async function prepareContext(state: LoopState): Promise<PhaseResult> {
  const before = new Set(state.turn.messages.map((msg) => msg.id))
  const repaired = repairRoleAlternation(state.turn.messages)
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
    })
    state.turn.messages = result.messages
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
  const tools = state.turn.graceUsed
    ? []
    : filterToolsForTurn(state.tools, state.turn).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
  return {
    model: state.turn.model,
    system: state.system ?? [],
    messages,
    tools,
    maxTokens: state.model.reserveOutputTokens,
  }
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
    })
    state.turn.messages = result.messages
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
    return { action: 'return', end: { reason: 'aborted' } }
  }

  if (!hasTools) {
    if (isTruncatedStop(state.lastStopReason) && state.outputNudges < 3) {
      state.outputNudges += 1
      state.turn.messages.push(asst)
      try {
        await state.store.persistAssistant(state.turn.sessionId, asst)
      } catch (error) {
        return { action: 'return', end: { reason: 'persist_failed', error } }
      }
      const nudge: Extract<Message, { role: 'user' }> = {
        id: crypto.randomUUID(),
        role: 'user',
        blocks: [{ type: 'text', text: 'Your previous reply was cut off. Continue from where you left off. Do not recap.' }],
        createdAt: Date.now(),
      }
      state.turn.messages.push(nudge)
      try {
        await state.store.persistUser(state.turn.sessionId, nudge)
      } catch (error) {
        return { action: 'return', end: { reason: 'persist_failed', error } }
      }
      yield { type: 'status', message: 'output truncated; continuing' }
      return { action: 'continue' }
    }
    state.turn.messages.push(asst)
    try {
      await state.store.persistAssistant(state.turn.sessionId, asst)
    } catch (error) {
      return { action: 'return', end: { reason: 'persist_failed', error } }
    }
    if (state.turn.graceUsed) {
      return { action: 'return', end: { reason: 'max_rounds', round: state.turn.round } }
    }
    if (state.jsonSchema !== undefined && takeChildOutput(state.turn.sessionId) === undefined && state.schemaNudges < 2) {
      state.schemaNudges += 1
      const nudge: Extract<Message, { role: 'user' }> = {
        id: crypto.randomUUID(),
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: 'Call StructuredOutput now with the final object that matches the required JSON schema. Do not answer in prose.',
          },
        ],
        createdAt: Date.now(),
      }
      state.turn.messages.push(nudge)
      try {
        await state.store.persistUser(state.turn.sessionId, nudge)
      } catch (error) {
        return { action: 'return', end: { reason: 'persist_failed', error } }
      }
      yield { type: 'status', message: 'structured output required' }
      return { action: 'continue' }
    }
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
    const settled = await Promise.all(
      batch.map((call) => executeOneCall(state, call, box, serializedAsk, signal)),
    )
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
    return { action: 'return', end: { reason: 'aborted' } }
  }

  return { action: 'continue' }
}

export async function* finalizeRound(
  state: LoopState,
): AsyncGenerator<StreamEvent, PhaseResult> {
  const fail = await persistResultsWithRetry(state, state.toolResults)
  if (fail) return { action: 'return', end: fail }
  const steered = await injectSteering(state)
  for (const text of steered) {
    yield { type: 'status', message: `steered: ${steerPreview(text)}` }
  }
  return { action: 'continue' }
}

async function injectSteering(state: LoopState): Promise<string[]> {
  const texts = state.drainSteering?.() ?? []
  if (texts.length === 0) return []
  const injected: string[] = []
  for (const text of texts) {
    const userMsg: Extract<Message, { role: 'user' }> = {
      id: crypto.randomUUID(),
      role: 'user',
      blocks: [{ type: 'text', text }],
      createdAt: Date.now(),
    }
    try {
      await state.store.persistUser(state.turn.sessionId, userMsg)
    } catch {
      continue
    }
    state.turn.messages.push(userMsg)
    injected.push(text)
  }
  return injected
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

async function executeOneCall(
  state: LoopState,
  call: { id: string; name: string; input: unknown },
  box: { rules: PermissionRuleSet },
  serializedAsk: SerializedAsk,
  signal: AbortSignal,
): Promise<{
  messages: Array<Extract<Message, { role: 'tool' }>>
  events: StreamEvent[]
  abortRest: boolean
}> {
  const events: StreamEvent[] = []
  if (signal.aborted) {
    return { messages: pairMissing([call.id], 'aborted'), events, abortRest: true }
  }

  const tool = filterToolsForTurn(state.tools, state.turn).find((entry) => entry.name === call.name)
  if (!tool) {
    return {
      messages: [makeToolMessage(call.id, false, unknownToolText(call.name))],
      events,
      abortRest: false,
    }
  }

  const parsed = tool.parse(call.input)
  if (!parsed.ok) {
    return {
      messages: [makeToolMessage(call.id, false, parseFailedText(parsed.message))],
      events,
      abortRest: false,
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

  let allowed = false
  try {
    const decision = await decidePermission({
      tool,
      name: call.name,
      input: parsed.value,
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
        tool: call.name,
        input: parsed.value,
        message: decision.message,
      }
      if (decision.saveAs !== undefined) event.saveAs = decision.saveAs
      events.push(event)
      try {
        const answer = await serializedAsk(() => state.askUser(event, signal))
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
          await persistAllowAlways({
            store: state.store,
            sessionId: state.turn.sessionId,
            cwd: policyCwd,
            scope,
            tool: call.name,
            spec: commandOrPath(parsed.value) ?? {},
          })
          box.rules = await loadPermissionRules({
            cwd: policyCwd,
            store: state.store,
            sessionId: state.turn.sessionId,
          })
        }
        allowed = true
      } catch {
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

  const executeSignal = blockInterrupt ? new AbortController().signal : signal
  const executeCtx: ToolContext = { ...ctx, signal: executeSignal }

  try {
    const output = await tool.execute(parsed.value, executeCtx)
    events.push(...progress)
    const formatted = formatOutput(tool, output)
    if (state.lifecycle) {
      const hook = await state.lifecycle.run('PostToolUse', {
        name: call.name,
        input: parsed.value,
        output: formatted.content,
      })
      if (hook?.preventContinuation === true) {
        const msg = makeToolMessage(call.id, true, formatted.content, formatted.persistPath)
        events.push({ type: 'tool_result', id: call.id, result: {
          toolUseId: call.id,
          ok: true,
          content: formatted.content,
        } })
        events.push({ type: 'status', message: hook.message ?? 'stopped by hook' })
        return { messages: [msg], events, abortRest: true }
      }
    }
    const result: Extract<StreamEvent, { type: 'tool_result' }>['result'] = {
      toolUseId: call.id,
      ok: true,
      content: formatted.content,
    }
    if (formatted.persistPath !== undefined) result.persistPath = formatted.persistPath
    events.push({
      type: 'tool_result',
      id: call.id,
      result,
    })
    return {
      messages: [makeToolMessage(call.id, true, formatted.content, formatted.persistPath)],
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
