import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'
import { exitSessionWorktree, getSessionWorktree, type WorktreeExitAction } from './session-worktree'

export interface ExitWorktreeInput {
  action: WorktreeExitAction
  discard_changes?: boolean
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['keep', 'remove'] },
    discard_changes: { type: 'boolean' },
  },
}

export const exitWorktreeTool: Tool<ExitWorktreeInput, string> = {
  name: 'ExitWorktree',
  description:
    'Leave the session git worktree and restore the original cwd. action keep leaves the worktree on disk; remove deletes it. remove of a dirty worktree fails unless discard_changes is true. No-op if this session is not in a worktree.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<ExitWorktreeInput>(inputSchema, input)
  },
  isEnabled(ctx: ToolContext) {
    return getSessionWorktree(ctx.turn.sessionId) !== undefined
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
    return { behavior: 'ask', message: 'Leave this git worktree?', saveAs: 'session' }
  },
  async execute(input: ExitWorktreeInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    if (!getSessionWorktree(ctx.turn.sessionId)) return 'No session worktree'
    const result = exitSessionWorktree(ctx.turn.sessionId, input.action, input.discard_changes)
    if (!result.ok) return `ExitWorktree failed: ${result.error}`
    ctx.turn.cwd = result.cwd
    return input.action === 'keep' ? 'Left worktree (kept)' : 'Left worktree (removed)'
  },
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
