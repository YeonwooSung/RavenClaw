import { parseWithSchema } from './parse'
import type { Tool, ToolContext } from '../types'

export interface TaskOutputInput {
  task_id: string
  block?: boolean
  timeout?: number
}

export interface TaskStopInput {
  task_id: string
}

export interface TaskSteerInput {
  taskId: string
  text: string
}

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['task_id'],
  properties: {
    task_id: { type: 'string', minLength: 1 },
    block: { type: 'boolean' },
    timeout: { type: 'integer', minimum: 0 },
  },
}

const stopSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['task_id'],
  properties: {
    task_id: { type: 'string', minLength: 1 },
  },
}

const steerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId', 'text'],
  properties: {
    taskId: { type: 'string', minLength: 1 },
    text: { type: 'string' },
  },
}

export const taskOutputTool: Tool<TaskOutputInput, string> = {
  name: 'TaskOutput',
  description:
    'Read the output of a background Bash or Agent task started with run_in_background. Optional block waits until the task finishes or timeout milliseconds elapse (default 30000).',
  inputSchema: outputSchema,
  parse(input: unknown) {
    return parseWithSchema<TaskOutputInput>(outputSchema, input)
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  interruptBehavior() {
    return 'cancel'
  },
  async checkPermissions() {
    return { behavior: 'allow', reason: 'mode' }
  },
  async execute(input: TaskOutputInput, ctx: ToolContext) {
    const tasks = ctx.tasks
    if (!tasks) return 'TaskOutput failed: no task registry'
    const timeoutMs = input.timeout ?? 30_000
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (ctx.signal.aborted) throw abortError()
      const task = tasks.get(input.task_id)
      if (!task) return `TaskOutput failed: unknown task ${input.task_id}`
      const output = tasks.readOutput(input.task_id) ?? ''
      if (task.status !== 'running' || input.block !== true) {
        return formatTaskOutput(task.id, task.status, output, task.exitCode)
      }
      if (Date.now() >= deadline) {
        return formatTaskOutput(task.id, task.status, output, task.exitCode, true)
      }
      await sleep(50)
    }
  },
}

export const taskStopTool: Tool<TaskStopInput, string> = {
  name: 'TaskStop',
  description: 'Stop a running background Bash or Agent task by id from TaskOutput or /tasks.',
  inputSchema: stopSchema,
  parse(input: unknown) {
    return parseWithSchema<TaskStopInput>(stopSchema, input)
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  interruptBehavior() {
    return 'cancel'
  },
  async checkPermissions() {
    return { behavior: 'ask', message: 'Stop this background task?', saveAs: 'session' }
  },
  async execute(input: TaskStopInput, ctx: ToolContext) {
    const tasks = ctx.tasks
    if (!tasks) return 'TaskStop failed: no task registry'
    const task = tasks.kill(input.task_id)
    if (!task) return `TaskStop failed: unknown task ${input.task_id}`
    return `stopped ${task.id} (${task.status})`
  },
}

export const taskSteerTool: Tool<TaskSteerInput, string> = {
  name: 'TaskSteer',
  description:
    'Inject a mid-turn hint into a live background Agent started with run_in_background. Does not re-run tools. Fails if the task is Bash, finished, or not yet started.',
  inputSchema: steerSchema,
  parse(input: unknown) {
    return parseWithSchema<TaskSteerInput>(steerSchema, input)
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  interruptBehavior() {
    return 'cancel'
  },
  async checkPermissions() {
    return { behavior: 'allow', reason: 'mode' }
  },
  async execute(input: TaskSteerInput, ctx: ToolContext) {
    const tasks = ctx.tasks
    if (!tasks) return 'TaskSteer failed: no task registry'
    const result = tasks.steer(input.taskId, input.text)
    if (!result.ok) return `TaskSteer failed: ${result.error}`
    const preview = input.text.trim().slice(0, 40)
    return `steered ${input.taskId} ${preview}`
  },
}

function formatTaskOutput(
  id: string,
  status: string,
  output: string,
  exitCode?: number,
  timedOut = false,
): string {
  const lines = [`task ${id}  ${status}`]
  if (exitCode !== undefined) lines.push(`exit_code=${exitCode}`)
  if (timedOut) lines.push('timed out waiting for completion')
  if (output.length > 0) lines.push(output.endsWith('\n') ? output.slice(0, -1) : output)
  return lines.join('\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
