import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  includedCapReached,
  readIncludedUsage,
  recordIncludedSession,
  tryRecordIncludedSession,
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

  test('tryRecordIncludedSession admits the last slot then denies', () => {
    const home = tempHome()
    expect(tryRecordIncludedSession(home, 1)).toBe(true)
    expect(tryRecordIncludedSession(home, 1)).toBe(false)
    expect(readIncludedUsage(home).count).toBe(1)
  })

  test('in-process Promise.all tryRecordIncludedSession respects cap 2', async () => {
    const home = tempHome()
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => tryRecordIncludedSession(home, 2)),
    )
    expect(results.filter((ok) => ok).length).toBeLessThanOrEqual(2)
    expect(readIncludedUsage(home).count).toBeLessThanOrEqual(2)
  })

  test('concurrent tryRecordIncludedSession at cap 2 never overshoots', async () => {
    const home = tempHome()
    const modulePath = new URL('./included-usage.ts', import.meta.url).href
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const proc = Bun.spawn(
          [
            process.execPath,
            '-e',
            `import { tryRecordIncludedSession } from ${JSON.stringify(modulePath)}
const ok = tryRecordIncludedSession(${JSON.stringify(home)}, 2)
process.stdout.write(ok ? '1' : '0')`,
          ],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        if (code !== 0) throw new Error(stderr || `child exited ${code}`)
        return stdout === '1'
      }),
    )
    expect(results.filter((ok) => ok).length).toBeLessThanOrEqual(2)
    expect(readIncludedUsage(home).count).toBeLessThanOrEqual(2)
    expect(readIncludedUsage(home).count).toBe(results.filter((ok) => ok).length)
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
