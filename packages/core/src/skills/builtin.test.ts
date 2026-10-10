import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { builtinSkillsRoot, parseSkillFrontmatter } from '../tools/skill'

const REQUIRED = ['review', 'test', 'commit', 'debug', 'tdd', 'plan', 'frontend-design', 'mcp-builder', 'gamedev']

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

  test('gamedev is one router over a 74-skill catalog', () => {
    const root = builtinSkillsRoot()
    const top = readdirSync(root).filter((name) => !name.startsWith('.'))
    expect(top).not.toContain('router')
    const catalog = join(root, 'gamedev', 'catalog')
    const dirs = readdirSync(catalog, { withFileTypes: true }).filter((ent) => ent.isDirectory())
    expect(dirs).toHaveLength(74)
    const names = dirs.map((ent) => ent.name)
    expect(names).not.toContain('router')
    for (const name of names) {
      const markdown = readFileSync(join(catalog, name, 'SKILL.md'), 'utf8')
      const fm = parseSkillFrontmatter(markdown)
      expect(fm.name).toBe(name)
      const description = fm.description ?? ''
      expect(description.length).toBeGreaterThan(8)
      expect(description).not.toBe('>')
      expect(description).not.toBe('|')
    }
    for (const name of [
      'phaser-core',
      'godot-gdscript',
      'unity-csharp-scripting',
      'unreal-blueprints',
      'threejs-scene-setup',
      'platformer',
      'save-systems',
      'itch-publish',
    ]) {
      expect(names).toContain(name)
    }

    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, ent.name)
        if (ent.isDirectory()) {
          walk(path)
          continue
        }
        const text = readFileSync(path).toString('utf8').toLowerCase()
        expect(text).not.toContain('claude')
        expect(text).not.toContain('anthropic')
      }
    }
    walk(join(root, 'gamedev'))

    const router = readFileSync(join(root, 'gamedev', 'SKILL.md'), 'utf8')
    expect(router).toContain('catalog/phaser-core/SKILL.md')
    expect(router).toContain('Skill tool')
    expect(router).toContain(
      'description: Game-dev router: Godot, Unity, Unreal, web, and genres.',
    )
  })
})
