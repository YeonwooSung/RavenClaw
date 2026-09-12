import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSkillUsage, recordSkillUse, setSkillUsageState, skillUsagePath } from './usage'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raven-skill-usage-'))
  tempDirs.push(dir)
  return dir
}

describe('skill usage sidecar', () => {
  test('recordSkillUse writes lastUsedAt and increments useCount', () => {
    const home = tempHome()
    const t1 = Date.parse('2026-01-01T00:00:00.000Z')
    const first = recordSkillUse('demo', home, t1)
    expect(first).toEqual({
      lastUsedAt: '2026-01-01T00:00:00.000Z',
      useCount: 1,
      state: 'active',
    })
    const t2 = Date.parse('2026-01-02T00:00:00.000Z')
    const second = recordSkillUse('demo', home, t2)
    expect(second).toEqual({
      lastUsedAt: '2026-01-02T00:00:00.000Z',
      useCount: 2,
      state: 'active',
    })
    expect(loadSkillUsage(home).demo).toEqual(second)
    expect(skillUsagePath(home)).toBe(join(home, 'skills', '.usage.json'))
  })

  test('setSkillUsageState marks stale without dropping the count', () => {
    const home = tempHome()
    recordSkillUse('demo', home, Date.parse('2026-01-01T00:00:00.000Z'))
    expect(setSkillUsageState('demo', 'stale', home)).toMatchObject({
      useCount: 1,
      state: 'stale',
    })
    expect(recordSkillUse('demo', home, Date.parse('2026-01-03T00:00:00.000Z'))).toMatchObject({
      useCount: 2,
      state: 'active',
    })
  })

  test('missing or corrupt sidecar is an empty map', () => {
    const home = tempHome()
    expect(loadSkillUsage(home)).toEqual({})
    mkdirSync(join(home, 'skills'), { recursive: true })
    writeFileSync(skillUsagePath(home), '{not json', 'utf8')
    expect(loadSkillUsage(home)).toEqual({})
  })
})
