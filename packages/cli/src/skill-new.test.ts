import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkill, parseSkillName, skillStarter } from './skill-new'

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
