import { describe, expect, test } from 'bun:test'
import type { CompactPolicy, Message, ModelProfile, Turn } from '../types'
import {
  estimateTokens,
  exceedsHardLimit,
  GRACE_NOTICE,
  shouldEnterGrace,
  suffixGraceNotice,
} from './budget'

function model(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'dummy',
    contextWindow: 100,
    reserveOutputTokens: 10,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
    ...over,
  }
}

function compact(over: Partial<CompactPolicy> = {}): CompactPolicy {
  return {
    enabled: true,
    autoCompactBuffer: 10,
    blockingBufferWhenManual: 20,
    protectLastMessages: 2,
    keepRecentFiles: 1,
    maxCharsPerRestoredFile: 100,
    maxCharsRestoredFilesTotal: 100,
    maxCharsPerRestoredSkill: 100,
    maxCharsRestoredSkillsTotal: 100,
    maxConsecutiveFailures: 3,
    llmSummarize: false,
    ...over,
  }
}

function turn(over: Partial<Turn> = {}): Turn {
  return {
    id: 't',
    sessionId: 's',
    messages: [],
    round: 0,
    maxRounds: 4,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd: '/tmp',
    model: 'dummy',
    readFiles: new Set(),
    ...over,
  }
}

function user(text: string): Extract<Message, { role: 'user' }> {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    blocks: [{ type: 'text', text }],
    createdAt: 1,
  }
}

function assistant(text: string): Extract<Message, { role: 'assistant' }> {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    createdAt: 1,
  }
}

describe('estimateTokens', () => {
  test('counts text, thinking, and tool_use at 4 chars per token', () => {
    expect(estimateTokens([])).toBe(0)
    expect(estimateTokens([user('abcd')])).toBe(1)
    const asst: Extract<Message, { role: 'assistant' }> = {
      id: 'a',
      role: 'assistant',
      blocks: [
        { type: 'thinking', text: 'xxxx' },
        { type: 'text', text: 'yyyy' },
        { type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'ab' } },
      ],
      createdAt: 1,
    }
    expect(estimateTokens([asst])).toBeGreaterThan(0)
  })
})

describe('exceedsHardLimit', () => {
  test('is false when messages fit under the blocking buffer', () => {
    expect(exceedsHardLimit([user('hi')], model(), compact())).toBe(false)
  })

  test('is true when tokens plus reserve exceed the window minus buffer', () => {
    const huge = user('x'.repeat(400))
    expect(exceedsHardLimit([huge], model({ contextWindow: 50, reserveOutputTokens: 10 }), compact())).toBe(
      true,
    )
  })
})

describe('shouldEnterGrace', () => {
  test('only when last had tools, at max rounds, and grace unused', () => {
    expect(shouldEnterGrace(turn({ round: 4, maxRounds: 4 }), true)).toBe(true)
    expect(shouldEnterGrace(turn({ round: 4, maxRounds: 4, graceUsed: true }), true)).toBe(false)
    expect(shouldEnterGrace(turn({ round: 3, maxRounds: 4 }), true)).toBe(false)
    expect(shouldEnterGrace(turn({ round: 4, maxRounds: 4 }), false)).toBe(false)
  })
})

describe('suffixGraceNotice', () => {
  test('appends the grace notice to the last assistant text', () => {
    const messages: Message[] = [user('hi'), assistant('ok')]
    const next = suffixGraceNotice(messages)
    const last = next[next.length - 1]
    expect(last?.role).toBe('assistant')
    const text = last && last.role === 'assistant' ? last.blocks.find((b) => b.type === 'text') : undefined
    expect(text && text.type === 'text' ? text.text : '').toContain(GRACE_NOTICE)
    expect(messages).not.toBe(next)
  })
})
