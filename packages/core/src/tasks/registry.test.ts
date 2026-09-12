import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSecondAbortGate,
  createTaskRegistry,
  formatKilledBackgroundNotice,
  formatTasksNotice,
  parseTasksArg,
} from './registry'

describe('createTaskRegistry', () => {
  test('register, complete, kill, and format', () => {
    const dir = join(tmpdir(), `raven-tasks-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const outputFile = join(dir, 'out.log')
    writeFileSync(outputFile, 'hello\n')
    let killed = false
    const tasks = createTaskRegistry()
    const started = tasks.register({
      command: 'sleep 10',
      outputFile,
      kill: () => {
        killed = true
      },
    })
    expect(started.id.startsWith('b_')).toBe(true)
    expect(started.status).toBe('running')
    expect(tasks.list()).toHaveLength(1)
    expect(tasks.readOutput(started.id)).toBe('hello\n')
    expect(formatTasksNotice(tasks.list())).toContain(started.id)
    expect(formatTasksNotice(tasks.list())).toContain('running')

    const completed = tasks.complete(started.id, 0)
    expect(completed?.status).toBe('completed')
    expect(completed?.exitCode).toBe(0)

    const other = tasks.register({
      command: 'sleep 99',
      outputFile,
      kill: () => {
        killed = true
      },
    })
    const stopped = tasks.kill(other.id)
    expect(killed).toBe(true)
    expect(stopped?.status).toBe('killed')
    expect(formatTasksNotice([])).toBe('no background tasks')
  })

  test('killAll stops every running task', () => {
    const dir = join(tmpdir(), `raven-tasks-all-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const outputFile = join(dir, 'out.log')
    writeFileSync(outputFile, '')
    const killed: string[] = []
    const tasks = createTaskRegistry()
    const first = tasks.register({
      command: 'sleep 1',
      outputFile,
      kill: () => {
        killed.push('a')
      },
    })
    const second = tasks.register({
      command: 'sleep 2',
      outputFile,
      kill: () => {
        killed.push('b')
      },
    })
    tasks.complete(first.id, 0)
    const stopped = tasks.killAll()
    expect(killed).toEqual(['b'])
    expect(stopped.map((task) => task.id)).toEqual([second.id])
    expect(tasks.get(second.id)?.status).toBe('killed')
    expect(tasks.get(first.id)?.status).toBe('completed')
  })
})

describe('createSecondAbortGate', () => {
  test('second press within 3s is kill_all; later press is abort again', () => {
    let now = 1_000
    const gate = createSecondAbortGate({ now: () => now, windowMs: 3_000 })
    expect(gate.press()).toBe('abort')
    now = 3_500
    expect(gate.press()).toBe('kill_all')
    now = 3_600
    expect(gate.press()).toBe('abort')
    now = 7_000
    expect(gate.press()).toBe('abort')
    expect(formatKilledBackgroundNotice(0)).toBe('no background tasks to kill')
    expect(formatKilledBackgroundNotice(1)).toBe('killed 1 background task')
    expect(formatKilledBackgroundNotice(3)).toBe('killed 3 background tasks')
  })
})

describe('parseTasksArg', () => {
  test('list vs kill', () => {
    expect(parseTasksArg()).toEqual({ action: 'list' })
    expect(parseTasksArg('')).toEqual({ action: 'list' })
    expect(parseTasksArg('kill b_abc')).toEqual({ action: 'kill', id: 'b_abc' })
    expect(parseTasksArg('KILL  b_xyz')).toEqual({ action: 'kill', id: 'b_xyz' })
    expect(parseTasksArg('steer b_abc turn left')).toEqual({
      action: 'steer',
      id: 'b_abc',
      text: 'turn left',
    })
    expect(parseTasksArg('steer b_abc')).toEqual({
      action: 'error',
      message: 'usage: /tasks [kill <id>|steer <id> <text>]',
    })
  })
})

describe('attachEngine and steer', () => {
  test('live agent only; empty text and missing engine fail', () => {
    const dir = join(tmpdir(), `raven-tasks-steer-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const outputFile = join(dir, 'out.log')
    writeFileSync(outputFile, '')
    const tasks = createTaskRegistry()
    const calls: string[] = []
    const agent = tasks.register({
      type: 'agent',
      command: 'child',
      outputFile,
      kill() {},
    })
    expect(tasks.steer(agent.id, 'hello')).toEqual({
      ok: false,
      error: 'agent not started',
    })
    tasks.attachEngine(agent.id, {
      enqueueSteer(text) {
        calls.push(text)
      },
    })
    expect(tasks.steer(agent.id, '  ')).toEqual({ ok: false, error: 'empty text' })
    expect(tasks.steer(agent.id, 'hello')).toEqual({ ok: true })
    expect(calls).toEqual(['hello'])

    const bash = tasks.register({
      type: 'bash',
      command: 'sleep 1',
      outputFile,
      kill() {},
    })
    expect(tasks.steer(bash.id, 'nope')).toEqual({
      ok: false,
      error: 'not a live agent task',
    })
    expect(tasks.steer('missing', 'nope')).toEqual({
      ok: false,
      error: 'not a live agent task',
    })

    tasks.complete(agent.id, 0)
    expect(tasks.steer(agent.id, 'later')).toEqual({
      ok: false,
      error: 'not a live agent task',
    })
    expect(calls).toEqual(['hello'])
  })
})
