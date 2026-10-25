import { describe, expect, test } from 'bun:test'
import type { Message } from '@ravenclaw/core'
import { formatBranchList, formatBranchNotice, parseBranchArg } from './branch-cmd'

function user(text: string, id = 'u'): Message {
  return { id, role: 'user', blocks: [{ type: 'text', text }], createdAt: 1 }
}

function assistant(text: string, id = 'a'): Message {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], createdAt: 2 }
}

function userTexts(texts: string[], id = 'u'): Message {
  return {
    id,
    role: 'user',
    blocks: texts.map((text) => ({ type: 'text', text })),
    createdAt: 1,
  }
}

const imageOnly: Message = {
  id: 'img',
  role: 'user',
  blocks: [{ type: 'image', mediaType: 'image/png', data: 'abc' }],
  createdAt: 1,
}

const noBlocks: Message = {
  id: 'empty',
  role: 'user',
  blocks: [],
  createdAt: 1,
}

describe('parseBranchArg', () => {
  test('blank input lists, a positive integer selects, anything else errors', () => {
    expect(parseBranchArg(undefined)).toEqual({ action: 'list' })
    expect(parseBranchArg('')).toEqual({ action: 'list' })
    expect(parseBranchArg('   ')).toEqual({ action: 'list' })
    expect(parseBranchArg('2')).toEqual({ action: 'select', n: 2 })
    expect(parseBranchArg('02')).toEqual({ action: 'select', n: 2 })
    expect(parseBranchArg('0')).toEqual({ action: 'error' })
    expect(parseBranchArg('foo')).toEqual({ action: 'error' })
    expect(parseBranchArg('2 extra')).toEqual({ action: 'error' })
  })
})

describe('formatBranchList', () => {
  test('joins text blocks and collapses newlines and spaces', () => {
    expect(formatBranchList([userTexts(['a', 'b'])])).toBe('* 1 user  a b')
    expect(formatBranchList([user('a\nb')])).toBe('* 1 user  a b')
    expect(formatBranchList([user('a\r\nb')])).toBe('* 1 user  a b')
    expect(formatBranchList([user('a  b')])).toBe('* 1 user  a b')
    expect(formatBranchList([user('a \n b')])).toBe('* 1 user  a b')
  })

  test('previews missing text as (no text)', () => {
    expect(formatBranchList([noBlocks])).toBe('* 1 user  (no text)')
    expect(formatBranchList([imageOnly])).toBe('* 1 user  (no text)')
    expect(formatBranchList([user('  \n  ')])).toBe('* 1 user  (no text)')
    const imageAndText: Message = {
      id: 'mix',
      role: 'user',
      blocks: [
        { type: 'image', mediaType: 'image/png', data: 'abc' },
        { type: 'text', text: 'see' },
      ],
      createdAt: 1,
    }
    expect(formatBranchList([imageAndText])).toBe('* 1 user  see')
  })

  test('keeps 60 characters and ellipsizes the 61st with U+2026', () => {
    const sixty = 'a'.repeat(60)
    const sixtyOne = 'a'.repeat(61)
    expect(formatBranchList([user(sixty)])).toBe(`* 1 user  ${sixty}`)
    const ellipsis = '\u2026'
    expect(ellipsis.codePointAt(0)).toBe(0x2026)
    expect(formatBranchList([user(sixtyOne)])).toBe(`* 1 user  ${'a'.repeat(59)}${ellipsis}`)
  })

  test('stars the last row of a path and the only row of a one-message list', () => {
    expect(formatBranchList([user('hello', 'u1'), assistant('world', 'a1')])).toBe(
      '  1 user  hello\n* 2 assistant  world',
    )
    expect(formatBranchList([user('hi')])).toBe('* 1 user  hi')
  })
})

describe('formatBranchNotice', () => {
  test('prints the path, a blank line, other, then the next number', () => {
    const path = [user('hello', 'u1'), assistant('world', 'a1')]
    expect(formatBranchNotice(path, [user('earlier tip', 'u3')])).toBe(
      '  1 user  hello\n* 2 assistant  world\n\nother\n  3 user  earlier tip',
    )
  })

  test('numbers a lone other leaf from 1 with no header and no star', () => {
    expect(formatBranchNotice([], [user('earlier tip')])).toBe('  1 user  earlier tip')
  })

  test('omits other when there are no other leaves and keeps numbering the rest', () => {
    const path = [user('hello', 'u1'), assistant('world', 'a1')]
    expect(formatBranchNotice(path, [])).toBe(formatBranchList(path))
    const tool: Message = {
      id: 't',
      role: 'tool',
      toolUseId: 'use',
      ok: false,
      blocks: [{ type: 'text', text: 'done' }],
      createdAt: 3,
    }
    expect(formatBranchNotice(path, [user('earlier tip', 'u3'), tool])).toBe(
      '  1 user  hello\n* 2 assistant  world\n\nother\n  3 user  earlier tip\n  4 tool  done',
    )
  })
})
