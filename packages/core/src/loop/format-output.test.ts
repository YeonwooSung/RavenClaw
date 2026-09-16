import { describe, expect, test } from 'bun:test'
import type { Tool } from '../types'
import { formatSettledOutput } from './format-output'

function tool(over: Partial<Tool> = {}): Tool {
  return {
    name: 'Echo',
    description: 'echo',
    inputSchema: { type: 'object' },
    parse(input) {
      return { ok: true, value: input }
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute() {
      return 'ok'
    },
    ...over,
  }
}

describe('formatSettledOutput', () => {
  test('string output is the content and has no persistPath', () => {
    expect(formatSettledOutput(tool(), 'hello')).toEqual({ content: 'hello' })
  })

  test('renderResult wins over object.content', () => {
    const t = tool({
      renderResult(output) {
        return `rendered:${(output as { content: string }).content}`
      },
    })
    expect(formatSettledOutput(t, { content: 'raw', persistPath: '/tmp/out.txt' })).toEqual({
      content: 'rendered:raw',
      persistPath: '/tmp/out.txt',
    })
  })

  test('undefined and null become empty content', () => {
    expect(formatSettledOutput(tool(), undefined)).toEqual({ content: '' })
    expect(formatSettledOutput(tool(), null)).toEqual({ content: '' })
  })

  test('object with string content uses that field', () => {
    expect(formatSettledOutput(tool(), { content: 'body' })).toEqual({ content: 'body' })
  })

  test('object without string content is JSON.stringified', () => {
    expect(formatSettledOutput(tool(), { n: 1 })).toEqual({ content: '{"n":1}' })
    expect(formatSettledOutput(tool(), { content: 7 })).toEqual({ content: '{"content":7}' })
  })

  test('non-empty persistPath is copied; empty persistPath is dropped', () => {
    expect(formatSettledOutput(tool(), { content: 'x', persistPath: '/tmp/out.txt' })).toEqual({
      content: 'x',
      persistPath: '/tmp/out.txt',
    })
    expect(formatSettledOutput(tool(), { content: 'x', persistPath: '' })).toEqual({ content: 'x' })
  })

  test('primitives fall back to String', () => {
    expect(formatSettledOutput(tool(), 42)).toEqual({ content: '42' })
    expect(formatSettledOutput(tool(), true)).toEqual({ content: 'true' })
  })
})
