import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../session/memory-store'
import { decidePermission } from '../permissions/pipeline'
import type { SessionRecord, ToolContext, Turn } from '../types'
import { createPlanModeTools } from './plan-mode'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess_plan',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp/proj',
    model: 'dummy',
    permissionMode: 'acceptEdits',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
    ...over,
  }
}

function makeTurn(session: SessionRecord): Turn {
  const turn: Turn = {
    id: 'turn_1',
    sessionId: session.id,
    messages: [],
    round: 1,
    maxRounds: 80,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: session.permissionMode,
    usage: { ...session.usage },
    compactGeneration: session.compactGeneration,
    funding: session.funding,
    cwd: session.cwd,
    model: session.model,
    readFiles: new Set(),
  }
  if (session.prePlanMode !== undefined) turn.prePlanMode = session.prePlanMode
  return turn
}

function makeCtx(turn: Turn): ToolContext {
  return { turn, signal: turn.abort.signal, onProgress() {} }
}

describe('createPlanModeTools', () => {
  test('EnterPlanMode uses empty object schema, allows, upserts plan, and writes no plan file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-plan-'))
    tempDirs.push(cwd)
    const store = createMemoryStore()
    const session = makeSession({ cwd, permissionMode: 'acceptEdits' })
    await store.createSession(session)
    const { enter } = createPlanModeTools(store)
    const turn = makeTurn(session)
    const ctx = makeCtx(turn)

    expect(enter.name).toBe('EnterPlanMode')
    expect(enter.inputSchema).toEqual({})
    expect(enter.isReadOnly({})).toBe(true)
    expect(enter.isConcurrencySafe({})).toBe(true)
    expect(await enter.checkPermissions({}, ctx)).toEqual({ behavior: 'allow', reason: 'mode' })

    const parsed = enter.parse({})
    expect(parsed.ok).toBe(true)

    const out = await enter.execute({}, ctx)
    expect(out).toBe('mode=plan')
    expect(turn.permissionMode).toBe('plan')
    expect(turn.prePlanMode).toBe('acceptEdits')

    const loaded = await store.loadSession(session.id)
    expect(loaded.session.permissionMode).toBe('plan')
    expect(loaded.session.prePlanMode).toBe('acceptEdits')
    expect(existsSync(join(cwd, 'plan.md'))).toBe(false)
    expect(readdirSync(cwd)).toEqual([])
  })

  test('EnterPlanMode does not overwrite prePlanMode when already in plan', async () => {
    const store = createMemoryStore()
    const session = makeSession({ permissionMode: 'plan', prePlanMode: 'default' })
    await store.createSession(session)
    const { enter } = createPlanModeTools(store)
    const turn = makeTurn(session)
    await enter.execute({}, makeCtx(turn))
    expect(turn.permissionMode).toBe('plan')
    expect(turn.prePlanMode).toBe('default')
    const loaded = await store.loadSession(session.id)
    expect(loaded.session.prePlanMode).toBe('default')
  })

  test('ExitPlanMode restores prePlanMode, upserts, and is allow in dontAsk', async () => {
    const store = createMemoryStore()
    const session = makeSession({ permissionMode: 'plan', prePlanMode: 'acceptEdits' })
    await store.createSession(session)
    const { exit } = createPlanModeTools(store)
    const turn = makeTurn(session)
    const ctx = makeCtx(turn)

    expect(exit.name).toBe('ExitPlanMode')
    expect(exit.inputSchema).toEqual({})
    expect(await exit.checkPermissions({}, ctx)).toEqual({ behavior: 'allow', reason: 'mode' })

    const out = await exit.execute({}, ctx)
    expect(out).toBe('mode=acceptEdits')
    expect(turn.permissionMode).toBe('acceptEdits')
    expect(turn.prePlanMode).toBeUndefined()

    const loaded = await store.loadSession(session.id)
    expect(loaded.session.permissionMode).toBe('acceptEdits')
    expect(loaded.session.prePlanMode).toBeUndefined()

    turn.permissionMode = 'dontAsk'
    const allowed = await decidePermission({
      tool: exit,
      name: 'ExitPlanMode',
      input: {},
      ctx,
      mode: 'dontAsk',
      rules: { session: [], user: [], project: [] },
    })
    expect(allowed.behavior).toBe('allow')
  })

  test('ExitPlanMode defaults restored mode to default', async () => {
    const store = createMemoryStore()
    const session = makeSession({ permissionMode: 'plan' })
    await store.createSession(session)
    const { exit } = createPlanModeTools(store)
    const turn = makeTurn(session)
    const out = await exit.execute({}, makeCtx(turn))
    expect(out).toBe('mode=default')
    expect(turn.permissionMode).toBe('default')
    const loaded = await store.loadSession(session.id)
    expect(loaded.session.permissionMode).toBe('default')
  })

  test('mutating Edit is denied as a permission decision while in plan', async () => {
    const store = createMemoryStore()
    const session = makeSession({ permissionMode: 'default' })
    await store.createSession(session)
    const { enter, exit } = createPlanModeTools(store)
    const turn = makeTurn(session)
    const ctx = makeCtx(turn)
    await enter.execute({}, ctx)

    const edit: import('../types').Tool = {
      name: 'Edit',
      description: 'edit',
      inputSchema: { type: 'object' },
      parse(input: unknown) {
        return { ok: true as const, value: input }
      },
      isConcurrencySafe() {
        return false
      },
      isReadOnly() {
        return false
      },
      async checkPermissions() {
        return { behavior: 'allow', reason: 'mode' }
      },
      async execute() {
        return 'wrote'
      },
    }
    const denied = await decidePermission({
      tool: edit,
      name: 'Edit',
      input: { path: 'a.txt', old_string: 'a', new_string: 'b' },
      ctx,
      mode: turn.permissionMode,
      rules: { session: [], user: [], project: [] },
    })
    expect(denied.behavior).toBe('deny')
    if (denied.behavior === 'deny') expect(denied.reason).toBe('mode')

    await exit.execute({}, ctx)
    const after = await decidePermission({
      tool: edit,
      name: 'Edit',
      input: { path: 'a.txt', old_string: 'a', new_string: 'b' },
      ctx,
      mode: turn.permissionMode,
      rules: { session: [], user: [], project: [] },
    })
    expect(after.behavior).toBe('allow')
  })
})
