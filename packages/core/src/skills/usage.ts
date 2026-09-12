import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ravenclawHome } from '../home'

export type SkillUsageState = 'active' | 'stale' | 'archived'

export interface SkillUsageRecord {
  lastUsedAt?: string
  useCount: number
  state?: SkillUsageState
}

export type SkillUsageMap = Record<string, SkillUsageRecord>

const USAGE_FILE = '.usage.json'
const STATES = new Set<SkillUsageState>(['active', 'stale', 'archived'])

export function skillUsagePath(home = ravenclawHome()): string {
  return join(home, 'skills', USAGE_FILE)
}

export function loadSkillUsage(home = ravenclawHome()): SkillUsageMap {
  try {
    const parsed = JSON.parse(readFileSync(skillUsagePath(home), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: SkillUsageMap = {}
    for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (name === '' || name.startsWith('_')) continue
      const rec = parseRecord(raw)
      if (rec !== undefined) out[name] = rec
    }
    return out
  } catch {
    return {}
  }
}

export function recordSkillUse(
  name: string,
  home = ravenclawHome(),
  now = Date.now(),
): SkillUsageRecord | undefined {
  const trimmed = name.trim()
  if (trimmed === '') return undefined
  const usage = loadSkillUsage(home)
  const prev = usage[trimmed]
  const next: SkillUsageRecord = {
    lastUsedAt: new Date(now).toISOString(),
    useCount: (prev?.useCount ?? 0) + 1,
    state: 'active',
  }
  usage[trimmed] = next
  saveSkillUsage(usage, home)
  return next
}

export function setSkillUsageState(
  name: string,
  state: SkillUsageState,
  home = ravenclawHome(),
): SkillUsageRecord | undefined {
  const trimmed = name.trim()
  if (trimmed === '') return undefined
  const usage = loadSkillUsage(home)
  const prev = usage[trimmed] ?? { useCount: 0 }
  const next: SkillUsageRecord = { ...prev, state }
  usage[trimmed] = next
  saveSkillUsage(usage, home)
  return next
}

export function saveSkillUsage(usage: SkillUsageMap, home = ravenclawHome()): void {
  try {
    mkdirSync(join(home, 'skills'), { recursive: true })
    writeFileSync(skillUsagePath(home), `${JSON.stringify(usage, null, 2)}\n`, 'utf8')
  } catch {
    // sidecar is best-effort
  }
}

function parseRecord(raw: unknown): SkillUsageRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const useCount =
    typeof rec.useCount === 'number' && Number.isFinite(rec.useCount) && rec.useCount >= 0
      ? Math.floor(rec.useCount)
      : 0
  const lastUsedAt = typeof rec.lastUsedAt === 'string' && rec.lastUsedAt !== '' ? rec.lastUsedAt : undefined
  const state =
    typeof rec.state === 'string' && STATES.has(rec.state as SkillUsageState)
      ? (rec.state as SkillUsageState)
      : undefined
  const out: SkillUsageRecord = { useCount }
  if (lastUsedAt !== undefined) out.lastUsedAt = lastUsedAt
  if (state !== undefined) out.state = state
  return out
}
