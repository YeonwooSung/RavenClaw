import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ravenclawHome } from '@ravenclaw/core'

export function parseSkillName(raw: string): string | undefined {
  const name = raw.trim()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) return undefined
  return name
}

export function skillStarter(name: string): string {
  return `---
name: ${name}
description: Describe what this skill does.
---

# ${name}

When to use this skill, and what the agent should do.
`
}

export function createSkill(opts: {
  name: string
  cwd?: string
  home?: string
  project?: boolean
}): { path: string; created: boolean } | { error: string } {
  const name = parseSkillName(opts.name)
  if (name === undefined) {
    return { error: 'usage: raven skills new <name> [--project]  (name: a-z 0-9 _ -)' }
  }
  const cwd = opts.cwd ?? process.cwd()
  const home = opts.home ?? ravenclawHome()
  const root = opts.project ? join(cwd, '.ravenclaw', 'skills') : join(home, 'skills')
  const dir = join(root, name)
  const path = join(dir, 'SKILL.md')
  if (existsSync(path)) return { path, created: false }
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, skillStarter(name), 'utf8')
  return { path, created: true }
}
