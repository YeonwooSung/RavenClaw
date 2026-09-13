import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../session/memory-store'
import type { SessionRecord } from '../types'
import { ONBOARDING_USAGE_DAYS, scanTeamOnboarding } from './scan'

function tempCwd(): string {
  const dir = join(tmpdir(), `raven-onboard-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp',
    model: 'dummy',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
    ...over,
  }
}

describe('scanTeamOnboarding', () => {
  test('does not invent files and never copies MCP secrets', async () => {
    const cwd = tempCwd()
    const home = tempCwd()
    const store = createMemoryStore()
    const scan = await scanTeamOnboarding({
      cwd,
      home,
      store,
      mcp: {
        servers: [
          {
            name: 'github',
            type: 'stdio',
            command: 'secret-bin',
            env: { GITHUB_TOKEN: 'tok_live' },
          },
        ],
      },
    })
    expect(scan.teamName).toBe('this workspace')
    expect(scan.projectFiles).toEqual([])
    expect(scan.missing).toContain('no AGENTS.md/RAVEN.md/CLAUDE.md in cwd')
    expect(scan.missing).toContain('no project skills')
    expect(JSON.stringify(scan)).not.toContain('tok_live')
    expect(JSON.stringify(scan)).not.toContain('secret-bin')
    expect(scan.mcpServers).toEqual([{ name: 'github', transport: 'stdio' }])
    expect(scan.usage.label).toBe(`your last ${ONBOARDING_USAGE_DAYS} days in this workspace`)
  })

  test('counts slashes only in this cwd', async () => {
    const cwd = tempCwd()
    const other = tempCwd()
    writeFileSync(join(cwd, 'AGENTS.md'), '# Acme\nBe kind.\n')
    mkdirSync(join(cwd, '.ravenclaw', 'skills', 'deploy'), { recursive: true })
    writeFileSync(
      join(cwd, '.ravenclaw', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: ship it\n---\n',
    )
    const store = createMemoryStore()
    const here = session({
      id: 'sess_here',
      cwd,
      createdAt: 1,
      updatedAt: Date.now(),
      title: 'here',
      model: 'x',
    })
    const away = session({ ...here, id: 'sess_away', cwd: other })
    await store.createSession(here)
    await store.createSession(away)
    await store.persistUser('sess_here', {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: '/review please' }],
      createdAt: 1,
    })
    await store.persistUser('sess_here', {
      id: 'u2',
      role: 'user',
      blocks: [{ type: 'text', text: '/review again' }],
      createdAt: 2,
    })
    await store.persistUser('sess_away', {
      id: 'u3',
      role: 'user',
      blocks: [{ type: 'text', text: '/deploy secret' }],
      createdAt: 3,
    })
    const scan = await scanTeamOnboarding({ cwd, home: tempCwd(), store, mcp: { servers: [] } })
    expect(scan.teamName).toBe('Acme')
    expect(scan.projectFiles[0]?.kind).toBe('AGENTS.md')
    expect(scan.skills.some((s) => s.name === 'deploy' && s.source === 'project')).toBe(true)
    expect(scan.usage.sessionCount).toBe(1)
    expect(scan.usage.slashCounts).toEqual([{ name: 'review', count: 2 }])
    expect(scan.usage.slashCounts.some((row) => row.name === 'deploy')).toBe(false)
    expect(scan.missing).not.toContain('no AGENTS.md/RAVEN.md/CLAUDE.md in cwd')
    expect(scan.missing).toContain('no MCP servers in config')
  })
})
