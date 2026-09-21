import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StreamEvent } from '@ravenclaw/core'
import { composerLine, createOpenTuiView, permissionPromptLines } from './render'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

describe('createOpenTuiView', () => {
  test('starts with no lines', () => {
    const view = createOpenTuiView()
    expect(view.lines()).toEqual([])
  })

  test('text_delta appends to the current assistant line', () => {
    const view = createOpenTuiView()
    view.apply({ type: 'text_delta', text: 'Hello' })
    view.apply({ type: 'text_delta', text: ' world' })
    expect(view.lines()).toEqual(['Hello world'])
  })

  test('a non-text event closes the assistant line so the next delta starts a new one', () => {
    const view = createOpenTuiView()
    view.apply({ type: 'text_delta', text: 'Hello' })
    view.apply({ type: 'status', message: 'working' })
    view.apply({ type: 'text_delta', text: 'Done' })
    expect(view.lines()).toEqual(['Hello', 'status  working', 'Done'])
  })

  test('thinking_delta appends to the current thinking line', () => {
    const view = createOpenTuiView()
    view.apply({ type: 'thinking_delta', text: 'hmm' })
    view.apply({ type: 'thinking_delta', text: ' ok' })
    expect(view.lines()).toEqual(['thinking  hmm ok'])
  })

  test('tool_call / tool_progress / tool_result become labeled lines', () => {
    const view = createOpenTuiView()
    view.apply({ type: 'tool_call', id: 'c1', name: 'Read', input: { path: 'a.ts' } })
    view.apply({ type: 'tool_progress', id: 'c1', text: 'opening' })
    view.apply({
      type: 'tool_result',
      id: 'c1',
      result: { toolUseId: 'c1', ok: true, content: 'file body' },
    })
    expect(view.lines()).toEqual([
      'tool_call  Read',
      'tool_progress  opening',
      'tool_result  ok',
    ])
  })

  test('failed tool_result is labeled error', () => {
    const view = createOpenTuiView()
    view.apply({
      type: 'tool_result',
      id: 'c2',
      result: { toolUseId: 'c2', ok: false, content: 'enoent' },
    })
    expect(view.lines()).toEqual(['tool_result  error'])
  })

  test('status / error / compact / usage / permission_ask / round_start / round_end produce short lines', () => {
    const view = createOpenTuiView()
    const events: StreamEvent[] = [
      { type: 'round_start', round: 2 },
      { type: 'status', message: 'streaming' },
      { type: 'compact', summary: 'prior turns folded', generation: 1 },
      {
        type: 'permission_ask',
        id: 'p1',
        tool: 'Bash',
        input: { command: 'ls' },
        message: 'Allow Bash?',
      },
      { type: 'error', message: 'provider timeout', recoverable: true },
      { type: 'usage', usage: { input: 10, output: 4, cacheRead: 1, cacheWrite: 0 } },
      { type: 'round_end', end: { reason: 'completed' } },
    ]
    for (const event of events) view.apply(event)
    expect(view.lines()).toEqual([
      'round_start  2',
      'status  streaming',
      'compact  prior turns folded',
      'permission_ask  Bash',
      'error  provider timeout',
      'usage  10↑ 4↓',
      'round_end  completed',
    ])
  })

  test('round_end uses the reason as the short payload', () => {
    const view = createOpenTuiView()
    view.apply({ type: 'round_end', end: { reason: 'max_rounds', round: 8 } })
    view.apply({ type: 'round_end', end: { reason: 'aborted' } })
    view.apply({ type: 'round_end', end: { reason: 'model_error', error: 'boom' } })
    expect(view.lines()).toEqual([
      'round_end  max_rounds',
      'round_end  aborted',
      'round_end  model_error',
    ])
  })

  test('paints a mixed StreamEvent sequence as terminal lines', () => {
    const view = createOpenTuiView()
    const events: StreamEvent[] = [
      { type: 'round_start', round: 1 },
      { type: 'text_delta', text: 'I will read ' },
      { type: 'text_delta', text: 'the file.' },
      { type: 'tool_call', id: 't1', name: 'Read', input: { path: 'a.ts' } },
      { type: 'tool_progress', id: 't1', text: 'reading' },
      {
        type: 'tool_result',
        id: 't1',
        result: { toolUseId: 't1', ok: true, content: 'x' },
      },
      { type: 'status', message: 'continuing' },
      { type: 'usage', usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 } },
      { type: 'round_end', end: { reason: 'completed' } },
    ]
    for (const event of events) view.apply(event)
    expect(view.lines()).toEqual([
      'round_start  1',
      'I will read the file.',
      'tool_call  Read',
      'tool_progress  reading',
      'tool_result  ok',
      'status  continuing',
      'usage  10↑ 4↓',
      'round_end  completed',
    ])
  })

  test('reset clears painted lines and the current assistant line', () => {
    const view = createOpenTuiView()
    view.apply({ type: 'text_delta', text: 'Hello' })
    view.apply({ type: 'status', message: 'working' })
    view.reset()
    expect(view.lines()).toEqual([])
    view.apply({ type: 'text_delta', text: 'Fresh' })
    expect(view.lines()).toEqual(['Fresh'])
  })

  test('each factory call is an independent view', () => {
    const a = createOpenTuiView()
    const b = createOpenTuiView()
    a.apply({ type: 'text_delta', text: 'A' })
    b.apply({ type: 'text_delta', text: 'B' })
    expect(a.lines()).toEqual(['A'])
    expect(b.lines()).toEqual(['B'])
  })

  test('lines() returns a snapshot', () => {
    const view = createOpenTuiView()
    view.apply({ type: 'text_delta', text: 'Hello' })
    const first = view.lines()
    first.push('mutated')
    expect(view.lines()).toEqual(['Hello'])
  })

  test('append adds a labeled line without breaking the current assistant row', () => {
    const view = createOpenTuiView()
    view.append('you  hi')
    view.apply({ type: 'text_delta', text: 'Hello' })
    expect(view.lines()).toEqual(['you  hi', 'Hello'])
  })
})

