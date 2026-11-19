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

  test('reads optional model and maxRounds frontmatter; missing or invalid maxRounds stays unset', () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-agents-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-agents-cwd-'))
    tempDirs.push(home, cwd)
    mkdirSync(join(home, 'agents'), { recursive: true })
    writeFileSync(
      join(home, 'agents', 'a.md'),
      '---\nname: a\nmodel: foo-model\nmaxRounds: 3\n---\nBody\n',
    )
    writeFileSync(join(home, 'agents', 'b.md'), '---\nname: b\nmaxRounds: 0\n---\nBody\n')
    writeFileSync(join(home, 'agents', 'c.md'), '---\nname: c\nmaxRounds: nope\n---\nBody\n')
    writeFileSync(join(home, 'agents', 'd.md'), '---\nname: d\n---\nBody\n')
    const byId = new Map(loadDiskAgents(cwd, home).map((d) => [d.id, d]))
    expect(byId.get('a')?.model).toBe('foo-model')
    expect(byId.get('a')?.maxRounds).toBe(3)
    expect(byId.get('b')?.model).toBeUndefined()
    expect(byId.get('b')?.maxRounds).toBeUndefined()
    expect(byId.get('c')?.maxRounds).toBeUndefined()
    expect(byId.get('d')?.maxRounds).toBeUndefined()
    expect(byId.has('d') && 'maxRounds' in byId.get('d')!).toBe(false)
  })

  test('spawnable-agents frontmatter sets edges and implies the Agent tool', () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-agents-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-agents-cwd-'))
    tempDirs.push(home, cwd)
    mkdirSync(join(home, 'agents'), { recursive: true })
    writeFileSync(
      join(home, 'agents', 'lead.md'),
      '---\nname: lead\nallowed-tools: Read, Grep\nspawnable-agents: file-finder, worker\n---\nBody\n',
    )
    writeFileSync(
      join(home, 'agents', 'leaf.md'),
      '---\nname: leaf\nallowed-tools: Read\nspawnable-agents:\n---\nBody\n',
    )
    writeFileSync(join(home, 'agents', 'plain.md'), '---\nname: plain\n---\nBody\n')
    const byId = new Map(loadDiskAgents(cwd, home).map((d) => [d.id, d]))
    expect(byId.get('lead')?.spawnableAgents).toEqual(['file-finder', 'worker'])
    expect(byId.get('lead')?.toolNames).toEqual(['Read', 'Grep', 'Agent'])
    expect(byId.get('leaf')?.spawnableAgents).toEqual([])
    expect(byId.get('leaf')?.toolNames).toEqual(['Read'])
    expect(byId.get('plain')?.spawnableAgents).toEqual([])
    expect(byId.get('plain')?.toolNames).toEqual(['Read', 'Grep', 'Glob'])
  })
})
