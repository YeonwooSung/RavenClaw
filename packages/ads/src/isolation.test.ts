import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

describe('ads isolation', () => {
  test('package.json and source have no @ravenclaw/core, ink, or react dependency', () => {
    const root = join(import.meta.dir, '..')
    const pkg = readFileSync(join(root, 'package.json'), 'utf8')
    expect(pkg).not.toContain('@ravenclaw/core')
    expect(pkg).not.toContain('"ink"')
    expect(pkg).not.toContain('"react"')

    const files = walk(join(root, 'src')).filter(
      (path) => path.endsWith('.ts') && !path.endsWith('.test.ts'),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      expect(text).not.toMatch(/from ['"]@ravenclaw\/core['"]/)
      expect(text).not.toMatch(/from ['"]ink['"]/)
      expect(text).not.toMatch(/from ['"]react['"]/)
    }
  })
})
