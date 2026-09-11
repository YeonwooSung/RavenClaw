import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatSkillLine, formatSkillsList } from './skills-list'

describe('formatSkillsList', () => {
  test('empty dirs is no skills', () => {
    const home = join(tmpdir(), `raven-skills-empty-${Date.now()}`)
    const cwd = join(home, 'proj')
    mkdirSync(cwd, { recursive: true })
    expect(formatSkillsList({ cwd, home })).toBe('no skills')
  })

  test('project skill overrides user skill of the same name', () => {
    const root = join(tmpdir(), `raven-skills-${Date.now()}`)
    const home = join(root, 'home')
    const cwd = join(root, 'proj')
    mkdirSync(join(home, 'skills', 'demo'), { recursive: true })
    mkdirSync(join(cwd, '.ravenclaw', 'skills', 'demo'), { recursive: true })
    mkdirSync(join(home, 'skills', 'only-user'), { recursive: true })
    writeFileSync(
      join(home, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: user copy\n---\n',
    )
    writeFileSync(
      join(cwd, '.ravenclaw', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: project copy\n---\n',
    )
    writeFileSync(
      join(home, 'skills', 'only-user', 'SKILL.md'),
      '---\nname: only-user\ndescription: from home\n---\n',
    )
    const text = formatSkillsList({ cwd, home })
    expect(text).toContain('demo  project  project copy')
    expect(text).not.toContain('user copy')
    expect(text).toContain('only-user  user  from home')
  })

  test('formatSkillLine clips description to 60 chars', () => {
    const line = formatSkillLine(
      { name: 'long', description: 'x'.repeat(80), dir: '/tmp/.ravenclaw/skills/long' },
      '/tmp/proj',
      '/tmp/.ravenclaw',
    )
    expect(line).toBe(`long  user  ${'x'.repeat(60)}`)
  })
})
