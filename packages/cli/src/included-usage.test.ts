import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  includedCapReached,
  recordIncludedSession,
  utcDay,
  type IncludedUsage,
} from './included-usage'

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-usage-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('included usage ledger', () => {
  test('recordIncludedSession increments and includedCapReached uses the count', () => {
    const home = tempHome()
    expect(includedCapReached(home, 2)).toBe(false)
    recordIncludedSession(home)
    expect(includedCapReached(home, 2)).toBe(false)
    recordIncludedSession(home)
    expect(includedCapReached(home, 2)).toBe(true)
    const raw = JSON.parse(readFileSync(join(home, 'included-usage.json'), 'utf8')) as IncludedUsage
    expect(raw.count).toBe(2)
    expect(raw.day).toBe(utcDay())
  })

  test('day rollover resets the count', () => {
    const home = tempHome()
    writeFileSync(join(home, 'included-usage.json'), JSON.stringify({ day: '2000-01-01', count: 99 }))
    expect(includedCapReached(home, 4)).toBe(false)
    recordIncludedSession(home)
    const raw = JSON.parse(readFileSync(join(home, 'included-usage.json'), 'utf8')) as IncludedUsage
    expect(raw.day).toBe(utcDay())
    expect(raw.count).toBe(1)
    expect(includedCapReached(home, 4)).toBe(false)
  })
})
