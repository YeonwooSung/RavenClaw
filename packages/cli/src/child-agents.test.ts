import { describe, expect, test } from 'bun:test'
import type { TaskSnapshot } from '@ravenclaw/core'
import { agentTasks, ChildAgentList, formatChildAgentLine } from './child-agents'

function snapshot(over: Partial<TaskSnapshot> & Pick<TaskSnapshot, 'id' | 'type'>): TaskSnapshot {
  return {
    command: 'prompt',
    description: 'find callers',
    status: 'running',
    outputFile: '/tmp/out.log',
    startedAt: 1,
    ...over,
  }
}

const bash = snapshot({
  id: 'b_bash001',
  type: 'bash',
  command: 'sleep 10',
  description: 'sleep 10',
})

const agentA = snapshot({
  id: 'b_a1b2c3d4',
  type: 'agent',
  description: 'find callers',
})

const agentB = snapshot({
  id: 'b_deadbeef99',
  type: 'agent',
  status: 'completed',
  description: 'review diff',
})

describe('formatChildAgentLine', () => {
  test('formats agent id[:8], status, and description', () => {
    expect(formatChildAgentLine(agentA)).toBe('agent b_a1b2c3 running find callers')
    expect(formatChildAgentLine(agentB)).toBe('agent b_deadbe completed review diff')
  })

  test('skips bash tasks', () => {
    expect(formatChildAgentLine(bash)).toBeUndefined()
  })
})

describe('agentTasks', () => {
  test('keeps only type=agent', () => {
    expect(agentTasks([bash, agentA, agentB])).toEqual([agentA, agentB])
  })

  test('empty list stays empty', () => {
    expect(agentTasks([])).toEqual([])
  })
})

describe('ChildAgentList', () => {
  test('hides when there are no agent tasks', () => {
    expect(ChildAgentList({ tasks: [] })).toBeNull()
    expect(ChildAgentList({ tasks: [bash] })).toBeNull()
  })
})
