import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FileHistory } from '../session/file-history'
import type { ToolContext, Turn } from '../types'
import { decidePermission } from '../permissions/pipeline'
import { createNotebookEditTool, notebookEditTool } from './notebook-edit'
import { parseNotebook } from './notebook-format'

const emptyRules = { session: [], user: [], project: [] }
const HOME_ENV = 'RAVENCLAW_HOME'
const tempDirs: string[] = []
let savedHome: string | undefined

afterEach(() => {
  if (savedHome === undefined) delete process.env[HOME_ENV]
  else process.env[HOME_ENV] = savedHome
  savedHome = undefined
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-nb-'))
  tempDirs.push(root)
  return root
}

function makeTurn(cwd: string): Turn {
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
  }
}

function mockHistory(): FileHistory & { snaps: string[] } {
  const snaps: string[] = []
  return {
    snaps,
    beginTurn() {},
    endTurn() {},
    snapshot(path: string) {
      snaps.push(path)
    },
    undo() {
      return { restored: [], removed: [] }
    },
    pendingCount() {
      return snaps.length
    },
    turnWriteCount() {
      return snaps.length
    },
  }
}

function makeCtx(cwd: string, signal?: AbortSignal, history?: FileHistory): ToolContext {
  const turn = makeTurn(cwd)
  return {
    turn,
    signal: signal ?? turn.abort.signal,
    onProgress() {},
    fileHistory: history,
  }
}

function resolvedOf(cwd: string, rel: string): string {
  const candidate = resolve(cwd, rel)
  try {
    return realpathSync(candidate)
  } catch {
    return candidate
  }
}

function writeNotebook(dir: string, name: string, cells: unknown[]): string {
  const path = join(dir, name)
  writeFileSync(
    path,
    `${JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells }, null, 1)}\n`,
    'utf8',
  )
  return path
}

