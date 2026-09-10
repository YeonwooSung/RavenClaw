import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  PermissionMode,
  SessionRecord,
  SessionStore,
  Tool,
  ToolContext,
} from '../types'

const EMPTY_SCHEMA = {}

type EmptyInput = Record<string, never>

export function createPlanModeTools(store: SessionStore): { enter: Tool; exit: Tool } {
  const enter: Tool<EmptyInput, string> = {
    name: 'EnterPlanMode',
    description:
      'Switch this session into plan mode. Mutating tools are denied until ExitPlanMode. Input is an empty object. Writes .ravenclaw/plan.md if missing.',
    inputSchema: EMPTY_SCHEMA,
    parse: parseEmpty,
    isConcurrencySafe() {
      return true
    },
    isReadOnly() {
      return true
    },
    interruptBehavior() {
      return 'block'
    },
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute(_input, ctx) {
      await applyMode(store, ctx, 'plan')
      maybeWritePlanStub(ctx.turn.cwd)
      return 'mode=plan'
    },
  }

  const exit: Tool<EmptyInput, string> = {
    name: 'ExitPlanMode',
    description:
      'Leave plan mode and restore the previous permission mode. Input is an empty object. Allowed in dontAsk.',
    inputSchema: EMPTY_SCHEMA,
    parse: parseEmpty,
    isConcurrencySafe() {
      return true
    },
    isReadOnly() {
      return true
    },
    interruptBehavior() {
      return 'block'
    },
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute(_input, ctx) {
      const restored = ctx.turn.prePlanMode ?? 'default'
      await applyMode(store, ctx, restored)
      return `mode=${restored}`
    },
  }

  return { enter, exit }
}

function maybeWritePlanStub(cwd: string): void {
  try {
    if (!existsSync(cwd)) return
    const dir = join(cwd, '.ravenclaw')
    const path = join(dir, 'plan.md')
    if (existsSync(path)) return
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, '# Plan\n', { flag: 'wx' })
  } catch {
    // best-effort seam; the mode switch still succeeds
  }
}

function parseEmpty(
  input: unknown,
): { ok: true; value: EmptyInput } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, value: {} }
  if (typeof input === 'object' && !Array.isArray(input)) return { ok: true, value: {} }
  return { ok: false, message: 'expected an object' }
}

async function applyMode(
  store: SessionStore,
  ctx: ToolContext,
  mode: PermissionMode,
): Promise<void> {
  const turn = ctx.turn
  const current = turn.permissionMode
  if (mode === 'plan') {
    if (current !== 'plan') turn.prePlanMode = current
  } else if (turn.prePlanMode !== undefined) {
    delete turn.prePlanMode
  }
  turn.permissionMode = mode

  const session = (await findSession(store, turn.sessionId)) ?? sessionFromTurn(turn)
  session.permissionMode = mode
  if (turn.prePlanMode !== undefined) session.prePlanMode = turn.prePlanMode
  else if (session.prePlanMode !== undefined) delete session.prePlanMode
  session.updatedAt = Date.now()
  await store.upsertSession(session)
}

async function findSession(
  store: SessionStore,
  sessionId: string,
): Promise<SessionRecord | undefined> {
  const rows = await store.listSessions()
  return rows.find((row) => row.id === sessionId)
}

function sessionFromTurn(turn: ToolContext['turn']): SessionRecord {
  const session: SessionRecord = {
    id: turn.sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cwd: turn.cwd,
    model: turn.model,
    permissionMode: turn.permissionMode,
    compactGeneration: turn.compactGeneration,
    usage: { ...turn.usage },
    funding: turn.funding,
  }
  if (turn.prePlanMode !== undefined) session.prePlanMode = turn.prePlanMode
  return session
}
