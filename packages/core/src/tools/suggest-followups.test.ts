import { describe, expect, test } from 'bun:test'
import type { ToolContext, Turn } from '../types'
import {
  formatSuggestFollowups,
  parseFollowupLines,
  suggestFollowupsTool,
} from './suggest-followups'

function makeTurn(cwd = '/tmp'): Turn {
  return {
    id: 'turn_1',
    sessionId: 'sess_1',
    messages: [],
    round: 1,
    maxRounds: 80,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd,
    model: 'dummy',
    readFiles: new Set(),
  }
}

function makeCtx(signal?: AbortSignal): ToolContext {
  const turn = makeTurn()
  return {
    turn,
    signal: signal ?? turn.abort.signal,
    onProgress() {},
  }
}

describe('SuggestFollowups', () => {
  test('is a concurrency-safe read-only tool that allows by mode', async () => {
    const input = { followups: [{ prompt: 'run tests' }] }
    expect(suggestFollowupsTool.name).toBe('SuggestFollowups')
    expect(suggestFollowupsTool.isConcurrencySafe(input)).toBe(true)
    expect(suggestFollowupsTool.isReadOnly(input)).toBe(true)
    expect(suggestFollowupsTool.interruptBehavior?.()).toBe('cancel')
    const decision = await suggestFollowupsTool.checkPermissions(input, makeCtx())
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('parse requires at least one followup with a prompt', () => {
    expect(suggestFollowupsTool.parse({ followups: [{ prompt: 'x' }] }).ok).toBe(true)
    expect(suggestFollowupsTool.parse({ followups: [] }).ok).toBe(false)
    expect(suggestFollowupsTool.parse({}).ok).toBe(false)
    expect(suggestFollowupsTool.parse({ followups: [{ label: 'x' }] }).ok).toBe(false)
  })

  test('execute prints label: prompt and defaults label to the first 40 chars', async () => {
    const long = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'
    const out = await suggestFollowupsTool.execute(
      {
        followups: [
          { prompt: 'run the unit tests', label: 'tests' },
          { prompt: long },
        ],
      },
      makeCtx(),
    )
    expect(out).toBe(`tests: run the unit tests\n${long.slice(0, 40)}: ${long}`)
  })

  test('formatSuggestFollowups and parseFollowupLines round-trip', () => {
    const input = {
      followups: [
        { prompt: 'open the plan', label: 'plan' },
        { prompt: 'short' },
      ],
    }
    const text = formatSuggestFollowups(input)
    expect(text).toBe('plan: open the plan\nshort: short')
    expect(parseFollowupLines(text)).toEqual([
      { label: 'plan', prompt: 'open the plan' },
      { label: 'short', prompt: 'short' },
    ])
  })

  test('execute refuses when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      suggestFollowupsTool.execute({ followups: [{ prompt: 'x' }] }, makeCtx(ac.signal)),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
