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
import { shouldAutocompact } from '../compact/policy'
import { applyToolResultBudget, microcompact, runAutocompact } from '../compact/prune'
import { compactSummary } from '../compact/summarize'
import { isAbortError, nextOrAbort } from './abort'
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

function isRetryable(error: unknown): boolean {
  if (isAuthError(error)) return false
  return isProviderErrorLike(error) && error.retryable
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatOutput(tool: Tool, output: unknown): string {
  if (typeof output === 'string') return output
  if (tool.renderResult) return tool.renderResult(output)
  if (output === undefined || output === null) return ''
  if (typeof output === 'object') return JSON.stringify(output)
  return String(output)
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
    suffixGraceNotice(state.turn.messages)
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
  const opts: Parameters<typeof shouldAutocompact>[0] = {
    enabled: state.compact.enabled,
    estimatedTokens: estimateTokens(state.turn.messages),
    model: state.model,
    compact: state.compact,
    consecutiveFailures: state.compactFailures,
  }
  if (anchoredTokens !== undefined) opts.anchoredTokens = anchoredTokens
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
    })
    state.turn.messages = result.messages
    state.turn.compactGeneration = result.generation
    state.compactFailures = 0
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
  let messages = state.turn.messages
  if (!state.model.supportsThinking) {
    messages = messages.map((msg) => {
      if (msg.role !== 'assistant') return msg
      return { ...msg, blocks: msg.blocks.filter((block) => block.type !== 'thinking') }
    })
  }
  const tools = state.turn.graceUsed
    ? []
    : state.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
  return {
    model: state.model.id,
    system: [],
    messages,
    tools,
    maxTokens: state.model.reserveOutputTokens,
  }
}

export async function* streamModel(
  state: LoopState,
  req: ProviderRequest,
): AsyncGenerator<StreamEvent, PhaseResult> {
  const maxTries = 8
  const baseMs = 500

  for (let attempt = 0; attempt < maxTries; attempt++) {
    if (state.turn.abort.signal.aborted) {
      state.streamAborted = true
      return { action: 'continue' }
    }

    state.pendingText = ''
    state.pendingThinking = ''
    state.pendingToolCalls = []
    state.streamAborted = false

    try {
      const iterator = state.provider
        .stream(req, state.turn.abort.signal)
        [Symbol.asyncIterator]()
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
            break
        }
      }
      return { action: 'continue' }
    } catch (error) {
      if (isAbortError(error) || state.turn.abort.signal.aborted) {
        state.streamAborted = true
        return { action: 'continue' }
      }
      if (isAuthError(error) || !isRetryable(error) || attempt === maxTries - 1) {
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
    state.turn.messages.push(asst)
    try {
      await state.store.persistAssistant(state.turn.sessionId, asst)
    } catch (error) {
      return { action: 'return', end: { reason: 'persist_failed', error } }
    }
    if (state.turn.graceUsed) {
      return { action: 'return', end: { reason: 'max_rounds', round: state.turn.round } }
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

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]
    if (!call) continue
    if (state.turn.abort.signal.aborted) {
      results.push(...pairMissing(calls.slice(i).map((row) => row.id), 'aborted'))
      break
    }

    const tool = state.tools.find((entry) => entry.name === call.name)
    if (!tool) {
      results.push(makeToolMessage(call.id, false, unknownToolText(call.name)))
      continue
    }

    const parsed = tool.parse(call.input)
    if (!parsed.ok) {
      results.push(makeToolMessage(call.id, false, parseFailedText(parsed.message)))
      continue
    }

    const progress: StreamEvent[] = []
    const ctx: ToolContext = {
      turn: state.turn,
      signal: state.turn.abort.signal,
      onProgress: (text) => {
        progress.push({ type: 'tool_progress', id: call.id, text })
      },
    }

    let allowed = false
    try {
      const decision = await tool.checkPermissions(parsed.value, ctx)
      if (decision.behavior === 'deny') {
        results.push(makeToolMessage(call.id, false, denyText(decision.message)))
        continue
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
        yield event
        try {
          const answer = await state.askUser(event, state.turn.abort.signal)
          if (answer === 'deny') {
            results.push(makeToolMessage(call.id, false, denyText(decision.message)))
            continue
          }
          allowed = true
        } catch {
          results.push(...pairMissing([call.id], 'aborted'))
          if (state.turn.abort.signal.aborted) {
            results.push(
              ...pairMissing(calls.slice(i + 1).map((row) => row.id), 'aborted'),
            )
            break
          }
          continue
        }
      } else {
        allowed = true
      }
    } catch (error) {
      if (isAbortError(error) || state.turn.abort.signal.aborted) {
        results.push(...pairMissing(calls.slice(i).map((row) => row.id), 'aborted'))
        break
      }
      results.push(makeToolMessage(call.id, false, executeFailedText(errorMessage(error))))
      continue
    }

    if (!allowed) continue
    if (state.turn.abort.signal.aborted) {
      results.push(...pairMissing(calls.slice(i).map((row) => row.id), 'aborted'))
      break
    }

    try {
      const output = await tool.execute(parsed.value, ctx)
      for (const event of progress) yield event
      const content = formatOutput(tool, output)
      results.push(makeToolMessage(call.id, true, content))
      yield {
        type: 'tool_result',
        id: call.id,
        result: { toolUseId: call.id, ok: true, content },
      }
    } catch (error) {
      for (const event of progress) yield event
      if (isAbortError(error) || state.turn.abort.signal.aborted) {
        results.push(...pairMissing([call.id], 'aborted'))
        results.push(...pairMissing(calls.slice(i + 1).map((row) => row.id), 'aborted'))
        break
      }
      const content = executeFailedText(errorMessage(error))
      results.push(makeToolMessage(call.id, false, content))
      yield {
        type: 'tool_result',
        id: call.id,
        result: { toolUseId: call.id, ok: false, content },
      }
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
  return { action: 'continue' }
}
