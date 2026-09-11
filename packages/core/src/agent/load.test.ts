import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAgentDefinition } from './catalog'
import { loadDiskAgents } from './load'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('loadDiskAgents', () => {
  test('loads project .ravenclaw/agents/*.md and project wins over user', () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-agents-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-agents-cwd-'))
    tempDirs.push(home, cwd)
    mkdirSync(join(home, 'agents'), { recursive: true })
    mkdirSync(join(cwd, '.ravenclaw', 'agents'), { recursive: true })
    writeFileSync(
      join(home, 'agents', 'reviewer.md'),
      '---\nname: reviewer\nallowed-tools: Read\n---\nUser body\n',
    )
    writeFileSync(
      join(cwd, '.ravenclaw', 'agents', 'reviewer.md'),
      '---\nname: reviewer\nallowed-tools: Read, Grep\n---\nProject body\n',
    )
    const loaded = loadDiskAgents(cwd, home)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.id).toBe('reviewer')
    expect(loaded[0]?.toolNames).toEqual(['Read', 'Grep'])
    expect(loaded[0]?.systemPrompt).toContain('Project body')
    expect(getAgentDefinition('reviewer', cwd)?.id).toBe('reviewer')
    expect(getAgentDefinition('general', cwd)?.id).toBe('general')
  })
})
