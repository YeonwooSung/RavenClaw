import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../session/memory-store'
import { appendPermissionRule, loadPermissionRules, persistAllowAlways } from './rules'

const HOME_ENV = 'RAVENCLAW_HOME'
const tempDirs: string[] = []
let savedHome: string | undefined

afterEach(() => {
  if (savedHome === undefined) delete process.env[HOME_ENV]
  else process.env[HOME_ENV] = savedHome
  savedHome = undefined
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function isolateHome(): string {
  savedHome = process.env[HOME_ENV]
  const home = tempDir('ravenclaw-perm-home-')
  process.env[HOME_ENV] = home
  return home
}

describe('permission rules', () => {
  test('loadPermissionRules merges session, user, and project lists', async () => {
    const home = isolateHome()
    const cwd = tempDir('ravenclaw-perm-proj-')
    mkdirSync(join(cwd, '.ravenclaw'))
    writeFileSync(
      join(cwd, '.ravenclaw', 'permissions.json'),
      JSON.stringify([{ tool: 'Write', spec: 'src/', behavior: 'allow' }]),
    )
    writeFileSync(
      join(home, 'permissions.json'),
      JSON.stringify([{ id: 'user-1', tool: 'Bash', spec: 'ls', behavior: 'deny' }]),
    )

    const store = createMemoryStore()
    await store.createSession({
      id: 'sess_1',
      createdAt: 1,
      updatedAt: 1,
      cwd,
      model: 'dummy',
      permissionMode: 'default',
      compactGeneration: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      funding: 'byok',
    })
    await store.setPermissionRules('sess_1', [
      { id: 's1', sessionId: 'sess_1', tool: 'Edit', spec: {}, behavior: 'ask' },
    ])

    const loaded = await loadPermissionRules({ cwd, store, sessionId: 'sess_1' })
    expect(loaded.session).toHaveLength(1)
    expect(loaded.session[0]?.tool).toBe('Edit')
    expect(loaded.user).toHaveLength(1)
    expect(loaded.user[0]?.tool).toBe('Bash')
    expect(loaded.user[0]?.id).toBe('user-1')
    expect(loaded.project).toHaveLength(1)
    expect(loaded.project[0]?.tool).toBe('Write')
    expect(loaded.project[0]?.spec).toBe('src/')
  })

  test('missing JSON files yield empty lists', async () => {
    isolateHome()
    const cwd = tempDir('ravenclaw-perm-empty-')
    const store = createMemoryStore()
    const loaded = await loadPermissionRules({ cwd, store, sessionId: 'missing' })
    expect(loaded).toEqual({ session: [], user: [], project: [] })
  })

  test('persistAllowAlways session uses setPermissionRules only', async () => {
    isolateHome()
    const store = createMemoryStore()
    await store.createSession({
      id: 'sess_1',
      createdAt: 1,
      updatedAt: 1,
      cwd: '/tmp',
      model: 'dummy',
      permissionMode: 'default',
      compactGeneration: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      funding: 'byok',
    })
    await persistAllowAlways({
      store,
      sessionId: 'sess_1',
      cwd: '/tmp',
      scope: 'session',
      tool: 'Bash',
      spec: 'echo',
    })
    const rules = await store.listPermissionRules('sess_1')
    expect(rules).toHaveLength(1)
    expect(rules[0]?.tool).toBe('Bash')
    expect(rules[0]?.spec).toBe('echo')
    expect(rules[0]?.behavior).toBe('allow')
    expect(rules[0]?.sessionId).toBe('sess_1')
  })

  test('persistAllowAlways project and user write JSON files', async () => {
    const home = isolateHome()
    const cwd = tempDir('ravenclaw-perm-write-')
    const store = createMemoryStore()

    await persistAllowAlways({
      store,
      sessionId: 'sess_1',
      cwd,
      scope: 'project',
      tool: 'Edit',
      spec: 'src/',
    })
    await persistAllowAlways({
      store,
      sessionId: 'sess_1',
      cwd,
      scope: 'user',
      tool: 'Write',
      spec: {},
    })

    const project = JSON.parse(
      readFileSync(join(cwd, '.ravenclaw', 'permissions.json'), 'utf8'),
    ) as Array<{ tool: string; spec: unknown; behavior: string }>
    expect(project).toHaveLength(1)
    expect(project[0]).toMatchObject({ tool: 'Edit', spec: 'src/', behavior: 'allow' })
    expect('sessionId' in (project[0] ?? {})).toBe(false)

    const user = JSON.parse(readFileSync(join(home, 'permissions.json'), 'utf8')) as Array<{
      tool: string
    }>
    expect(user).toHaveLength(1)
    expect(user[0]?.tool).toBe('Write')
    expect(await store.listPermissionRules('sess_1')).toEqual([])
  })

  test('appendPermissionRule puts the new rule in the matching list without reloading files', () => {
    const rule = {
      id: 'r1',
      sessionId: 'sess_1',
      tool: 'Bash',
      spec: 'echo',
      behavior: 'allow' as const,
    }
    const empty = { session: [], user: [], project: [] }
    expect(appendPermissionRule(empty, rule, 'session').session).toEqual([rule])
    expect(appendPermissionRule(empty, rule, 'user').user).toEqual([rule])
    expect(appendPermissionRule(empty, rule, 'project').project).toEqual([rule])
    expect(appendPermissionRule(empty, rule, 'session').user).toEqual([])
  })
})
