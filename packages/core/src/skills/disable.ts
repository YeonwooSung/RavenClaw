import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ravenclawHome } from '../home'

export function disabledSkillsPath(home = ravenclawHome()): string {
  return join(home, 'skills-disabled.json')
}

export function loadDisabledSkills(home = ravenclawHome()): string[] {
  try {
    const parsed = JSON.parse(readFileSync(disabledSkillsPath(home), 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
  } catch {
    return []
  }
}

export function setSkillDisabled(name: string, disabled: boolean, home = ravenclawHome()): string[] {
  const current = new Set(loadDisabledSkills(home))
  if (disabled) current.add(name)
  else current.delete(name)
  const next = [...current].sort()
  mkdirSync(home, { recursive: true })
  writeFileSync(disabledSkillsPath(home), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

export function isSkillDisabled(name: string, home = ravenclawHome()): boolean {
  return loadDisabledSkills(home).includes(name)
}
