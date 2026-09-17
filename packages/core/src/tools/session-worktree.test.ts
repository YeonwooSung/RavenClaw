import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../session/memory-store'
import type { SessionRecord } from '../types'
import {
  enterSessionWorktree,
  exitSessionWorktree,
  getSessionWorktree,
} from './session-worktree'

const tempDirs: string[] = []
const sessionIds: string[] = []
let seq = 0

afterEach(() => {
  while (sessionIds.length > 0) {
    const id = sessionIds.pop()
    if (id) exitSessionWorktree(id, 'remove', true)
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function nextSession(): string {
  const id = `sess_wt_${Date.now()}_${seq++}`
  sessionIds.push(id)
  return id
}

function initGitRepo(dir: string): void {
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    expect(result.status).toBe(0)
  }
  run(['init'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'commit.gpgsign', 'false'])
  run(['commit', '--allow-empty', '-m', 'init'])
}

function sessionRecord(id: string, cwd: string): SessionRecord {
  return {
    id,
    createdAt: 1,
    updatedAt: 1,
    cwd,
    model: 'dummy',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
  }
}

describe('session worktree map', () => {
  test('enter creates a named worktree under .ravenclaw/worktrees', () => {
    const cwd = tempDir('ravenclaw-swt-enter-')
    initGitRepo(cwd)
    const sessionId = nextSession()
    const result = enterSessionWorktree(sessionId, cwd, 'iso')
    expect(result.ok).toBe(true)
    expect(result.cwd).toBe(join(cwd, '.ravenclaw', 'worktrees', 'iso'))
    expect(existsSync(join(result.cwd, '.git'))).toBe(true)
    const mapped = getSessionWorktree(sessionId)
    expect(mapped?.originalCwd).toBe(cwd)
    expect(mapped?.worktreePath).toBe(result.cwd)
    expect(mapped?.name).toBe('iso')
    const branch = spawnSync('git', ['-C', result.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    })
    expect(branch.stdout.trim()).not.toBe('HEAD')
    expect(branch.stdout.trim()).toBe(result.job?.shadowBranch)
  })

  test('enter creates a named raven/* branch and records baseSha', () => {
    const cwd = tempDir('ravenclaw-swt-job-')
    initGitRepo(cwd)
    const sessionId = nextSession()
    const result = enterSessionWorktree(sessionId, cwd)
    expect(result.ok).toBe(true)
    expect(result.job?.shadowBranch.startsWith('raven/')).toBe(true)
    const branch = spawnSync('git', ['-C', result.cwd, 'branch', '--show-current'], {
      encoding: 'utf8',
    })
    expect(branch.stdout.trim()).toBe(result.job?.shadowBranch)
    const head = spawnSync('git', ['-C', result.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    expect(head.stdout.trim()).toBe(result.job?.baseCommitSha)
  })

  test('EnterWorktree then loadSession still knows base/shadow/baseSha', async () => {
    const store = createMemoryStore()
    const cwd = tempDir('ravenclaw-swt-persist-')
    initGitRepo(cwd)
    const session = sessionRecord(nextSession(), cwd)
    await store.createSession(session)
    const result = enterSessionWorktree(session.id, cwd)
    expect(result.ok).toBe(true)
    session.job = result.job
    await store.upsertSession(session)
    const loaded = await store.loadSession(session.id)
    expect(loaded.session.job?.baseBranch).toBe(result.job?.baseBranch)
    expect(loaded.session.job?.shadowBranch).toBe(result.job?.shadowBranch)
    expect(loaded.session.job?.baseCommitSha).toBe(result.job?.baseCommitSha)
    expect(loaded.session.job?.worktreePath).toBe(result.cwd)
  })

  test('uses a short session id when name is omitted', () => {
    const cwd = tempDir('ravenclaw-swt-short-')
    initGitRepo(cwd)
    const sessionId = nextSession()
    const result = enterSessionWorktree(sessionId, cwd)
    expect(result.ok).toBe(true)
    const mapped = getSessionWorktree(sessionId)
    expect(mapped?.name.length).toBeGreaterThan(0)
    expect(mapped?.name.length).toBeLessThanOrEqual(8)
    expect(result.cwd).toBe(join(cwd, '.ravenclaw', 'worktrees', mapped?.name ?? ''))
  })

  test('refuses a second enter for the same session', () => {
    const cwd = tempDir('ravenclaw-swt-dup-')
    initGitRepo(cwd)
    const sessionId = nextSession()
    expect(enterSessionWorktree(sessionId, cwd, 'a').ok).toBe(true)
    const again = enterSessionWorktree(sessionId, cwd, 'b')
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/already/)
  })

  test('fails when parent is not a git repo', () => {
    const cwd = tempDir('ravenclaw-swt-nongit-')
    const sessionId = nextSession()
    const result = enterSessionWorktree(sessionId, cwd, 'iso')
    expect(result.ok).toBe(false)
    expect(result.cwd).toBe(cwd)
    expect(getSessionWorktree(sessionId)).toBeUndefined()
  })

  test('keep restores original cwd and leaves the worktree', () => {
    const cwd = tempDir('ravenclaw-swt-keep-')
    initGitRepo(cwd)
    const sessionId = nextSession()
    const entered = enterSessionWorktree(sessionId, cwd, 'kept')
    expect(entered.ok).toBe(true)
    const exited = exitSessionWorktree(sessionId, 'keep')
    expect(exited.ok).toBe(true)
    expect(exited.cwd).toBe(cwd)
    expect(getSessionWorktree(sessionId)).toBeUndefined()
    expect(existsSync(entered.cwd)).toBe(true)
  })

  test('remove deletes a clean worktree', () => {
    const cwd = tempDir('ravenclaw-swt-rm-')
    initGitRepo(cwd)
    const sessionId = nextSession()
    const entered = enterSessionWorktree(sessionId, cwd, 'gone')
    expect(entered.ok).toBe(true)
    const exited = exitSessionWorktree(sessionId, 'remove')
    expect(exited.ok).toBe(true)
    expect(exited.cwd).toBe(cwd)
    expect(existsSync(entered.cwd)).toBe(false)
    expect(getSessionWorktree(sessionId)).toBeUndefined()
  })

  test('remove of a dirty worktree fails without discard', () => {
    const cwd = tempDir('ravenclaw-swt-dirty-')
    initGitRepo(cwd)
    const sessionId = nextSession()
    const entered = enterSessionWorktree(sessionId, cwd, 'dirty')
    expect(entered.ok).toBe(true)
    writeFileSync(join(entered.cwd, 'scratch.txt'), 'x\n')
    const blocked = exitSessionWorktree(sessionId, 'remove')
    expect(blocked.ok).toBe(false)
    expect(blocked.error?.toLowerCase()).toMatch(/discard|uncommitted|dirty/)
    expect(getSessionWorktree(sessionId)?.worktreePath).toBe(entered.cwd)
    expect(existsSync(entered.cwd)).toBe(true)

    const forced = exitSessionWorktree(sessionId, 'remove', true)
    expect(forced.ok).toBe(true)
    expect(existsSync(entered.cwd)).toBe(false)
  })
})
