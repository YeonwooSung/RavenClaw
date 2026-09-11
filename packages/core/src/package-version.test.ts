import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPackageVersion } from './package-version'

describe('readPackageVersion', () => {
  test('from this file resolves @ravenclaw/core version', () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
    ) as { version: string }
    expect(readPackageVersion(import.meta.url)).toBe(pkg.version)
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
