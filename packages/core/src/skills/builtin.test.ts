import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { builtinSkillsRoot, parseSkillFrontmatter } from '../tools/skill'

const REQUIRED = ['review', 'test', 'commit', 'debug', 'tdd', 'plan', 'frontend-design', 'mcp-builder']

describe('builtin skills', () => {
  test('each bundled skill has name, description, and a body', () => {
    const root = builtinSkillsRoot()
    const names = readdirSync(root).filter((name) => !name.startsWith('.'))
    expect(names.sort()).toEqual([...REQUIRED].sort())
    for (const name of names) {
      const markdown = readFileSync(join(root, name, 'SKILL.md'), 'utf8')
      const fm = parseSkillFrontmatter(markdown)
      expect(fm.name).toBe(name)
      expect((fm.description ?? '').length).toBeGreaterThan(8)
      expect(markdown).not.toContain('Claude')
      expect(markdown).not.toContain('Anthropic')
    }
  })

  test('mcp-builder verifies spawn via raven mcp tools, not in-session /mcp after reload', () => {
    const markdown = readFileSync(join(builtinSkillsRoot(), 'mcp-builder', 'SKILL.md'), 'utf8')
    expect(markdown).toContain('raven mcp tools')
    expect(markdown).not.toMatch(/Verify with `\/mcp`/)
  })
})
