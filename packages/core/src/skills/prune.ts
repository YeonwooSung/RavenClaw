import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { ravenclawHome } from '../home'
import type { DiscoveredSkill } from '../tools/skill'
import { discoverSkills } from '../tools/skill'
import { loadSkillUsage, saveSkillUsage, type SkillUsageMap, type SkillUsageRecord } from './usage'

export const SKILL_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
export const SKILL_ARCHIVE_AFTER_MS = 90 * 24 * 60 * 60 * 1000
export const SKILL_PRUNE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
export const SKILL_PRUNE_IDLE_MS = 2 * 60 * 60 * 1000

export const SKILL_ARCHIVE_DIR = '.archive'

export interface SkillPruneResult {
  checked: number
  stale: string[]
  archived: string[]
  skipped: string[]
  reactivated: string[]
}

export interface SkillPruneState {
  lastPrunedAt?: string
}

export type IdlePruneResult =
  | { ran: true; result: SkillPruneResult }
  | { ran: false; reason: 'seeded' | 'interval' | 'active' }

export function skillPruneStatePath(home = ravenclawHome()): string {
  return join(home, 'skills', '.prune.json')
}

export function isSkillPruneProtected(skill: Pick<DiscoveredSkill, 'source' | 'createdBy'>): boolean {
  if (skill.source === 'builtin') return true
  return skill.createdBy !== undefined && skill.createdBy !== 'agent'
}

export function pruneSkills(opts: {
  cwd: string
  home?: string
  now?: number
}): SkillPruneResult {
  const home = opts.home ?? ravenclawHome()
  const now = opts.now ?? Date.now()
  const skills = discoverSkills(opts.cwd, home)
  const usage = loadSkillUsage(home)
  const result: SkillPruneResult = {
    checked: 0,
    stale: [],
    archived: [],
    skipped: [],
    reactivated: [],
  }

  for (const skill of skills) {
    result.checked += 1
    if (isSkillPruneProtected(skill)) {
      result.skipped.push(skill.name)
      continue
    }
    const rec = usage[skill.name]
    const activity = activityMs(skill, rec, now)
    if (now - activity < SKILL_STALE_AFTER_MS) {
      if (rec?.state === 'stale') {
        writeRecord(usage, skill.name, rec, 'active')
        result.reactivated.push(skill.name)
      }
      continue
    }
    if (now - activity >= SKILL_ARCHIVE_AFTER_MS) {
      const dest = archiveSkillDir(skill.dir, skill.name, now)
      if (dest !== undefined) {
        writeRecord(usage, skill.name, rec, 'archived')
        result.archived.push(skill.name)
      }
      continue
    }
    if (rec?.state !== 'stale') {
      writeRecord(usage, skill.name, rec, 'stale')
      result.stale.push(skill.name)
    }
  }

  saveSkillUsage(usage, home)
  savePruneState(home, { lastPrunedAt: new Date(now).toISOString() })
  return result
}

export function maybePruneSkillsOnIdle(opts: {
  cwd: string
  home?: string
  now?: number
  lastActivityAt?: number
}): IdlePruneResult {
  const home = opts.home ?? ravenclawHome()
  const now = opts.now ?? Date.now()
  const state = loadPruneState(home)
  if (state.lastPrunedAt === undefined) {
    savePruneState(home, { lastPrunedAt: new Date(now).toISOString() })
    return { ran: false, reason: 'seeded' }
  }
  const last = Date.parse(state.lastPrunedAt)
  if (Number.isFinite(last) && now - last < SKILL_PRUNE_INTERVAL_MS) {
    return { ran: false, reason: 'interval' }
  }
  const lastActivity = opts.lastActivityAt ?? now
  if (now - lastActivity < SKILL_PRUNE_IDLE_MS) {
    return { ran: false, reason: 'active' }
  }
  return { ran: true, result: pruneSkills({ cwd: opts.cwd, home, now }) }
}

export function loadPruneState(home = ravenclawHome()): SkillPruneState {
  try {
    const parsed = JSON.parse(readFileSync(skillPruneStatePath(home), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const lastPrunedAt = (parsed as { lastPrunedAt?: unknown }).lastPrunedAt
    return typeof lastPrunedAt === 'string' && lastPrunedAt !== '' ? { lastPrunedAt } : {}
  } catch {
    return {}
  }
}

export function savePruneState(home: string, state: SkillPruneState): void {
  try {
    mkdirSync(join(home, 'skills'), { recursive: true })
    writeFileSync(skillPruneStatePath(home), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // prune clock is best-effort
  }
}

function writeRecord(
  usage: SkillUsageMap,
  name: string,
  prev: SkillUsageRecord | undefined,
  state: NonNullable<SkillUsageRecord['state']>,
): void {
  usage[name] = { ...(prev ?? { useCount: 0 }), state }
}

function activityMs(skill: DiscoveredSkill, rec: SkillUsageRecord | undefined, now: number): number {
  if (rec?.lastUsedAt !== undefined) {
    const t = Date.parse(rec.lastUsedAt)
    if (Number.isFinite(t)) return t
  }
  try {
    return statSync(join(skill.dir, 'SKILL.md')).mtimeMs
  } catch {
    return now
  }
}

function archiveSkillDir(dir: string, name: string, now: number): string | undefined {
  const root = dirname(dir)
  const archiveRoot = join(root, SKILL_ARCHIVE_DIR)
  const safeName = name.replace(/[/\\]/g, '_')
  if (safeName === '' || safeName === '.' || safeName === '..') return undefined
  try {
    mkdirSync(archiveRoot, { recursive: true })
  } catch {
    return undefined
  }
  let dest = join(archiveRoot, safeName)
  if (existsSync(dest)) dest = join(archiveRoot, `${safeName}-${new Date(now).toISOString().replace(/[:.]/g, '-')}`)
  if (!dest.startsWith(archiveRoot + sep) && dest !== archiveRoot) return undefined
  try {
    renameSync(dir, dest)
    return dest
  } catch {
    return undefined
  }
}
