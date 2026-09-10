import { describe, expect, test } from 'bun:test'
import type { Message } from '../types'
import { hashSystemParts, injectMidTurn } from './cache'
import { buildSystemParts } from './builder'

function user(id: string, text: string, createdAt: number): Message {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    createdAt,
  }
}

function assistant(id: string, text: string, createdAt: number): Message {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    createdAt,
  }
}

function tool(id: string, toolUseId: string, text: string, createdAt: number): Message {
  return {
    id,
    role: 'tool',
    toolUseId,
    ok: true,
    blocks: [{ type: 'text', text }],
    createdAt,
  }
}

describe('hashSystemParts', () => {
  test('same SystemPart[] hash across two rounds', () => {
    const input = {
      cwd: '/workspace/demo',
      permissionMode: 'default' as const,
      projectFilesText: 'frozen',
      git: { branch: 'main', head: 'deadbeef', dirty: false },
    }
    const a = hashSystemParts(buildSystemParts(input))
    const b = hashSystemParts(buildSystemParts(input))
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('injectMidTurn', () => {
  test('suffixes the newest tool message and does not add a user row', () => {
    const messages: Message[] = [
      user('u1', 'list files', 1),
      assistant('a1', 'calling glob', 2),
      tool('t1', 'call_1', 'old-tool', 3),
      assistant('a2', 'calling again', 4),
      tool('t2', 'call_2', 'newest-tool', 5),
    ]
    const snapshot = structuredClone(messages)
    const out = injectMidTurn(messages, '\n[mid-turn hint]')

    expect(out.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(out).toHaveLength(messages.length)
    expect(out[4]).toMatchObject({
      role: 'tool',
      toolUseId: 'call_2',
      blocks: [{ type: 'text', text: 'newest-tool\n[mid-turn hint]' }],
    })
    expect(out[2]).toMatchObject({
      role: 'tool',
      blocks: [{ type: 'text', text: 'old-tool' }],
    })
    expect(messages).toEqual(snapshot)
    expect(out).not.toBe(messages)
  })

  test('appends to the newest assistant text block when there is no tool message', () => {
    const messages: Message[] = [
      user('u1', 'hello', 1),
      assistant('a1', 'first', 2),
      assistant('a2', 'second', 3),
    ]
    const out = injectMidTurn(messages, ' appended')
    expect(out.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(out[2]).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'text', text: 'second appended' }],
    })
    expect(out[1]).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'text', text: 'first' }],
    })
  })

  test('no-ops when there is no tool message and no assistant text block', () => {
    const messages: Message[] = [user('u1', 'hello', 1)]
    const out = injectMidTurn(messages, 'hint')
    expect(out).toEqual(messages)
    expect(out.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(out.some((m) => m.role === 'user' && m.blocks[0]?.text === 'hint')).toBe(false)
  })
})
