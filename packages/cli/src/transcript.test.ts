import { describe, expect, test } from 'bun:test'
import type { ToolResult } from '@ravenclaw/core'
import {
  RESULT_CLIP,
  TRANSCRIPT_EXPAND_KEY,
  clipToolResult,
  isCompactTool,
  selectedToolId,
  shouldToggleExpand,
  toggleExpanded,
  visibleToolResult,
  type TranscriptRow,
} from './transcript'

function toolRow(
  name: string,
  id: string,
  content?: string,
  ok = true,
): Extract<TranscriptRow, { kind: 'tool' }> {
  const result: ToolResult | undefined =
    content === undefined
      ? undefined
      : { toolUseId: id, ok, content }
  return { kind: 'tool', id, name, input: { path: 'src/a.ts' }, ...(result ? { result } : {}) }
}

const rows: TranscriptRow[] = [
  { kind: 'user', text: 'read it' },
  toolRow('Read', 'read-1', 'file body'),
  { kind: 'assistant', text: 'done' },
  toolRow('Bash', 'bash-1', 'ok output'),
]

describe('isCompactTool', () => {
  test('Read, Grep, and Glob collapse; Bash does not', () => {
    expect(isCompactTool('Read')).toBe(true)
    expect(isCompactTool('Grep')).toBe(true)
    expect(isCompactTool('Glob')).toBe(true)
    expect(isCompactTool('Bash')).toBe(false)
    expect(isCompactTool('Edit')).toBe(false)
    expect(isCompactTool('Write')).toBe(false)
  })
})

describe('clipToolResult', () => {
  test('leaves text at or under 2k unchanged', () => {
    expect(clipToolResult('short')).toBe('short')
    expect(clipToolResult('x'.repeat(RESULT_CLIP))).toBe('x'.repeat(RESULT_CLIP))
  })

  test('clips longer results to 2k including the ellipsis', () => {
    const clipped = clipToolResult('y'.repeat(RESULT_CLIP + 80))
    expect(clipped.length).toBe(RESULT_CLIP)
    expect(clipped.endsWith('…')).toBe(true)
    expect(clipped.slice(0, RESULT_CLIP - 1)).toBe('y'.repeat(RESULT_CLIP - 1))
  })
})

describe('toggleExpanded', () => {
  test('adds, removes, and does not mutate the input set', () => {
    const empty = new Set<string>()
    const added = toggleExpanded(empty, 'read-1')
    expect([...added]).toEqual(['read-1'])
    expect(empty.size).toBe(0)

    const removed = toggleExpanded(added, 'read-1')
    expect(removed.size).toBe(0)
    expect(added.has('read-1')).toBe(true)

    const extra = toggleExpanded(added, 'grep-2')
    expect(extra.has('read-1')).toBe(true)
    expect(extra.has('grep-2')).toBe(true)
  })
})

describe('selectedToolId', () => {
  test('returns the tool id only when the selected row is a tool', () => {
    expect(selectedToolId(rows, 1)).toBe('read-1')
    expect(selectedToolId(rows, 3)).toBe('bash-1')
    expect(selectedToolId(rows, 0)).toBeUndefined()
    expect(selectedToolId(rows, 2)).toBeUndefined()
    expect(selectedToolId(rows, undefined)).toBeUndefined()
    expect(selectedToolId(rows, -1)).toBeUndefined()
    expect(selectedToolId(rows, 99)).toBeUndefined()
  })
})

describe('shouldToggleExpand', () => {
  test('matches Ctrl+O and ignores other keys', () => {
    expect(TRANSCRIPT_EXPAND_KEY).toBe('ctrl+o')
    expect(shouldToggleExpand('o', { ctrl: true })).toBe(true)
    expect(shouldToggleExpand('O', { ctrl: true })).toBe(true)
    expect(shouldToggleExpand('o', { ctrl: false })).toBe(false)
    expect(shouldToggleExpand('o', {})).toBe(false)
    expect(shouldToggleExpand('c', { ctrl: true })).toBe(false)
    expect(shouldToggleExpand('', { ctrl: true })).toBe(false)
  })
})

describe('visibleToolResult', () => {
  test('hides compact results until the id is expanded', () => {
    const read = toolRow('Read', 'read-1', 'secret body')
    const grep = toolRow('Grep', 'grep-1', 'hits')
    const glob = toolRow('Glob', 'glob-1', 'files')
    expect(visibleToolResult(read)).toBeUndefined()
    expect(visibleToolResult(grep, new Set())).toBeUndefined()
    expect(visibleToolResult(glob, new Set(['other']))).toBeUndefined()
    expect(visibleToolResult(read, new Set(['read-1']))).toBe('secret body')
    expect(visibleToolResult(grep, new Set(['grep-1']))).toBe('hits')
    expect(visibleToolResult(glob, new Set(['glob-1']))).toBe('files')
  })

  test('always shows Bash result text, clipped to 2k', () => {
    const bash = toolRow('Bash', 'bash-1', 'stdout')
    expect(visibleToolResult(bash)).toBe('stdout')
    expect(visibleToolResult(bash, new Set())).toBe('stdout')

    const long = toolRow('Bash', 'bash-2', 'z'.repeat(RESULT_CLIP + 10))
    const shown = visibleToolResult(long)
    expect(shown?.length).toBe(RESULT_CLIP)
    expect(shown?.endsWith('…')).toBe(true)
  })

  test('clips an expanded compact result to 2k', () => {
    const read = toolRow('Read', 'read-1', 'w'.repeat(RESULT_CLIP + 5))
    const shown = visibleToolResult(read, new Set(['read-1']))
    expect(shown?.length).toBe(RESULT_CLIP)
    expect(shown?.endsWith('…')).toBe(true)
  })

  test('hides pending tools with no result body', () => {
    expect(visibleToolResult(toolRow('Read', 'pending'))).toBeUndefined()
    expect(visibleToolResult(toolRow('Bash', 'pending'))).toBeUndefined()
    expect(visibleToolResult(toolRow('Read', 'empty', ''))).toBeUndefined()
  })
})
