import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) out.push(path)
  }
  return out
}

describe('@ravenclaw/durable package', () => {
  test('locks the name, version, and clean-room notice', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      name: string
      version: string
      private: boolean
    }
    expect(pkg.name).toBe('@ravenclaw/durable')
    expect(pkg.version).toBe('0.1.33')
    expect(pkg.private).toBe(true)
    const notice = readFileSync(join(root, 'NOTICE'), 'utf8')
    expect(notice).toContain('earendil-works/pi')
    expect(notice).toContain('clean-room')
  })

  test('does not import the session engine or providers', () => {
    for (const file of sourceFiles(join(root, 'src'))) {
      const text = readFileSync(file, 'utf8')
      expect(text.includes('@ravenclaw/core'), file).toBe(false)
      expect(text.includes('@ravenclaw/providers'), file).toBe(false)
    }
  })
})
