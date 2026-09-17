import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'
import { enterSessionWorktree, getSessionWorktree, gitToplevel } from './session-worktree'

export interface EnterWorktreeInput {
  name?: string
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
  },
}

export const enterWorktreeTool: Tool<EnterWorktreeInput, string> = {
  name: 'EnterWorktree',
  description:
    'Create a named raven/* git worktree under .ravenclaw/worktrees and switch the turn cwd to it. Optional name labels the worktree directory and shadow branch. projectCwd stays the original project root.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<EnterWorktreeInput>(inputSchema, input)
  },
  isEnabled(ctx: ToolContext) {
    return (
      getSessionWorktree(ctx.turn.sessionId) !== undefined ||
      gitToplevel(ctx.turn.cwd) !== undefined
    )
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
    return { behavior: 'ask', message: 'Enter a git worktree?', saveAs: 'session' }
  },
  async execute(input: EnterWorktreeInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    const parent = ctx.turn.projectCwd ?? ctx.turn.cwd
    const result = enterSessionWorktree(ctx.turn.sessionId, parent, input.name)
    if (!result.ok) return `EnterWorktree failed: ${result.error}`
    if (ctx.turn.projectCwd === undefined) ctx.turn.projectCwd = parent
    ctx.turn.cwd = result.cwd
    if (result.job) {
      if (ctx.session) ctx.session.job = result.job
      const store = ctx.store
      if (store) {
        try {
          const session = ctx.session ?? (await store.loadSession(ctx.turn.sessionId)).session
          session.job = result.job
          await store.upsertSession(session)
        } catch {
          // worktree is live; sidecar can rebuild the job until upsert succeeds
        }
      }
    }
    return `Entered worktree ${result.cwd}`
  },
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
