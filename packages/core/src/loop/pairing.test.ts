import { describe, expect, test } from 'bun:test'
import type { Message } from '../types'
import {
  INCOMPLETE_TEXT,
  TOOLS_OMITTED_TEXT,
  pairMissing,
  unpairedToolUseIds,
} from './pairing'

describe('pairing invariant helpers', () => {
  test('pairMissing incomplete uses the stable resume text', () => {
    const [msg] = pairMissing(['X'], 'incomplete')
    expect(msg).toBeDefined()
    expect(msg?.role).toBe('tool')
    expect(msg?.toolUseId).toBe('X')
    expect(msg?.ok).toBe(false)
    expect(msg?.blocks[0]?.text).toBe(INCOMPLETE_TEXT)
  })

  test('pairMissing tools_omitted uses the stable grace text', () => {
    const [msg] = pairMissing(['g1'], 'tools_omitted')
    expect(msg?.ok).toBe(false)
    expect(msg?.blocks[0]?.text).toBe(TOOLS_OMITTED_TEXT)
  })

  test('pairMissing aborted / persist_failed use stable prefixes and ok:false', () => {
    const [aborted] = pairMissing(['a'], 'aborted')
    expect(aborted?.ok).toBe(false)
    expect(aborted?.blocks[0]?.text.startsWith('aborted:')).toBe(true)

    const [failed] = pairMissing(['p'], 'persist_failed')
    expect(failed?.ok).toBe(false)
    expect(failed?.blocks[0]?.text.startsWith('persist_failed:')).toBe(true)
  })

  test('unpairedToolUseIds finds tool_use without a matching tool row', () => {
    const messages: Message[] = [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'go' }],
        createdAt: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        blocks: [
          { type: 'tool_use', id: 'c1', name: 'Echo', input: {} },
          { type: 'tool_use', id: 'c2', name: 'Echo', input: {} },
        ],
        createdAt: 2,
      },
      {
        id: 't1',
        role: 'tool',
        toolUseId: 'c1',
        ok: true,
        blocks: [{ type: 'text', text: 'ok' }],
        createdAt: 3,
      },
    ]
    expect(unpairedToolUseIds(messages)).toEqual(['c2'])
  })
})
