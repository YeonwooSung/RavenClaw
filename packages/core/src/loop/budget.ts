import type { CompactPolicy, Message, ModelProfile, Turn } from '../types'
import { injectMidTurn } from '../prompt/cache'

export const GRACE_NOTICE =
  'This is the last round; answer the user now. Do not call tools.'

export function estimateTokens(messages: Message[]): number {
  let chars = 0
  for (const msg of messages) {
    for (const block of msg.blocks) {
      if (block.type === 'text' || block.type === 'thinking') chars += block.text.length
      else if (block.type === 'tool_use') {
        chars += block.name.length + JSON.stringify(block.input).length
      }
    }
  }
  return Math.ceil(chars / 4)
}

export function exceedsHardLimit(
  messages: Message[],
  model: ModelProfile,
  compact: CompactPolicy,
): boolean {
  const limit = model.contextWindow - compact.blockingBufferWhenManual
  return estimateTokens(messages) + model.reserveOutputTokens > limit
}

export function shouldEnterGrace(turn: Turn, lastHadToolUse: boolean): boolean {
  return lastHadToolUse && turn.round >= turn.maxRounds && !turn.graceUsed
}

export function suffixGraceNotice(messages: Message[]): Message[] {
  return injectMidTurn(messages, `\n${GRACE_NOTICE}`)
}
