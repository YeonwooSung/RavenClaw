import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export type TaskV2Status = 'pending' | 'in_progress' | 'completed'

export interface TaskV2Item {
  id: string
  subject: string
  status: TaskV2Status
  description?: string
  blockedBy?: string[]
}

export interface TaskCreateInput {
  subject: string
  description?: string
}

export interface TaskGetInput {
  id: string
}

export interface TaskUpdateInput {
  id: string
  subject?: string
  status?: TaskV2Status
  description?: string
}

export type TaskListInput = Record<string, never>

const STATUSES: TaskV2Status[] = ['pending', 'in_progress', 'completed']

const createSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subject'],
  properties: {
    subject: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
  },
}

const getSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1 },
  },
}

const updateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1 },
    subject: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: STATUSES },
    description: { type: 'string', minLength: 1 },
  },
}

const listSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

export function taskV2Path(cwd: string): string {
  return join(cwd, '.ravenclaw', 'tasks.json')
}

export function newTaskV2Id(): string {
  return `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
}

export function createTaskV2Tools(): {
  create: Tool<TaskCreateInput, string>
  get: Tool<TaskGetInput, string>
  update: Tool<TaskUpdateInput, string>
  list: Tool<TaskListInput, string>
} {
  const create: Tool<TaskCreateInput, string> = {
    name: 'TaskCreate',
    description:
      'Create a durable project task in .ravenclaw/tasks.json. subject is required; optional description. Status starts as pending. Returns an id like t_a1b2c3d4.',
    inputSchema: createSchema,
    parse(input: unknown) {
      return parseWithSchema<TaskCreateInput>(createSchema, input)
    },
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return false
    },
    interruptBehavior() {
      return 'block'
    },
    async checkPermissions() {
      return { behavior: 'ask', message: 'Create this task?', saveAs: 'session' }
    },
    async execute(input: TaskCreateInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      const item: TaskV2Item = {
        id: newTaskV2Id(),
        subject: input.subject,
        status: 'pending',
      }
      if (input.description !== undefined) item.description = input.description
      try {
        const items = loadTasks(storePath(ctx))
        items.push(item)
        saveTasks(storePath(ctx), items)
      } catch (error) {
        return `TaskCreate failed: ${errorMessage(error)}`
      }
      return `created ${formatTask(item)}`
    },
  }

  const get: Tool<TaskGetInput, string> = {
    name: 'TaskGet',
    description: 'Read one project task by id from .ravenclaw/tasks.json.',
    inputSchema: getSchema,
    parse(input: unknown) {
      return parseWithSchema<TaskGetInput>(getSchema, input)
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
    async execute(input: TaskGetInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      let items: TaskV2Item[]
      try {
        items = loadTasks(storePath(ctx))
      } catch (error) {
        return `TaskGet failed: ${errorMessage(error)}`
      }
      const item = items.find((row) => row.id === input.id)
      if (!item) return `TaskGet failed: unknown task ${input.id}`
      return formatTask(item)
    },
  }

  const update: Tool<TaskUpdateInput, string> = {
    name: 'TaskUpdate',
    description:
      'Update a project task by id. Optional subject, status (pending|in_progress|completed), and description.',
    inputSchema: updateSchema,
    parse(input: unknown) {
      return parseWithSchema<TaskUpdateInput>(updateSchema, input)
    },
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return false
    },
    interruptBehavior() {
      return 'block'
    },
    async checkPermissions() {
      return { behavior: 'ask', message: 'Update this task?', saveAs: 'session' }
    },
    async execute(input: TaskUpdateInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      try {
        const path = storePath(ctx)
        const items = loadTasks(path)
        const index = items.findIndex((row) => row.id === input.id)
        if (index === -1) return `TaskUpdate failed: unknown task ${input.id}`
        const current = items[index]
        if (!current) return `TaskUpdate failed: unknown task ${input.id}`
        const next: TaskV2Item = { ...current }
        if (input.subject !== undefined) next.subject = input.subject
        if (input.status !== undefined) next.status = input.status
        if (input.description !== undefined) next.description = input.description
        items[index] = next
        saveTasks(path, items)
        return `updated ${formatTask(next)}`
      } catch (error) {
        return `TaskUpdate failed: ${errorMessage(error)}`
      }
    },
  }

  const list: Tool<TaskListInput, string> = {
    name: 'TaskList',
    description: 'List project tasks as id, status, and subject from .ravenclaw/tasks.json.',
    inputSchema: listSchema,
    parse(input: unknown) {
      return parseWithSchema<TaskListInput>(listSchema, input)
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
    async execute(_input: TaskListInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      let items: TaskV2Item[]
      try {
        items = loadTasks(storePath(ctx))
      } catch (error) {
        return `TaskList failed: ${errorMessage(error)}`
      }
      if (items.length === 0) return 'no tasks'
      return items.map(formatTask).join('\n')
    },
  }

  return { create, get, update, list }
}

function storePath(ctx: ToolContext): string {
  return taskV2Path(ctx.turn.projectCwd ?? ctx.turn.cwd)
}

function loadTasks(path: string): TaskV2Item[] {
  if (!existsSync(path)) return []
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
      ? (raw as { tasks: unknown[] }).tasks
      : undefined
  if (!rows) throw new Error(`invalid tasks file: ${path}`)
  return rows.map(parseStoredTask)
}

function parseStoredTask(value: unknown): TaskV2Item {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid task')
  }
  const rec = value as {
    id?: unknown
    subject?: unknown
    status?: unknown
    description?: unknown
    blockedBy?: unknown
  }
  if (typeof rec.id !== 'string' || rec.id.length === 0) throw new Error('invalid task')
  if (typeof rec.subject !== 'string' || rec.subject.length === 0) throw new Error('invalid task')
  if (rec.status !== 'pending' && rec.status !== 'in_progress' && rec.status !== 'completed') {
    throw new Error('invalid task')
  }
  const item: TaskV2Item = { id: rec.id, subject: rec.subject, status: rec.status }
  if (typeof rec.description === 'string') item.description = rec.description
  if (Array.isArray(rec.blockedBy) && rec.blockedBy.every((id) => typeof id === 'string')) {
    item.blockedBy = rec.blockedBy
  }
  return item
}

function saveTasks(path: string, items: TaskV2Item[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(items, null, 2)}\n`, 'utf8')
}

function formatTask(item: TaskV2Item): string {
  const lines = [`${item.id}  ${item.status}  ${item.subject}`]
  if (item.description !== undefined && item.description !== '') {
    lines.push(`  ${item.description}`)
  }
  if (item.blockedBy !== undefined && item.blockedBy.length > 0) {
    lines.push(`  blockedBy ${item.blockedBy.join(',')}`)
  }
  return lines.join('\n')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