describe('NotebookEdit', () => {
  test('is an unsafe mutating tool that leftover-asks and blocks interrupt', async () => {
    expect(notebookEditTool.name).toBe('NotebookEdit')
    expect(notebookEditTool.isConcurrencySafe({ path: 'a.ipynb', new_source: 'x' })).toBe(false)
    expect(notebookEditTool.isReadOnly({ path: 'a.ipynb', new_source: 'x' })).toBe(false)
    expect(notebookEditTool.interruptBehavior?.()).toBe('block')
    const decision = await notebookEditTool.checkPermissions(
      { path: 'a.ipynb', new_source: 'x' },
      makeCtx('/tmp'),
    )
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message.length).toBeGreaterThan(0)
      expect(decision.saveAs).toBe('session')
    }
  })

  test('default mode leftover ask stays ask', async () => {
    const decision = await decidePermission({
      name: 'NotebookEdit',
      input: { path: 'a.ipynb', new_source: 'x' },
      tool: notebookEditTool,
      ctx: makeCtx('/tmp'),
      mode: 'default',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('ask')
  })

  test('parse requires path and new_source', () => {
    expect(notebookEditTool.parse({ path: 'a.ipynb', new_source: 'x' }).ok).toBe(true)
    expect(
      notebookEditTool.parse({ path: 'a.ipynb', new_source: 'x', edit_mode: 'insert' }).ok,
    ).toBe(true)
    expect(notebookEditTool.parse({ path: 'a.ipynb' }).ok).toBe(false)
    expect(notebookEditTool.parse({ new_source: 'x' }).ok).toBe(false)
    expect(
      notebookEditTool.parse({ path: 'a.ipynb', new_source: 'x', edit_mode: 'nope' }).ok,
    ).toBe(false)
  })

  test('fails without a prior Read and does not write', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const out = await notebookEditTool.execute({ path: 'nb.ipynb', new_source: 'new' }, makeCtx(root))
    expect(out.toLowerCase()).toMatch(/read/)
    const parsed = parseNotebook(readFileSync(join(root, 'nb.ipynb'), 'utf8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected notebook')
    expect(parsed.value.cells[0]?.source).toEqual(['old'])
  })

  test('replaces the last cell after Read and snapshots', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const history = mockHistory()
    const ctx = makeCtx(root, undefined, history)
    ctx.turn.readFiles.add(resolvedOf(root, 'nb.ipynb'))
    const out = await notebookEditTool.execute({ path: 'nb.ipynb', new_source: 'print(9)' }, ctx)
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(out).toContain('nb.ipynb')
    const parsed = parseNotebook(readFileSync(join(root, 'nb.ipynb'), 'utf8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected notebook')
    expect(parsed.value.cells[0]?.source).toEqual(['print(9)'])
    expect(history.snaps).toContain(resolvedOf(root, 'nb.ipynb'))
  })

  test('inserts after cell_id and deletes by cell_id', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'nb.ipynb'))
    const inserted = await notebookEditTool.execute(
      { path: 'nb.ipynb', new_source: 'new', cell_id: 'abc', edit_mode: 'insert' },
      ctx,
    )
    expect(inserted.toLowerCase()).toMatch(/insert/)
    let parsed = parseNotebook(readFileSync(join(root, 'nb.ipynb'), 'utf8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected notebook')
    expect(parsed.value.cells).toHaveLength(2)
    const newId = parsed.value.cells[1]?.id
    expect(newId).toMatch(/^c_[0-9a-f]{8}$/)

    const deleted = await notebookEditTool.execute(
      { path: 'nb.ipynb', new_source: '', cell_id: newId, edit_mode: 'delete' },
      ctx,
    )
    expect(deleted.toLowerCase()).toMatch(/delete/)
    parsed = parseNotebook(readFileSync(join(root, 'nb.ipynb'), 'utf8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected notebook')
    expect(parsed.value.cells).toHaveLength(1)
    expect(parsed.value.cells[0]?.id).toBe('abc')
  })

  test('hard-denies writes to $RAVENCLAW_HOME/state.db', async () => {
    const root = fixtureRoot()
    savedHome = process.env[HOME_ENV]
    process.env[HOME_ENV] = root
    const db = join(root, 'state.db')
    writeFileSync(db, '{"cells":[]}\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'state.db'))
    const out = await notebookEditTool.execute({ path: db, new_source: 'hacked' }, ctx)
    expect(out.toLowerCase()).toMatch(/deny|denied|protected|refused|not allowed/)
    expect(readFileSync(db, 'utf8')).toBe('{"cells":[]}\n')
  })

  test('refuses a path outside cwd and does not write', async () => {
    const root = fixtureRoot()
    const outside = fixtureRoot()
    const outsideNb = writeNotebook(outside, 'nb.ipynb', [
      { id: 'abc', cell_type: 'code', source: ['old'] },
    ])
    const before = readFileSync(outsideNb, 'utf8')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(outside, 'nb.ipynb'))
    const out = await notebookEditTool.execute(
      { path: outsideNb, new_source: 'hacked' },
      ctx,
    )
    expect(out).toBe('NotebookEdit failed: outside workspace')
    expect(readFileSync(outsideNb, 'utf8')).toBe(before)
  })

  test('refuses a relative path that escapes cwd and does not write', async () => {
    const parent = fixtureRoot()
    const cwd = join(parent, 'proj')
    mkdirSync(cwd)
    writeNotebook(parent, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const before = readFileSync(join(parent, 'nb.ipynb'), 'utf8')
    const ctx = makeCtx(cwd)
    ctx.turn.readFiles.add(resolvedOf(parent, 'nb.ipynb'))
    const out = await notebookEditTool.execute(
      { path: '../nb.ipynb', new_source: 'hacked' },
      ctx,
    )
    expect(out).toBe('NotebookEdit failed: outside workspace')
    expect(readFileSync(join(parent, 'nb.ipynb'), 'utf8')).toBe(before)
  })

  test('hard-deny still runs before the cwd jail', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add('/etc/shadow')
    const out = await notebookEditTool.execute(
      { path: '/etc/shadow', new_source: 'x' },
      ctx,
    )
    expect(out).toBe('NotebookEdit failed: write denied to protected path: /etc/shadow')
  })

  test('execute refuses when the signal is already aborted', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const ac = new AbortController()
    ac.abort()
    const ctx = makeCtx(root, ac.signal)
    ctx.turn.readFiles.add(resolvedOf(root, 'nb.ipynb'))
    await expect(
      notebookEditTool.execute({ path: 'nb.ipynb', new_source: 'x' }, ctx),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('createNotebookEditTool without backend still replaces after Read', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const tool = createNotebookEditTool()
    expect(tool.name).toBe('NotebookEdit')
    expect(tool.isConcurrencySafe({ path: 'nb.ipynb', new_source: 'x' })).toBe(false)
    expect(tool.isReadOnly({ path: 'nb.ipynb', new_source: 'x' })).toBe(false)
    expect(tool.interruptBehavior?.()).toBe('block')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'nb.ipynb'))
    const out = await tool.execute({ path: 'nb.ipynb', new_source: 'print(9)' }, ctx)
    expect(out).toContain('nb.ipynb')
    const parsed = parseNotebook(readFileSync(join(root, 'nb.ipynb'), 'utf8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected notebook')
    expect(parsed.value.cells[0]?.source).toEqual(['print(9)'])
  })
})
