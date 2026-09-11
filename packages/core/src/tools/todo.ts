import { mkdirSync, writeFileSync } from 'node:fs'
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
    const root = ctx.turn.projectCwd ?? ctx.turn.cwd
    const items = input.items.map((item, index) => ({
      id: item.id !== undefined && item.id !== '' ? item.id : `todo_${index + 1}`,
      text: item.text,
      status: item.status,
    }))
    const path = join(root, '.ravenclaw', 'todo.json')
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
