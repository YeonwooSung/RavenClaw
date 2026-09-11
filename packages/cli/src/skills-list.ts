import { join } from 'node:path'
import { discoverSkills, ravenclawHome, type DiscoveredSkill } from '@ravenclaw/core'

export function formatSkillLine(
  skill: DiscoveredSkill,
  cwd: string,
  home: string,
): string {
  const projectRoot = join(cwd, '.ravenclaw', 'skills')
  const source = skill.dir.startsWith(projectRoot) ? 'project' : 'user'
  const desc = skill.description.replace(/\s+/g, ' ').trim().slice(0, 60)
  return desc === '' ? `${skill.name}  ${source}` : `${skill.name}  ${source}  ${desc}`
}

export function formatSkillsList(opts?: { cwd?: string; home?: string }): string {
  const cwd = opts?.cwd ?? process.cwd()
  const home = opts?.home ?? ravenclawHome()
  const skills = discoverSkills(cwd, home)
  if (skills.length === 0) return 'no skills'
  return skills.map((skill) => formatSkillLine(skill, cwd, home)).join('\n')
}
