import { describe, expect, test } from 'bun:test'
import type { Tool, ToolContext, Turn } from '../types'
import { createToolRegistry } from './registry'

function makeTurn(): Turn {
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
    cwd: '/tmp',
    model: 'dummy',
    readFiles: new Set(),
  }
}

function makeCtx(): ToolContext {
  const turn = makeTurn()
  return { turn, signal: turn.abort.signal, onProgress() {} }
}

function mockTool(name: string, extra?: Pick<Tool, 'isEnabled'>): Tool {
  const tool: Tool = {
    name,
    description: name,
    inputSchema: { type: 'object' },
    parse(input: unknown) {
      return { ok: true, value: input }
    },
    isConcurrencySafe() {
      return true
    },
    isReadOnly() {
      return true
    },
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute() {
      return ''
    },
  }
  if (extra?.isEnabled) tool.isEnabled = extra.isEnabled
  return tool
}

describe('createToolRegistry', () => {
  test('register, get, and list return tools in registration order', () => {
    const alpha = mockTool('Alpha')
    const beta = mockTool('Beta')
    const registry = createToolRegistry([alpha])
    registry.register(beta)

    expect(registry.get('Alpha')).toBe(alpha)
    expect(registry.get('Beta')).toBe(beta)
    expect(registry.get('Missing')).toBeUndefined()
    expect(registry.list().map((tool) => tool.name)).toEqual(['Alpha', 'Beta'])
  })

  test('list({ names }) keeps only requested names', () => {
    const registry = createToolRegistry([
      mockTool('Read'),
      mockTool('Grep'),
      mockTool('Glob'),
    ])
    expect(registry.list({ names: ['Grep', 'Missing'] }).map((tool) => tool.name)).toEqual([
      'Grep',
    ])
  })

  test('list without ctx keeps tools that define isEnabled', () => {
    const registry = createToolRegistry([
      mockTool('Always'),
      mockTool('Gated', { isEnabled: () => false }),
    ])
    expect(registry.list().map((tool) => tool.name)).toEqual(['Always', 'Gated'])
  })

  test('list with ctx omits tools whose isEnabled is false', () => {
    const ctx = makeCtx()
    const registry = createToolRegistry([
      mockTool('Always'),
      mockTool('Gated', { isEnabled: () => false }),
      mockTool('On', { isEnabled: () => true }),
    ])
    expect(registry.list(undefined, ctx).map((tool) => tool.name)).toEqual(['Always', 'On'])
    expect(registry.list({ names: ['Gated', 'On'] }, ctx).map((tool) => tool.name)).toEqual([
      'On',
    ])
  })
})
