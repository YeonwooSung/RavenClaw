import {
  discoverSkills,
  pruneSkills,
  ravenclawHome,
  readConfinedSkillMd,
  type DiscoveredSkill,
  type SkillPruneResult,
} from '@ravenclaw/core'

export function formatSkillLine(skill: DiscoveredSkill): string {
  const desc = skill.description.replace(/\s+/g, ' ').trim().slice(0, 60)
  const marks: string[] = []
  if (skill.disabled === true) marks.push('disabled')
  if (skill.stale === true) marks.push('stale')
  const flag = marks.length > 0 ? `  ${marks.join(' ')}` : ''
  return desc === ''
    ? `${skill.name}  ${skill.source}${flag}`
    : `${skill.name}  ${skill.source}${flag}  ${desc}`
}

export function formatSkillsList(opts?: {
  cwd?: string
  home?: string
  includeBuiltin?: boolean
}): string {
  const cwd = opts?.cwd ?? process.cwd()
  const home = opts?.home ?? ravenclawHome()
  const skills = discoverSkills(cwd, home, { includeBuiltin: opts?.includeBuiltin })
  if (skills.length === 0) return 'no skills'
  return skills.map((skill) => formatSkillLine(skill)).join('\n')
}

export type SkillsSlash =
  | { action: 'list' }
  | { action: 'show'; name: string }
  | { action: 'disable'; name: string }
  | { action: 'enable'; name: string }
  | { action: 'prune' }
  | { action: 'error'; message: string }

export function parseSkillsSlashArg(arg?: string): SkillsSlash {
  if (arg === undefined || arg.trim() === '') return { action: 'list' }
  const parts = arg.trim().split(/\s+/)
  const verb = parts[0]?.toLowerCase()
  const name = parts[1]
  if (verb === 'prune') return { action: 'prune' }
  if (verb === 'show' || verb === 'disable' || verb === 'enable') {
    if (name === undefined || name === '') {
      return { action: 'error', message: `usage: /skills ${verb} <name>` }
    }
    return { action: verb, name }
  }
  return { action: 'error', message: 'usage: /skills [show|disable|enable <name>|prune]' }
}

export function formatSkillPruneResult(result: SkillPruneResult): string {
  const parts: string[] = []
  if (result.stale.length > 0) parts.push(`stale ${result.stale.join(', ')}`)
  if (result.archived.length > 0) parts.push(`archived ${result.archived.join(', ')}`)
  if (result.reactivated.length > 0) parts.push(`active ${result.reactivated.join(', ')}`)
  return parts.length === 0 ? 'no skills to prune' : parts.join('\n')
}

export function runSkillsPrune(opts?: { cwd?: string; home?: string }): string {
  return formatSkillPruneResult(
    pruneSkills({
      cwd: opts?.cwd ?? process.cwd(),
      ...(opts?.home !== undefined ? { home: opts.home } : {}),
    }),
  )
}

export function formatSkillShow(dir: string): string {
  const loaded = readConfinedSkillMd(dir)
  if (!loaded.ok) return 'could not read SKILL.md'
  return loaded.text.slice(0, 4000)
}
