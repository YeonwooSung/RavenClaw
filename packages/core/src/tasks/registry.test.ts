import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskRegistry, formatTasksNotice, parseTasksArg } from './registry'

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
})

describe('parseTasksArg', () => {
  test('list vs kill', () => {
    expect(parseTasksArg()).toEqual({ action: 'list' })
    expect(parseTasksArg('')).toEqual({ action: 'list' })
    expect(parseTasksArg('kill b_abc')).toEqual({ action: 'kill', id: 'b_abc' })
    expect(parseTasksArg('KILL  b_xyz')).toEqual({ action: 'kill', id: 'b_xyz' })
  })
})
