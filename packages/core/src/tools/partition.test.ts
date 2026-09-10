import { describe, expect, test } from 'bun:test'
import type { Tool } from '../types'
import { partitionToolCalls } from './partition'
import { readTool } from './read'

function mockTool(name: string, safe: boolean, parseOk = true): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    parse(input: unknown) {
      if (!parseOk) return { ok: false, message: 'bad input' }
      if (!input || typeof input !== 'object') return { ok: false, message: 'expected object' }
      return { ok: true, value: input }
    },
    isConcurrencySafe() {
      return safe
    },
    isReadOnly() {
      return safe
    },
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute() {
      return ''
    },
  }
}

const writeTool = mockTool('Write', false)
const editTool = mockTool('Edit', false)
const tools: Tool[] = [readTool, writeTool, editTool]

function ids(batches: Array<Array<{ id: string }>>): string[][] {
  return batches.map((batch) => batch.map((call) => call.id))
}

describe('partitionToolCalls', () => {
  test('two safe Reads batch together', () => {
    const batches = partitionToolCalls(
      [
        { id: 'r1', name: 'Read', input: { path: 'a.ts' } },
        { id: 'r2', name: 'Read', input: { path: 'b.ts' } },
      ],
      tools,
    )
    expect(ids(batches)).toEqual([['r1', 'r2']])
  })

  test('an unsafe mock runs alone in arrival order', () => {
    const batches = partitionToolCalls(
      [
        { id: 'r1', name: 'Read', input: { path: 'a.ts' } },
        { id: 'w1', name: 'Write', input: { path: 'b.ts' } },
        { id: 'r2', name: 'Read', input: { path: 'c.ts' } },
      ],
      tools,
    )
    expect(ids(batches)).toEqual([['r1'], ['w1'], ['r2']])
  })

  test('parse failure is a serial singleton', () => {
    const batches = partitionToolCalls(
      [
        { id: 'r1', name: 'Read', input: { path: 'a.ts' } },
        { id: 'bad', name: 'Read', input: { nope: true } },
        { id: 'r2', name: 'Read', input: { path: 'c.ts' } },
      ],
      tools,
    )
    expect(ids(batches)).toEqual([['r1'], ['bad'], ['r2']])
  })

  test('parallel batches respect the default cap of 8', () => {
    const calls = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      name: 'Read',
      input: { path: `${i}.ts` },
    }))
    const batches = partitionToolCalls(calls, tools)
    expect(ids(batches)).toEqual([
      ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'],
      ['r8', 'r9'],
    ])
  })

  test('opts.cap can shrink a parallel batch', () => {
    const batches = partitionToolCalls(
      [
        { id: 'r1', name: 'Read', input: { path: 'a.ts' } },
        { id: 'r2', name: 'Read', input: { path: 'b.ts' } },
        { id: 'r3', name: 'Read', input: { path: 'c.ts' } },
      ],
      tools,
      { cap: 2 },
    )
    expect(ids(batches)).toEqual([['r1', 'r2'], ['r3']])
  })

  test('path overlap with Write/Edit serializes equal and prefix paths', () => {
    const equal = partitionToolCalls(
      [
        { id: 'r1', name: 'Read', input: { path: 'src/a.ts' } },
        { id: 'w1', name: 'Write', input: { path: 'src/a.ts' } },
      ],
      tools,
    )
    expect(ids(equal)).toEqual([['r1'], ['w1']])

    const prefix = partitionToolCalls(
      [
        { id: 'r1', name: 'Read', input: { path: 'src/a.ts' } },
        { id: 'e1', name: 'Edit', input: { path: 'src' } },
      ],
      tools,
    )
    expect(ids(prefix)).toEqual([['r1'], ['e1']])
  })

  test('path overlap serializes even if Write claims to be concurrency-safe', () => {
    const safeWrite = mockTool('Write', true)
    const batches = partitionToolCalls(
      [
        { id: 'r1', name: 'Read', input: { path: 'src/a.ts' } },
        { id: 'w1', name: 'Write', input: { path: 'src/a.ts' } },
        { id: 'r2', name: 'Read', input: { path: 'other.ts' } },
      ],
      [readTool, safeWrite],
    )
    expect(ids(batches)).toEqual([['r1'], ['w1'], ['r2']])
  })
})
