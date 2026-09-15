import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FileHistory } from '../session/file-history'
import type { ToolContext, Turn } from '../types'
import { decidePermission } from '../permissions/pipeline'
import { applyPatchTool, applyUnifiedDiff, contentFromCreateDiff } from './apply-patch'
import { readTool } from './read'

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
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-apply-'))
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

describe('ApplyPatch', () => {
  test('is an unsafe mutating tool that leftover-asks and blocks interrupt', async () => {
    const input = { operations: [{ type: 'delete_file' as const, path: 'a.txt' }] }
    expect(applyPatchTool.name).toBe('ApplyPatch')
    expect(applyPatchTool.isConcurrencySafe(input)).toBe(false)
    expect(applyPatchTool.isReadOnly(input)).toBe(false)
    expect(applyPatchTool.interruptBehavior?.()).toBe('block')
    const decision = await applyPatchTool.checkPermissions(input, makeCtx('/tmp'))
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message.length).toBeGreaterThan(0)
      expect(decision.saveAs).toBe('session')
    }
  })

  test('default mode leftover ask stays ask', async () => {
    const decision = await decidePermission({
      name: 'ApplyPatch',
      input: { operations: [{ type: 'create_file', path: 'a.txt', diff: 'x' }] },
      tool: applyPatchTool,
      ctx: makeCtx('/tmp'),
      mode: 'default',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('ask')
  })

  test('parse requires operations and a diff for create/update', () => {
    expect(
      applyPatchTool.parse({ operations: [{ type: 'create_file', path: 'a.ts', diff: '+' }] }).ok,
    ).toBe(true)
    expect(applyPatchTool.parse({ operations: [{ type: 'delete_file', path: 'a.ts' }] }).ok).toBe(true)
    expect(applyPatchTool.parse({ operations: [] }).ok).toBe(false)
    expect(applyPatchTool.parse({ operations: [{ type: 'create_file', path: 'a.ts' }] }).ok).toBe(
      false,
    )
    expect(applyPatchTool.parse({}).ok).toBe(false)
  })

  test('create_file uses + lines as content and does not require a prior Read', async () => {
    const root = fixtureRoot()
    const history = mockHistory()
    const ctx = makeCtx(root, undefined, history)
    const out = await applyPatchTool.execute(
      {
        operations: [
          {
            type: 'create_file',
            path: 'src/new.ts',
            diff: '+export const n = 1\n+export const m = 2\n',
          },
        ],
      },
      ctx,
    )
    expect(out).toBe('created src/new.ts')
    expect(readFileSync(join(root, 'src', 'new.ts'), 'utf8')).toBe('export const n = 1\nexport const m = 2')
    expect(history.snaps.length).toBe(1)
  })

  test('create_file uses the raw diff when there are no + lines', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    const out = await applyPatchTool.execute(
      { operations: [{ type: 'create_file', path: 'plain.txt', diff: 'hello\nworld\n' }] },
      ctx,
    )
    expect(out.toLowerCase()).not.toMatch(/fail/)
    expect(readFileSync(join(root, 'plain.txt'), 'utf8')).toBe('hello\nworld\n')
  })

  test('create_file fails when the path already exists', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.txt'), 'old\n')
    const out = await applyPatchTool.execute(
      { operations: [{ type: 'create_file', path: 'a.txt', diff: '+new\n' }] },
      makeCtx(root),
    )
    expect(out.startsWith('ApplyPatch failed:')).toBe(true)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('old\n')
  })

  test('update_file refuses when the file changed since last Read', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'note.txt'), 'hello world\nkeep\n')
    const ctx = makeCtx(root)
    await readTool.execute({ path: 'note.txt' }, ctx)
    writeFileSync(join(root, 'note.txt'), 'mutated\nkeep\n')
    utimesSync(join(root, 'note.txt'), Date.now() / 1000 + 5, Date.now() / 1000 + 5)
    const out = await applyPatchTool.execute(
      {
        operations: [
          {
            type: 'update_file',
            path: 'note.txt',
            diff: ['@@ -1,2 +1,2 @@', '-hello world', '+hello raven', ' keep', ''].join('\n'),
          },
        ],
      },
      ctx,
    )
    expect(out).toMatch(/file changed since last Read/)
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('mutated\nkeep\n')
  })

  test('second update_file after a successful update is not treated as stale', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'note.txt'), 'hello world\nkeep\n')
    const ctx = makeCtx(root)
    await readTool.execute({ path: 'note.txt' }, ctx)
    const first = await applyPatchTool.execute(
      {
        operations: [
          {
            type: 'update_file',
            path: 'note.txt',
            diff: ['@@ -1,2 +1,2 @@', '-hello world', '+hello raven', ' keep', ''].join('\n'),
          },
        ],
      },
      ctx,
    )
    expect(first).toBe('updated note.txt')
    const second = await applyPatchTool.execute(
      {
        operations: [
          {
            type: 'update_file',
            path: 'note.txt',
            diff: ['@@ -1,2 +1,2 @@', '-hello raven', '+hello claw', ' keep', ''].join('\n'),
          },
        ],
      },
      ctx,
    )
    expect(second).toBe('updated note.txt')
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('hello claw\nkeep\n')
  })

  test('update_file applies a single unified hunk after Read', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'note.txt'), 'hello world\nkeep\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'note.txt'))
    const out = await applyPatchTool.execute(
      {
        operations: [
          {
            type: 'update_file',
            path: 'note.txt',
            diff: ['@@ -1,2 +1,2 @@', '-hello world', '+hello raven', ' keep', ''].join('\n'),
          },
        ],
      },
      ctx,
    )
    expect(out).toBe('updated note.txt')
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('hello raven\nkeep\n')
  })

  test('update_file applies multiple hunks', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'a.txt'))
    const out = await applyPatchTool.execute(
      {
        operations: [
          {
            type: 'update_file',
            path: 'a.txt',
            diff: [
              '@@ -1,2 +1,2 @@',
              '-one',
              '+ONE',
              ' two',
              '@@ -3,2 +3,2 @@',
              ' three',
              '-four',
              '+FOUR',
              '',
            ].join('\n'),
          },
        ],
      },
      ctx,
    )
    expect(out.toLowerCase()).not.toMatch(/fail/)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('ONE\ntwo\nthree\nFOUR\n')
  })

  test('update_file fails clearly when context does not match', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.txt'), 'alpha\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'a.txt'))
    const out = await applyPatchTool.execute(
      {
        operations: [
          {
            type: 'update_file',
            path: 'a.txt',
            diff: '@@ -1,1 +1,1 @@\n-beta\n+gamma\n',
          },
        ],
      },
      ctx,
    )
    expect(out.startsWith('ApplyPatch failed:')).toBe(true)
    expect(out.toLowerCase()).toMatch(/context|match/)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
  })

  test('update_file and delete_file require a prior Read', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.txt'), 'x\n')
    const update = await applyPatchTool.execute(
      { operations: [{ type: 'update_file', path: 'a.txt', diff: '@@ -1 +1 @@\n-x\n+y\n' }] },
      makeCtx(root),
    )
    expect(update.startsWith('ApplyPatch failed:')).toBe(true)
    expect(update.toLowerCase()).toMatch(/read/)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('x\n')

    const del = await applyPatchTool.execute(
      { operations: [{ type: 'delete_file', path: 'a.txt' }] },
      makeCtx(root),
    )
    expect(del.startsWith('ApplyPatch failed:')).toBe(true)
    expect(del.toLowerCase()).toMatch(/read/)
    expect(existsSync(join(root, 'a.txt'))).toBe(true)
  })

  test('delete_file unlinks after Read and snapshots first', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'gone.txt'), 'bye\n')
    const history = mockHistory()
    const ctx = makeCtx(root, undefined, history)
    ctx.turn.readFiles.add(resolvedOf(root, 'gone.txt'))
    const out = await applyPatchTool.execute(
      { operations: [{ type: 'delete_file', path: 'gone.txt' }] },
      ctx,
    )
    expect(out).toBe('deleted gone.txt')
    expect(existsSync(join(root, 'gone.txt'))).toBe(false)
    expect(history.snaps.length).toBe(1)
  })

  test('returns a per-file action list for mixed operations', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'old.txt'), 'old\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'old.txt'))
    const out = await applyPatchTool.execute(
      {
        operations: [
          { type: 'create_file', path: 'new.txt', diff: '+hi\n' },
          { type: 'delete_file', path: 'old.txt' },
        ],
      },
      ctx,
    )
    expect(out).toBe('created new.txt\ndeleted old.txt')
  })

  test('hard-denies writes to $RAVENCLAW_HOME/state.db', async () => {
    const root = fixtureRoot()
    savedHome = process.env[HOME_ENV]
    process.env[HOME_ENV] = root
    const db = join(root, 'state.db')
    writeFileSync(db, 'sessions\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'state.db'))
    const out = await applyPatchTool.execute(
      { operations: [{ type: 'update_file', path: db, diff: '@@ -1 +1 @@\n-sessions\n+hacked\n' }] },
      ctx,
    )
    expect(out.startsWith('ApplyPatch failed:')).toBe(true)
    expect(out.toLowerCase()).toMatch(/deny|denied|protected/)
    expect(readFileSync(db, 'utf8')).toBe('sessions\n')
  })

  test('execute refuses when the signal is already aborted', async () => {
    const root = fixtureRoot()
    const ac = new AbortController()
    ac.abort()
    await expect(
      applyPatchTool.execute(
        { operations: [{ type: 'create_file', path: 'a.txt', diff: '+x\n' }] },
        makeCtx(root, ac.signal),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
  })

  test('refuses a path outside cwd', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    ctx.turn.terminalBackend = 'docker'
    const out = await applyPatchTool.execute(
      { operations: [{ type: 'create_file', path: '/tmp/raven-outside.txt', diff: '+x\n' }] },
      ctx,
    )
    expect(String(out).toLowerCase()).toMatch(/outside workspace|denied|protected/)
    expect(existsSync('/tmp/raven-outside.txt')).toBe(false)
  })
})

describe('applyUnifiedDiff / contentFromCreateDiff', () => {
  test('contentFromCreateDiff strips one leading + and falls back to raw', () => {
    expect(contentFromCreateDiff('+a\n+b\n')).toBe('a\nb')
    expect(contentFromCreateDiff('plain\ntext\n')).toBe('plain\ntext\n')
  })

  test('applyUnifiedDiff inserts with a zero-old-count hunk', () => {
    const atStart = applyUnifiedDiff('keep\n', '@@ -0,0 +1,1 @@\n+top\n')
    expect(atStart.ok).toBe(true)
    if (atStart.ok) expect(atStart.text).toBe('top\nkeep\n')

    const afterFirst = applyUnifiedDiff('keep\n', '@@ -1,0 +2,1 @@\n+tail\n')
    expect(afterFirst.ok).toBe(true)
    if (afterFirst.ok) expect(afterFirst.text).toBe('keep\ntail\n')
  })
})
