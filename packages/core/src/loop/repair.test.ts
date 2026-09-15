import { describe, expect, test } from 'bun:test'
import type { ContentBlock, Message } from '../types'
import {
  buildPostCompactMessages,
  repairRoleAlternation,
  selectProtectedTail,
} from './repair'

const INCOMPLETE_TEXT =
  'incomplete: the process ended before this tool result was saved. The tool was not re-run.'
const STUB_TEXT = '(conversation summary follows)'

function user(id: string, text: string, createdAt = 1): Message {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    createdAt,
  }
}

function assistant(
  id: string,
  blocks: ContentBlock[],
  createdAt = 2,
): Message {
  return { id, role: 'assistant', blocks, createdAt }
}

function asstText(id: string, text: string, createdAt = 2): Message {
  return assistant(id, [{ type: 'text', text }], createdAt)
}

function tool(
  id: string,
  toolUseId: string,
  text: string,
  ok = true,
  createdAt = 3,
): Message {
  return {
    id,
    role: 'tool',
    toolUseId,
    ok,
    blocks: [{ type: 'text', text }],
    createdAt,
  }
}

describe('repairRoleAlternation', () => {
  test('drops leading orphan tool results', () => {
    const input = [tool('t0', 'missing', 'orphan'), user('u1', 'hello')]
    const out = repairRoleAlternation(input)
    expect(out).toEqual([user('u1', 'hello')])
  })

  test('inserts incomplete tool message immediately after unpaired tool_use', () => {
    const input = [
      user('u1', 'run'),
      assistant('a1', [
        { type: 'tool_use', id: 'X', name: 'Echo', input: { text: 'hi' } },
      ]),
    ]
    const out = repairRoleAlternation(input)
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual(input[0])
    expect(out[1]).toEqual(input[1])
    const inserted = out[2]
    expect(inserted?.role).toBe('tool')
    if (inserted?.role === 'tool') {
      expect(inserted.toolUseId).toBe('X')
      expect(inserted.ok).toBe(false)
      expect(inserted.blocks[0]?.text).toBe(INCOMPLETE_TEXT)
    }
  })

  test('joins two consecutive user messages with \\n\\n', () => {
    const input = [user('u1', 'first'), user('u2', 'second')]
    const out = repairRoleAlternation(input)
    expect(out).toHaveLength(1)
    expect(out[0]?.role).toBe('user')
    if (out[0]?.role === 'user') {
      expect(out[0].id).toBe('u1')
      expect(out[0].blocks).toEqual([{ type: 'text', text: 'first\n\nsecond' }])
    }
  })

  test('joins consecutive tool-less assistants; keeps first thinking; drops empty second', () => {
    const first = assistant('a1', [
      { type: 'thinking', text: 'hmm' },
      { type: 'text', text: 'hello' },
    ])
    const empty = asstText('a2', '')
    const dropped = repairRoleAlternation([first, empty])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toEqual(first)

    const second = asstText('a3', 'world')
    const joined = repairRoleAlternation([first, second])
    expect(joined).toHaveLength(1)
    expect(joined[0]?.role).toBe('assistant')
    if (joined[0]?.role === 'assistant') {
      expect(joined[0].id).toBe('a1')
      expect(joined[0].blocks).toEqual([
        { type: 'thinking', text: 'hmm' },
        { type: 'text', text: 'hello\n\nworld' },
      ])
    }
  })

  test('already alternating paired history is identity', () => {
    const input = [
      user('u1', 'list files'),
      assistant('a1', [
        { type: 'text', text: 'listing' },
        { type: 'tool_use', id: 'c1', name: 'Glob', input: { pattern: '*' } },
      ]),
      tool('t1', 'c1', 'README.md'),
      user('u2', 'thanks'),
      asstText('a2', 'you are welcome'),
    ]
    expect(repairRoleAlternation(input)).toEqual(input)
  })

  test('compact tail that would start on a tool expands to the owning assistant', () => {
    const msgs = [
      user('u1', 'first', 1),
      asstText('a1', 'ok', 2),
      user('u2', 'use tool', 3),
      assistant(
        'a2',
        [{ type: 'tool_use', id: 'X', name: 'Echo', input: {} }],
        4,
      ),
      tool('t1', 'X', 'result', true, 5),
    ]
    const tail = selectProtectedTail(msgs, 1)
    expect(tail.map((m) => m.id)).toEqual(['a2', 't1'])
    expect(tail[0]?.role).toBe('assistant')
    expect(repairRoleAlternation(tail)).toEqual(tail)
  })

  test('compact tail starting on user: prepend assistant stub + user summary', () => {
    const msgs = [
      user('u0', 'old', 1),
      asstText('a0', 'old reply', 2),
      user('u1', 'recent', 3),
      asstText('a1', 'recent reply', 4),
    ]
    const tail = selectProtectedTail(msgs, 2)
    expect(tail[0]?.role).toBe('user')
    const built = buildPostCompactMessages('SUMMARY', tail)
    expect(built[0]?.role).toBe('assistant')
    if (built[0]?.role === 'assistant') {
      expect(built[0].blocks[0]).toEqual({ type: 'text', text: STUB_TEXT })
    }
    expect(built[1]?.role).toBe('user')
    if (built[1]?.role === 'user') {
      expect(built[1].blocks[0]?.text).toBe('SUMMARY')
    }
    expect(built.slice(2)).toEqual(tail)
  })

  test('compact tail starting on assistant: prepend a single user summary', () => {
    const msgs = [
      user('u0', 'old', 1),
      asstText('a0', 'old reply', 2),
      user('u1', 'recent', 3),
      asstText('a1', 'recent reply', 4),
    ]
    const tail = selectProtectedTail(msgs, 1)
    expect(tail[0]?.role).toBe('assistant')
    const built = buildPostCompactMessages('SUMMARY', tail)
    expect(built[0]?.role).toBe('user')
    if (built[0]?.role === 'user') {
      expect(built[0].blocks[0]?.text).toBe('SUMMARY')
    }
    expect(built.slice(1)).toEqual(tail)
    expect(repairRoleAlternation(built)).toEqual(built)
  })

  test('empty tail still yields a legal user summary', () => {
    const built = buildPostCompactMessages('SUMMARY', [])
    expect(built).toHaveLength(1)
    expect(built[0]?.role).toBe('user')
    if (built[0]?.role === 'user') {
      expect(built[0].blocks[0]?.text).toBe('SUMMARY')
    }
  })

  test('repairRoleAlternation leaves unpaired tool_use when call is a pending ask', () => {
    const input = [
      user('u1', 'run'),
      assistant('a1', [{ type: 'tool_use', id: 'call_1', name: 'Echo', input: { text: 'hi' } }]),
    ]
    const out = repairRoleAlternation(input, new Set(['call_1']))
    expect(out.some((m) => m.role === 'tool')).toBe(false)
    expect(out).toHaveLength(2)
  })

  test('repairRoleAlternation still inserts incomplete when not pending', () => {
    const input = [
      user('u1', 'run'),
      assistant('a1', [{ type: 'tool_use', id: 'call_1', name: 'Echo', input: { text: 'hi' } }]),
    ]
    const out = repairRoleAlternation(input)
    const last = out.at(-1)
    expect(last?.role).toBe('tool')
    if (last?.role === 'tool') {
      expect(last.toolUseId).toBe('call_1')
      expect(last.blocks[0]?.text).toBe(INCOMPLETE_TEXT)
    }
  })
})
