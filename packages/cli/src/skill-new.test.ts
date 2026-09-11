import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkill, deleteSkill, parseSkillName, skillStarter } from './skill-new'

describe('parseSkillName', () => {
  test('accepts lowercase names and rejects paths', () => {
    expect(parseSkillName('demo')).toBe('demo')
    expect(parseSkillName('my-skill_1')).toBe('my-skill_1')
    expect(parseSkillName('../etc')).toBeUndefined()
    expect(parseSkillName('HasCaps')).toBeUndefined()
    expect(parseSkillName('')).toBeUndefined()
  })
})

describe('createSkill', () => {
  test('writes a user skill and does not overwrite', () => {
    const home = join(tmpdir(), `raven-skill-new-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    const first = createSkill({ name: 'demo', home, cwd: home })
    expect(first).toMatchObject({ created: true })
    if ('error' in first) throw new Error(first.error)
    expect(readFileSync(first.path, 'utf8')).toBe(skillStarter('demo'))
    expect(first.path).toContain(`${join('skills', 'demo', 'SKILL.md')}`)
    writeFileSync(first.path, 'keep\n')
    const second = createSkill({ name: 'demo', home, cwd: home })
    expect(second).toEqual({ path: first.path, created: false })
    expect(readFileSync(first.path, 'utf8')).toBe('keep\n')
  })

  test('--project writes under cwd/.ravenclaw/skills', () => {
    const root = join(tmpdir(), `raven-skill-proj-${Date.now()}`)
    const cwd = join(root, 'proj')
    mkdirSync(cwd, { recursive: true })
    const result = createSkill({ name: 'local', cwd, home: join(root, 'home'), project: true })
    if ('error' in result) throw new Error(result.error)
    expect(result.created).toBe(true)
    expect(result.path).toBe(join(cwd, '.ravenclaw', 'skills', 'local', 'SKILL.md'))
  })
})

describe('deleteSkill', () => {
  test('removes a user skill directory', () => {
    const home = join(tmpdir(), `raven-skill-rm-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    const created = createSkill({ name: 'gone', home, cwd: home })
    if ('error' in created) throw new Error(created.error)
    const deleted = deleteSkill({ name: 'gone', home, cwd: home })
    expect(deleted).toEqual({ path: created.path })
    expect(existsSync(join(home, 'skills', 'gone'))).toBe(false)
    expect(deleteSkill({ name: 'gone', home, cwd: home })).toEqual({
      error: 'skill not found: gone',
    })
  })

  test('does not delete a project skill unless --project', () => {
    const root = join(tmpdir(), `raven-skill-rm-proj-${Date.now()}`)
    const cwd = join(root, 'proj')
    const home = join(root, 'home')
    mkdirSync(cwd, { recursive: true })
    const created = createSkill({ name: 'keep', cwd, home, project: true })
    if ('error' in created) throw new Error(created.error)
    expect(deleteSkill({ name: 'keep', cwd, home })).toEqual({
      error: 'skill not found: keep',
    })
    expect(existsSync(created.path)).toBe(true)
    expect(deleteSkill({ name: 'keep', cwd, home, project: true })).toEqual({
      path: created.path,
    })
    expect(existsSync(created.path)).toBe(false)
  })
})
