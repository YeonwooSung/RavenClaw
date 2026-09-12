import type { QueryLoopOptions, RoundEnd, StreamEvent } from '../types'
import {
  assembleRequest,
  beginRound,
  finalizeRound,
  maybeCompact,
  normalizeResponse,
  prepareContext,
  runToolRound,
  streamModel,
  type LoopState,
} from './phases'

export async function* queryLoop(
  opts: QueryLoopOptions,
): AsyncGenerator<StreamEvent, RoundEnd> {
  const state: LoopState = {
    ...opts,
    lastHadToolUse: false,
    pendingText: '',
    pendingThinking: '',
    pendingToolCalls: [],
    pendingUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    streamAborted: false,
    assistantMessage: null,
    toolResults: [],
    compactFailures: 0,
    overflowCompacted: false,
    lastStopReason: null,
    fallbackUsed: false,
    outputEscalated: false,
    outputNudges: 0,
    schemaNudges: 0,
    emptyNudges: 0,
    thinkingNudges: 0,
    verifyNudges: 0,
    mutatedThisTurn: false,
    sawVerifyCommand: false,
  }
  if (!state.turn.injectedAgentsDirs) state.turn.injectedAgentsDirs = new Set()

  while (true) {
    const begin = yield* beginRound(state)
    if (begin.action === 'return') return begin.end

    await prepareContext(state)

    const compact = yield* maybeCompact(state)
    if (compact.action === 'return') return compact.end

    const req = assembleRequest(state)
    const streamed = yield* streamModel(state, req)
    if (streamed.action === 'return') return streamed.end

    const norm = yield* normalizeResponse(state)
    if (norm.action === 'return') return norm.end
    if (state.pendingToolCalls.length === 0) continue

    const tools = yield* runToolRound(state)
    if (tools.action === 'return') return tools.end

    const fin = yield* finalizeRound(state)
    if (fin.action === 'return') return fin.end
  }
}