describe('composer and permission helpers', () => {
  test('composerLine shows a prompt or busy marker', () => {
    expect(composerLine()).toBe('> ')
    expect(composerLine('draft')).toBe('> draft')
    expect(composerLine('', true)).toBe('… ')
    expect(
      permissionPromptLines({
        type: 'permission_ask',
        id: 'p1',
        tool: 'Bash',
        input: { command: 'ls' },
        message: 'run ls in /tmp',
      }),
    ).toEqual(['Allow Bash?', 'run ls in /tmp', 'y allow   n deny   a always   i skip'])
    expect(
      permissionPromptLines({
        type: 'permission_ask',
        id: 'p2',
        tool: 'Bash',
        input: { command: 'ls' },
        message: 'run ls',
        childSessionId: 'sess_child',
      }),
    ).toEqual(['Allow Bash? (child sess_child)', 'run ls', 'y allow   n deny   a always   i skip'])
  })
})

describe('package seam', () => {
  test('entry re-exports the view factory', async () => {
    const mod = await import('./index')
    expect(typeof mod.createOpenTuiView).toBe('function')
    const view = mod.createOpenTuiView()
    view.apply({ type: 'text_delta', text: 'via index' })
    expect(view.lines()).toEqual(['via index'])
  })

  test('source has no Ink or React imports', () => {
    const files = walk(join(import.meta.dir)).filter(
      (path) => path.endsWith('.ts') && !path.endsWith('.test.ts'),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      expect(text).not.toMatch(/from ['"]ink['"]/)
      expect(text).not.toMatch(/from ['"]react['"]/)
      expect(text).not.toMatch(/from ['"]react\/jsx-runtime['"]/)
    }
  })
})
