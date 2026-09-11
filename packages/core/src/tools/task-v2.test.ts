import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decidePermission } from '../permissions/pipeline'
import type { ToolContext, Turn } from '../types'
import { createTaskV2Tools, taskV2Path, type TaskV2Item } from './task-v2'

const tempDirs: string[] = []
const emptyRules = { session: [], user: [], project: [] }

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-task-v2-'))
  tempDirs.push(root)
  return root
}

function makeTurn(cwd: string, over: Partial<Turn> = {}): Turn {
  return {
    id: 'turn_1',
    sessionId: 'sess_1',
    messages: [],
    round: 1,
    maxRounds: 80,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd,
    model: 'dummy',
    readFiles: new Set(),
    ...over,
  }
}

function makeCtx(cwd: string, over: Partial<Turn> = {}): ToolContext {
  const turn = makeTurn(cwd, over)
  return { turn, signal: turn.abort.signal, onProgress() {} }
}

function readStore(cwd: string): TaskV2Item[] {
  const raw = JSON.parse(readFileSync(taskV2Path(cwd), 'utf8')) as TaskV2Item[]
  return raw
}

describe('createTaskV2Tools', () => {
  test('names, flags, leftover-ask, and dontAsk via decidePermission', async () => {
    const { create, get, update, list } = createTaskV2Tools()
    const ctx = makeCtx('/tmp')

    expect(create.name).toBe('TaskCreate')
    expect(get.name).toBe('TaskGet')
    expect(update.name).toBe('TaskUpdate')
    expect(list.name).toBe('TaskList')

    expect(create.isReadOnly({ subject: 'x' })).toBe(false)
    expect(create.isConcurrencySafe({ subject: 'x' })).toBe(false)
    expect(get.isReadOnly({ id: 't_x' })).toBe(true)
    expect(get.isConcurrencySafe({ id: 't_x' })).toBe(true)
    expect(update.isReadOnly({ id: 't_x' })).toBe(false)
    expect(update.isConcurrencySafe({ id: 't_x' })).toBe(false)
    expect(list.isReadOnly({})).toBe(true)
    expect(list.isConcurrencySafe({})).toBe(true)

    const createAsk = await create.checkPermissions({ subject: 'x' }, ctx)
    expect(createAsk.behavior).toBe('ask')
    if (createAsk.behavior === 'ask') {
      expect(createAsk.message.length).toBeGreaterThan(0)
      expect(createAsk.saveAs).toBe('session')
    }

    const updateAsk = await update.checkPermissions({ id: 't_x', status: 'completed' }, ctx)
    expect(updateAsk.behavior).toBe('ask')
    if (updateAsk.behavior === 'ask') {
      expect(updateAsk.message.length).toBeGreaterThan(0)
      expect(updateAsk.saveAs).toBe('session')
    }

    expect(await get.checkPermissions({ id: 't_x' }, ctx)).toEqual({
      behavior: 'allow',
      reason: 'mode',
    })
    expect(await list.checkPermissions({}, ctx)).toEqual({ behavior: 'allow', reason: 'mode' })

    const listDontAsk = await decidePermission({
      name: 'TaskList',
      input: {},
      tool: list,
      ctx,
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(listDontAsk.behavior).toBe('allow')

    const getDontAsk = await decidePermission({
      name: 'TaskGet',
      input: { id: 't_x' },
      tool: get,
      ctx,
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(getDontAsk.behavior).toBe('allow')

    const createDontAsk = await decidePermission({
      name: 'TaskCreate',
      input: { subject: 'x' },
      tool: create,
      ctx,
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(createDontAsk.behavior).toBe('deny')
    if (createDontAsk.behavior === 'deny') expect(createDontAsk.reason).toBe('mode')

    const updateDontAsk = await decidePermission({
      name: 'TaskUpdate',
      input: { id: 't_x', status: 'completed' },
      tool: update,
      ctx,
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(updateDontAsk.behavior).toBe('deny')

    const leftover = await decidePermission({
      name: 'TaskCreate',
      input: { subject: 'x' },
      tool: create,
      ctx,
      mode: 'default',
      rules: emptyRules,
    })
    expect(leftover.behavior).toBe('ask')
    if (leftover.behavior === 'ask') expect(leftover.saveAs).toBe('session')
  })

  test('parse accepts the documented inputs', () => {
    const { create, get, update, list } = createTaskV2Tools()
    expect(create.parse({ subject: 'ship' }).ok).toBe(true)
    expect(create.parse({ subject: 'ship', description: 'later' }).ok).toBe(true)
    expect(create.parse({}).ok).toBe(false)
    expect(create.parse({ subject: '' }).ok).toBe(false)
    expect(get.parse({ id: 't_abc' }).ok).toBe(true)
    expect(get.parse({}).ok).toBe(false)
    expect(update.parse({ id: 't_abc' }).ok).toBe(true)
    expect(update.parse({ id: 't_abc', status: 'in_progress' }).ok).toBe(true)
    expect(update.parse({ id: 't_abc', status: 'done' }).ok).toBe(false)
    expect(update.parse({}).ok).toBe(false)
    expect(list.parse({}).ok).toBe(true)
    expect(list.parse({ extra: true }).ok).toBe(false)
  })

  test('create writes .ravenclaw/tasks.json with t_+8hex and pending', async () => {
    const root = fixtureRoot()
    const { create } = createTaskV2Tools()
    const out = await create.execute({ subject: 'ship', description: 'cut a tag' }, makeCtx(root))
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(out).toMatch(/^created t_[0-9a-f]{8}  pending  ship/)
    expect(out).toContain('cut a tag')

    const path = taskV2Path(root)
    expect(existsSync(path)).toBe(true)
    const items = readStore(root)
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toMatch(/^t_[0-9a-f]{8}$/)
    expect(items[0]?.id.length).toBe(10)
    expect(items[0]?.subject).toBe('ship')
    expect(items[0]?.status).toBe('pending')
    expect(items[0]?.description).toBe('cut a tag')
  })

  test('uses projectCwd when the turn is isolated', async () => {
    const project = fixtureRoot()
    const worktree = fixtureRoot()
    const { create } = createTaskV2Tools()
    await create.execute({ subject: 'iso' }, makeCtx(worktree, { projectCwd: project }))
    expect(existsSync(taskV2Path(project))).toBe(true)
    expect(existsSync(taskV2Path(worktree))).toBe(false)
  })

  test('get, update, and list round-trip the store', async () => {
    const root = fixtureRoot()
    const { create, get, update, list } = createTaskV2Tools()
    const ctx = makeCtx(root)

    expect(await list.execute({}, ctx)).toBe('no tasks')
    expect(await get.execute({ id: 't_missing' }, ctx)).toContain('unknown task')
    expect(await update.execute({ id: 't_missing', status: 'completed' }, ctx)).toContain(
      'unknown task',
    )

    const created = await create.execute({ subject: 'one' }, ctx)
    const id = /^created (t_[0-9a-f]{8}) /.exec(created)?.[1]
    expect(id).toBeDefined()

    const listed = await list.execute({}, ctx)
    expect(listed).toContain(`${id}  pending  one`)

    const got = await get.execute({ id: id! }, ctx)
    expect(got).toBe(`${id}  pending  one`)

    const updated = await update.execute(
      { id: id!, subject: 'two', status: 'in_progress', description: 'now' },
      ctx,
    )
    expect(updated).toContain('updated')
    expect(updated).toContain('in_progress')
    expect(updated).toContain('two')
    expect(updated).toContain('now')

    const stored = readStore(root)
    expect(stored[0]).toEqual({
      id: id!,
      subject: 'two',
      status: 'in_progress',
      description: 'now',
    })
  })

  test('update keeps blockedBy from the stored item', async () => {
    const root = fixtureRoot()
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(
      taskV2Path(root),
      `${JSON.stringify(
        [
          {
            id: 't_aaaaaaaa',
            subject: 'blocked',
            status: 'pending',
            blockedBy: ['t_bbbbbbbb'],
          },
        ],
        null,
        2,
      )}\n`,
      'utf8',
    )
    const { update, get } = createTaskV2Tools()
    const ctx = makeCtx(root)
    const out = await update.execute({ id: 't_aaaaaaaa', status: 'in_progress' }, ctx)
    expect(out).toContain('blockedBy t_bbbbbbbb')
    expect(await get.execute({ id: 't_aaaaaaaa' }, ctx)).toContain('blockedBy t_bbbbbbbb')
    expect(readStore(root)[0]?.blockedBy).toEqual(['t_bbbbbbbb'])
  })

  test('execute refuses when the signal is already aborted', async () => {
    const { create, get, update, list } = createTaskV2Tools()
    const ac = new AbortController()
    ac.abort()
    const turn = makeTurn('/tmp')
    const ctx: ToolContext = { turn, signal: ac.signal, onProgress() {} }
    await expect(create.execute({ subject: 'x' }, ctx)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(get.execute({ id: 't_x' }, ctx)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(update.execute({ id: 't_x' }, ctx)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(list.execute({}, ctx)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
