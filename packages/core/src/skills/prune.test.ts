import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkills } from '../tools/skill'
import {
  SKILL_ARCHIVE_AFTER_MS,
  SKILL_ARCHIVE_DIR,
  SKILL_PRUNE_IDLE_MS,
  SKILL_PRUNE_INTERVAL_MS,
  SKILL_STALE_AFTER_MS,
  isSkillPruneProtected,
  maybePruneSkillsOnIdle,
  pruneSkills,
} from './prune'
import { loadSkillUsage, saveSkillUsage } from './usage'

const tempDirs: string[] = []

afterEach(() => {
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

function writeSkill(
  root: string,
  name: string,
  extraFrontmatter: string[] = [],
): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const lines = ['---', `name: ${name}`, 'description: A test skill', ...extraFrontmatter, '---', '', 'body']
  writeFileSync(join(dir, 'SKILL.md'), `${lines.join('\n')}\n`)
  return dir
}

function age(home: string, name: string, agoMs: number, now: number): void {
  const usage = loadSkillUsage(home)
  usage[name] = {
    lastUsedAt: new Date(now - agoMs).toISOString(),
    useCount: 1,
  }
  saveSkillUsage(usage, home)
}

describe('isSkillPruneProtected', () => {
  test('protects builtins and created_by other than agent', () => {
    expect(isSkillPruneProtected({ source: 'builtin' })).toBe(true)
    expect(isSkillPruneProtected({ source: 'user', createdBy: 'user' })).toBe(true)
    expect(isSkillPruneProtected({ source: 'user', createdBy: 'agent' })).toBe(false)
    expect(isSkillPruneProtected({ source: 'project' })).toBe(false)
  })
})

describe('pruneSkills', () => {
  test('marks unused 30d skills stale and keeps them in the index', () => {
    const home = tempDir('raven-prune-home-')
    const cwd = tempDir('raven-prune-cwd-')
    const dir = writeSkill(join(home, 'skills'), 'idle-demo')
    const now = Date.parse('2026-09-13T00:00:00.000Z')
    age(home, 'idle-demo', SKILL_STALE_AFTER_MS + 1, now)

    const result = pruneSkills({ cwd, home, now })
    expect(result.stale).toEqual(['idle-demo'])
    expect(result.archived).toEqual([])
    expect(existsSync(dir)).toBe(true)
    expect(loadSkillUsage(home)['idle-demo']?.state).toBe('stale')
    expect(discoverSkills(cwd, home, { includeBuiltin: false })).toEqual([
      expect.objectContaining({ name: 'idle-demo', stale: true, dir }),
    ])
  })

  test('moves unused 90d skills into .archive and never deletes', () => {
    const home = tempDir('raven-prune-arch-home-')
    const cwd = tempDir('raven-prune-arch-cwd-')
    const dir = writeSkill(join(home, 'skills'), 'old-flow')
    const now = Date.parse('2026-09-13T00:00:00.000Z')
    age(home, 'old-flow', SKILL_ARCHIVE_AFTER_MS + 1, now)

    const result = pruneSkills({ cwd, home, now })
    expect(result.archived).toEqual(['old-flow'])
    expect(existsSync(dir)).toBe(false)
    const archived = join(home, 'skills', SKILL_ARCHIVE_DIR, 'old-flow')
    expect(existsSync(join(archived, 'SKILL.md'))).toBe(true)
    expect(discoverSkills(cwd, home, { includeBuiltin: false })).toEqual([])
    expect(loadSkillUsage(home)['old-flow']?.state).toBe('archived')
  })

  test('never touches builtins or created_by user skills', () => {
    const home = tempDir('raven-prune-skip-home-')
    const cwd = tempDir('raven-prune-skip-cwd-')
    const userDir = writeSkill(join(home, 'skills'), 'keep-user', ['created_by: user'])
    const now = Date.parse('2026-09-13T00:00:00.000Z')
    age(home, 'keep-user', SKILL_ARCHIVE_AFTER_MS + 1, now)
    age(home, 'review', SKILL_ARCHIVE_AFTER_MS + 1, now)

    const result = pruneSkills({ cwd, home, now })
    expect(result.archived).toEqual([])
    expect(result.stale).toEqual([])
    expect(result.skipped).toContain('keep-user')
    expect(result.skipped).toContain('review')
    expect(existsSync(userDir)).toBe(true)
    expect(existsSync(join(userDir, 'SKILL.md'))).toBe(true)
  })

  test('archives an agent-created skill after 90d', () => {
    const home = tempDir('raven-prune-agent-home-')
    const cwd = tempDir('raven-prune-agent-cwd-')
    writeSkill(join(home, 'skills'), 'agent-flow', ['created_by: agent'])
    const now = Date.parse('2026-09-13T00:00:00.000Z')
    age(home, 'agent-flow', SKILL_ARCHIVE_AFTER_MS + 1, now)
    expect(pruneSkills({ cwd, home, now }).archived).toEqual(['agent-flow'])
    expect(existsSync(join(home, 'skills', SKILL_ARCHIVE_DIR, 'agent-flow', 'SKILL.md'))).toBe(true)
  })

  test('recent use reactivates a stale skill', () => {
    const home = tempDir('raven-prune-hot-home-')
    const cwd = tempDir('raven-prune-hot-cwd-')
    writeSkill(join(home, 'skills'), 'hot')
    const now = Date.parse('2026-09-13T00:00:00.000Z')
    saveSkillUsage(
      {
        hot: {
          lastUsedAt: new Date(now - 60_000).toISOString(),
          useCount: 3,
          state: 'stale',
        },
      },
      home,
    )
    const result = pruneSkills({ cwd, home, now })
    expect(result.reactivated).toEqual(['hot'])
    expect(loadSkillUsage(home).hot?.state).toBe('active')
  })
})

describe('maybePruneSkillsOnIdle', () => {
  test('first tick seeds and later ticks honor 7d / 2h gates', () => {
    const home = tempDir('raven-prune-idle-home-')
    const cwd = tempDir('raven-prune-idle-cwd-')
    writeSkill(join(home, 'skills'), 'idle-demo')
    const t0 = Date.parse('2026-01-01T00:00:00.000Z')
    age(home, 'idle-demo', SKILL_STALE_AFTER_MS + 1, t0)

    expect(maybePruneSkillsOnIdle({ cwd, home, now: t0 })).toEqual({ ran: false, reason: 'seeded' })
    expect(maybePruneSkillsOnIdle({ cwd, home, now: t0 + SKILL_PRUNE_INTERVAL_MS - 1 })).toEqual({
      ran: false,
      reason: 'interval',
    })
    expect(
      maybePruneSkillsOnIdle({
        cwd,
        home,
        now: t0 + SKILL_PRUNE_INTERVAL_MS,
        lastActivityAt: t0 + SKILL_PRUNE_INTERVAL_MS - SKILL_PRUNE_IDLE_MS + 1,
      }),
    ).toEqual({ ran: false, reason: 'active' })

    const ran = maybePruneSkillsOnIdle({
      cwd,
      home,
      now: t0 + SKILL_PRUNE_INTERVAL_MS,
      lastActivityAt: t0 + SKILL_PRUNE_INTERVAL_MS - SKILL_PRUNE_IDLE_MS,
    })
    expect(ran.ran).toBe(true)
    if (ran.ran) expect(ran.result.stale).toEqual(['idle-demo'])
  })
})
