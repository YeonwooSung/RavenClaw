import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const scriptPath = join(import.meta.dir, '../../..', 'scripts/ci-unit.sh')

describe('ci-unit.sh', () => {
  const text = readFileSync(scriptPath, 'utf8')
  const lines = text.split('\n')

  test('is a fail-closed targeted suite, not bare bun test', () => {
    expect(lines[0]).toBe('#!/usr/bin/env bash')
    expect(text).toMatch(/Docker hang/)
    expect(text).toContain('set -euo pipefail')
    expect(text).toContain('cd "$(dirname "$0")/.."')
    expect(lines.some((line) => /^\s*bun test\s*$/.test(line))).toBe(false)
  })

  test('runs every workspace package after core then cli', () => {
    const commands = lines.filter((line) => line.startsWith('bun test packages/'))
    expect(commands).toEqual([
      'bun test packages/core',
      'bun test packages/cli',
      'bun test packages/providers',
      'bun test packages/ads',
      'bun test packages/sdk',
      'bun test packages/acp',
      'bun test packages/tui-opentui',
    ])
  })

  test('no-key CLI asserts doctor exits 1 instead of swallowing it', () => {
    const yml = readFileSync(
      join(import.meta.dir, '../../..', '.github/workflows/ci.yml'),
      'utf8',
    )
    expect(yml).not.toMatch(/doctor \|\| true/)
    expect(yml).toContain('bun packages/cli/src/index.ts doctor')
    expect(yml).toContain('test "$code" -eq 1')
  })

  test('CONTRIBUTING names ci-unit.sh for every workspace package', () => {
    const contributing = readFileSync(
      join(import.meta.dir, '../../..', 'CONTRIBUTING.md'),
      'utf8',
    )
    expect(contributing).toContain('scripts/ci-unit.sh')
    expect(contributing).toContain('packages/providers')
    expect(contributing).toContain('packages/ads')
    expect(contributing).toContain('packages/sdk')
    expect(contributing).toContain('packages/acp')
    expect(contributing).toContain('packages/tui-opentui')
  })
})
