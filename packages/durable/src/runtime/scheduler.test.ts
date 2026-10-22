import { describe, expect, test } from 'bun:test'
import type { DurableTaskRow } from '../storage/types.ts'
import { evolveTask, reconcileTask } from './scheduler.ts'

function running(restarts: number): DurableTaskRow {
  return {
    id: 2,
    name: 'tool',
    conversationId: 1,
    status: 'running',
    checkpoint: { phase: 'execute', replay: 'safe' },
    restarts,
    parked: false,
  }
}

describe('restart counter', () => {
  test('the cutoff that reaches the limit parks and does not invoke', () => {
    const parked = reconcileTask(running(4), 5)
    expect(parked.invoke).toBe(false)
    expect(parked.task.status).toBe('pending')
    expect(parked.task.restarts).toBe(5)
    expect(parked.task.parked).toBe(true)
    expect(parked.task.checkpoint).toEqual({ phase: 'execute', replay: 'safe' })

    const again = reconcileTask(running(3), 5)
    expect(again.invoke).toBe(true)
    expect(again.task.restarts).toBe(4)
    expect(again.task.parked).toBe(false)
  })

  test('an equal checkpoint keeps restarts and a new checkpoint clears them', () => {
    const task = running(2)
    const same = evolveTask(task, { status: 'running', checkpoint: { phase: 'execute', replay: 'safe' } })
    expect(same.restarts).toBe(2)
    const changed = evolveTask(task, { status: 'running', checkpoint: { phase: 'execute', replay: 'unsafe' } })
    expect(changed.restarts).toBe(0)
    const terminal = evolveTask(task, { status: 'terminal', outcome: 'failed' })
    expect(terminal.restarts).toBe(0)
    expect(terminal.checkpoint).toBeUndefined()
    expect(terminal.outcome).toBe('failed')
  })
})
