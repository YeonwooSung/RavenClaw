import { describe, expect, test } from 'bun:test'
import type { Tool } from '../types'
import { cyclePermissionMode, isMutatingTool } from './modes'

function stubTool(name: string, readOnly: boolean): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    parse(input: unknown) {
      return { ok: true as const, value: input }
    },
    isConcurrencySafe() {
      return readOnly
    },
    isReadOnly() {
      return readOnly
    },
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute() {
      return ''
    },
  }
}

describe('cyclePermissionMode', () => {
  test.each([
    ['default', 'acceptEdits'],
    ['acceptEdits', 'plan'],
    ['plan', 'default'],
    ['dontAsk', 'dontAsk'],
  ] as const)('%s → %s', (from, to) => {
    expect(cyclePermissionMode(from)).toBe(to)
  })

  test('does not include bypass', () => {
    expect(cyclePermissionMode('plan')).not.toBe('bypass' as never)
    expect(cyclePermissionMode('default')).not.toBe('dontAsk')
  })
})

describe('isMutatingTool', () => {
  test('Edit, Write, Agent, and Bash are mutating by name', () => {
    expect(isMutatingTool('Edit')).toBe(true)
    expect(isMutatingTool('Write')).toBe(true)
    expect(isMutatingTool('Agent')).toBe(true)
    expect(isMutatingTool('Bash')).toBe(true)
  })

  test('read-only names and plan-mode tools are not mutating', () => {
    expect(isMutatingTool('Read')).toBe(false)
    expect(isMutatingTool('Grep')).toBe(false)
    expect(isMutatingTool('Glob')).toBe(false)
    expect(isMutatingTool('Skill')).toBe(false)
    expect(isMutatingTool('EnterPlanMode')).toBe(false)
    expect(isMutatingTool('ExitPlanMode')).toBe(false)
  })

  test('uses tool.isReadOnly when a tool is provided', () => {
    expect(isMutatingTool('Bash', { command: 'ls' }, stubTool('Bash', true))).toBe(false)
    expect(isMutatingTool('Bash', { command: 'rm' }, stubTool('Bash', false))).toBe(true)
    expect(isMutatingTool('Read', { path: 'a' }, stubTool('Read', true))).toBe(false)
  })

  test('ExitPlanMode is never mutating even if a tool claims otherwise', () => {
    expect(isMutatingTool('ExitPlanMode', {}, stubTool('ExitPlanMode', false))).toBe(false)
  })
})
