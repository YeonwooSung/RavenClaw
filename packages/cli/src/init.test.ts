import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS_STARTER, initProject } from './init'

describe('initProject', () => {
  test('writes AGENTS.md when missing', () => {
    const cwd = join(tmpdir(), `raven-init-${Date.now()}`)
    mkdirSync(cwd, { recursive: true })
    const result = initProject(cwd)
    expect(result.created).toBe(true)
    expect(readFileSync(result.path, 'utf8')).toBe(AGENTS_STARTER)
    expect(AGENTS_STARTER).toContain('RavenClaw')
    expect(AGENTS_STARTER).not.toContain('Claude')
  })

  test('does not overwrite an existing AGENTS.md', () => {
    const cwd = join(tmpdir(), `raven-init-exists-${Date.now()}`)
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'AGENTS.md'), 'keep me\n')
    const result = initProject(cwd)
    expect(result.created).toBe(false)
    expect(readFileSync(result.path, 'utf8')).toBe('keep me\n')
  })
})
