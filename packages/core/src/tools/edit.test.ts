import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { decidePermission } from '../permissions/pipeline'
import { editTool } from './edit'

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
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-edit-'))
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

function makeCtx(cwd: string, signal?: AbortSignal): ToolContext {
  const turn = makeTurn(cwd)
  return {
    turn,
    signal: signal ?? turn.abort.signal,
    onProgress() {},
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

describe('Edit', () => {
  test('is an unsafe mutating tool that leftover-asks and blocks interrupt', async () => {
    expect(editTool.name).toBe('Edit')
    expect(editTool.isConcurrencySafe({ path: 'a.txt', old_string: 'a', new_string: 'b' })).toBe(
      false,
    )
    expect(editTool.isReadOnly({ path: 'a.txt', old_string: 'a', new_string: 'b' })).toBe(false)
    expect(editTool.interruptBehavior?.()).toBe('block')
    const decision = await editTool.checkPermissions(
      { path: 'a.txt', old_string: 'a', new_string: 'b' },
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
      name: 'Edit',
      input: { path: 'a.txt', old_string: 'a', new_string: 'b' },
      tool: editTool,
      ctx: makeCtx('/tmp'),
      mode: 'default',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message.length).toBeGreaterThan(0)
      expect(decision.saveAs).toBe('session')
    }
  })

  test('dontAsk allows in-tree leftover Edit', async () => {
    const decision = await decidePermission({
      name: 'Edit',
      input: { path: 'a.txt', old_string: 'a', new_string: 'b' },
      tool: editTool,
      ctx: makeCtx('/tmp'),
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('allow')
  })

  test('fails without a prior Read and does not write', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'note.txt'), 'alpha\n')
    const ctx = makeCtx(root)

    const out = await editTool.execute(
      { path: 'note.txt', old_string: 'alpha', new_string: 'beta' },
      ctx,
    )
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).toMatch(/read/)
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('alpha\n')
  })

  test('succeeds after readFiles.add(resolved) with a unique replace', async () => {
    const root = fixtureRoot()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'note.txt'), 'hello world\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'src/note.txt'))

    const out = await editTool.execute(
      { path: 'src/note.txt', old_string: 'hello world', new_string: 'hello raven' },
      ctx,
    )
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(readFileSync(join(root, 'src', 'note.txt'), 'utf8')).toBe('hello raven\n')
  })

  test('returns an error when old_string has 0 matches', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.txt'), 'one two\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'a.txt'))

    const out = await editTool.execute(
      { path: 'a.txt', old_string: 'missing', new_string: 'x' },
      ctx,
    )
    expect(out.toLowerCase()).toMatch(/not found|0 match|no match/)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one two\n')
  })

  test('returns an error asking for more context when old_string matches twice', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.txt'), 'foo bar foo\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'a.txt'))

    const out = await editTool.execute(
      { path: 'a.txt', old_string: 'foo', new_string: 'baz' },
      ctx,
    )
    expect(out.toLowerCase()).toMatch(/context|unique|2|twice|multiple/)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('foo bar foo\n')
  })

  test('hard-denies writes to $RAVENCLAW_HOME/state.db', async () => {
    const root = fixtureRoot()
    savedHome = process.env[HOME_ENV]
    process.env[HOME_ENV] = root
    const db = join(root, 'state.db')
    writeFileSync(db, 'sessions\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'state.db'))

    const out = await editTool.execute(
      { path: db, old_string: 'sessions', new_string: 'hacked' },
      ctx,
    )
    expect(out.toLowerCase()).toMatch(/deny|denied|protected|refused|not allowed/)
    expect(readFileSync(db, 'utf8')).toBe('sessions\n')
  })

  test('matches LF old_string in a CRLF file and writes CRLF back', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'note.txt'), 'hello world\r\nnext line\r\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'note.txt'))

    const out = await editTool.execute(
      { path: 'note.txt', old_string: 'hello world\nnext line', new_string: 'hello raven\nnext line' },
      ctx,
    )
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('hello raven\r\nnext line\r\n')
  })

  test('matches curly quotes after exact and indent-flex miss', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'note.txt'), 'say \u201Chello\u201D now\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'note.txt'))

    const out = await editTool.execute(
      { path: 'note.txt', old_string: 'say "hello" now', new_string: 'say "hi" now' },
      ctx,
    )
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('say "hi" now\n')
  })

  test('matches unicode dash, ellipsis, and NBSP on a unique region', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'note.txt'), 'wait\u00A0now\u2014see\u2026end\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'note.txt'))

    const out = await editTool.execute(
      { path: 'note.txt', old_string: 'wait now-see...end', new_string: 'done' },
      ctx,
    )
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('done\n')
  })

  test('matches unique region when the file has trailing spaces', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'note.txt'), 'alpha  \nbeta\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'note.txt'))

    const out = await editTool.execute(
      { path: 'note.txt', old_string: 'alpha\nbeta', new_string: 'gamma\ndelta' },
      ctx,
    )
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('gamma\ndelta\n')
  })

  test('applies the same fold to new_string', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'note.txt'), 'say \u201Chello\u201D\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'note.txt'))

    const out = await editTool.execute(
      { path: 'note.txt', old_string: 'say "hello"', new_string: 'say \u201Cgoodbye\u201D' },
      ctx,
    )
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('say "goodbye"\n')
  })

  test('matches an ellipsis after a leading period', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'note.txt'), 'see.\u2026end\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'note.txt'))

    const out = await editTool.execute(
      { path: 'note.txt', old_string: '...', new_string: '---' },
      ctx,
    )
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('see.---end\n')
  })

  test('still fails when fold-equivalent old_string is not unique', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'note.txt'), 'say \u201Chello\u201D and say \u201Chello\u201D\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'note.txt'))

    const out = await editTool.execute(
      { path: 'note.txt', old_string: 'say "hello"', new_string: 'say "hi"' },
      ctx,
    )
    expect(out.toLowerCase()).toMatch(/context|unique|2|twice|multiple/)
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('say \u201Chello\u201D and say \u201Chello\u201D\n')
  })

  test('matches old_string with two extra spaces of indent', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'src.ts'), 'function f() {\n  const x = 1\n  return x\n}\n')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'src.ts'))

    const out = await editTool.execute(
      {
        path: 'src.ts',
        old_string: '    const x = 1\n    return x',
        new_string: '    const x = 2\n    return x',
      },
      ctx,
    )
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(readFileSync(join(root, 'src.ts'), 'utf8')).toBe('function f() {\n  const x = 2\n  return x\n}\n')
  })

  test('execute refuses when the signal is already aborted', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.txt'), 'ok\n')
    const ac = new AbortController()
    ac.abort()
    const ctx = makeCtx(root, ac.signal)
    ctx.turn.readFiles.add(resolvedOf(root, 'a.txt'))
    await expect(
      editTool.execute({ path: 'a.txt', old_string: 'ok', new_string: 'no' }, ctx),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('ok\n')
  })
})
