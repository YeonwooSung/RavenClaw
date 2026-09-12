import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { createTaskRegistry } from '../tasks/registry'
import { decidePermission } from '../permissions/pipeline'
import { taskOutputTool, taskStopTool, taskSteerTool } from './task'

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

describe('TaskSteer', () => {
  test('is read-only allow and formats success or failure', async () => {
    expect(taskSteerTool.isReadOnly({})).toBe(true)
    const tasks = createTaskRegistry()
    const dir = join(tmpdir(), `raven-steer-tool-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const outputFile = join(dir, 'out.log')
    writeFileSync(outputFile, '')
    const agent = tasks.register({
      type: 'agent',
      command: 'child',
      outputFile,
      kill() {},
    })
    const ctx = makeCtx(tasks)
    expect((await taskSteerTool.checkPermissions({ taskId: agent.id, text: 'hi' }, ctx)).behavior).toBe(
      'allow',
    )
    const dontAsk = await decidePermission({
      name: 'TaskSteer',
      input: { taskId: agent.id, text: 'hi' },
      tool: taskSteerTool,
      ctx,
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(dontAsk.behavior).toBe('allow')

    expect(await taskSteerTool.execute({ taskId: agent.id, text: 'hi' }, ctx)).toBe(
      `TaskSteer failed: agent not started`,
    )
    tasks.attachEngine(agent.id, { enqueueSteer() {} })
    expect(await taskSteerTool.execute({ taskId: agent.id, text: 'hello from parent' }, ctx)).toBe(
      `steered ${agent.id} hello from parent`,
    )
    expect(await taskSteerTool.execute({ taskId: agent.id, text: '   ' }, ctx)).toBe(
      'TaskSteer failed: empty text',
    )
    expect(await taskSteerTool.execute({ taskId: 'missing', text: 'x' }, ctx)).toBe(
      'TaskSteer failed: not a live agent task',
    )
    const parsed = taskSteerTool.parse({ taskId: 'b_1', text: 'go' })
    expect(parsed.ok).toBe(true)
  })
})
