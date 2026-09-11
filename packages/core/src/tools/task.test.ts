import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { createTaskRegistry } from '../tasks/registry'
import { decidePermission } from '../permissions/pipeline'
import { taskOutputTool, taskStopTool } from './task'

const emptyRules = { session: [], user: [], project: [] }

function makeCtx(tasks = createTaskRegistry()): ToolContext {
  const turn: Turn = {
    id: 't',
    sessionId: 's',
    messages: [],
    round: 1,
    maxRounds: 8,
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
  return { turn, signal: turn.abort.signal, onProgress() {}, tasks }
}

describe('TaskOutput / TaskStop', () => {
  test('TaskOutput is read-only allow; TaskStop leftover-asks', async () => {
    expect(taskOutputTool.isReadOnly({})).toBe(true)
    expect(taskStopTool.isReadOnly({})).toBe(false)
    const ctx = makeCtx()
    expect((await taskOutputTool.checkPermissions({ task_id: 'b_x' }, ctx)).behavior).toBe('allow')
    expect((await taskStopTool.checkPermissions({ task_id: 'b_x' }, ctx)).behavior).toBe('ask')
    const dontAsk = await decidePermission({
      name: 'TaskStop',
      input: { task_id: 'b_x' },
      tool: taskStopTool,
      ctx,
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(dontAsk.behavior).toBe('deny')
  })

  test('reads and stops a registered task', async () => {
    const dir = join(tmpdir(), `raven-task-tool-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const outputFile = join(dir, 'out.log')
    writeFileSync(outputFile, 'ping\n')
    const tasks = createTaskRegistry()
    const started = tasks.register({ command: 'echo ping', outputFile, kill() {} })
    const ctx = makeCtx(tasks)
    const out = await taskOutputTool.execute({ task_id: started.id }, ctx)
    expect(out).toContain(started.id)
    expect(out).toContain('ping')
    const stopped = await taskStopTool.execute({ task_id: started.id }, ctx)
    expect(stopped).toContain('stopped')
    expect(tasks.get(started.id)?.status).toBe('killed')
  })
})
