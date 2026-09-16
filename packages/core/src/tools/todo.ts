import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export type TodoStatus = 'pending' | 'in_progress' | 'done'

export interface TodoItem {
  id?: string
  text: string
  status: TodoStatus
}

export interface TodoWriteInput {
  items: TodoItem[]
}

const TODO_STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'done'])

export function todoJsonPath(root: string): string {
  return join(root, '.ravenclaw', 'todo.json')
}

/** Fail-open read of `.ravenclaw/todo.json`. Missing or invalid → `[]`. */
export function loadTodos(root: string): TodoItem[] {
  let raw: string
  try {
    raw = readFileSync(todoJsonPath(root), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return parseTodoItems(parsed)
}

/** Parse a JSON value into checklist items. Non-arrays become `[]`. */
export function parseTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return []
  const items: TodoItem[] = []
  for (const entry of value) {
    const item = parseTodoItem(entry)
    if (item !== undefined) items.push(item)
  }
  return items
}

/** Reload after a TodoWrite tool_result; otherwise keep the previous snapshot. */
export function todosFromToolResult(
  name: string,
  cwd: string,
  previous: TodoItem[],
): TodoItem[] {
  return name === 'TodoWrite' ? loadTodos(cwd) : previous
}

function parseTodoItem(entry: unknown): TodoItem | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const rec = entry as Record<string, unknown>
  if (typeof rec.text !== 'string' || rec.text.length === 0) return undefined
  if (typeof rec.status !== 'string' || !TODO_STATUSES.has(rec.status as TodoStatus)) {
    return undefined
  }
  const item: TodoItem = { text: rec.text, status: rec.status as TodoStatus }
  if (typeof rec.id === 'string' && rec.id.length > 0) item.id = rec.id
  return item
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'status'],
        properties: {
          id: { type: 'string', minLength: 1 },
          text: { type: 'string', minLength: 1 },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
        },
      },
    },
  },
}

export const todoWriteTool: Tool<TodoWriteInput, string> = {
  name: 'TodoWrite',
  description:
    'Replace the session checklist. items is an array of { id?, text, status } where status is pending, in_progress, or done. Written to .ravenclaw/todo.json under the project root.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<TodoWriteInput>(inputSchema, input)
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
    return { behavior: 'allow', reason: 'mode' }
  },
  async execute(input: TodoWriteInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    const store = ctx.store
    if (!store) return 'TodoWrite failed: session store is required'
    const items = input.items.map((item, index) => ({
      id: item.id !== undefined && item.id !== '' ? item.id : `todo_${index + 1}`,
      text: item.text,
      status: item.status,
    }))
    try {
      const loaded = await store.loadSession(ctx.turn.sessionId)
      loaded.session.todos = items
      loaded.session.updatedAt = Date.now()
      await store.upsertSession(loaded.session)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `TodoWrite failed: ${message}`
    }
    const root = ctx.turn.projectCwd ?? ctx.turn.cwd
    const path = todoJsonPath(root)
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(items, null, 2)}\n`, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `TodoWrite failed: ${message}`
    }
    return `Wrote ${items.length} checklist item${items.length === 1 ? '' : 's'} to .ravenclaw/todo.json`
  },
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
