import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME_ENV = 'RAVENCLAW_HOME'
const HOME_DIRNAME = '.ravenclaw'
const HOME_SUBDIRS = ['skills', 'logs', 'tool-results'] as const

export function ravenclawHome(): string {
  const override = process.env[HOME_ENV]
  if (override !== undefined && override !== '') {
    return stripTrailingSlashes(override)
  }
  return join(homedir(), HOME_DIRNAME)
}

export async function ensureHomeDir(): Promise<string> {
  const home = ravenclawHome()
  await mkdir(home, { recursive: true })
  for (const sub of HOME_SUBDIRS) {
    await mkdir(join(home, sub), { recursive: true })
  }
  return home
}

function stripTrailingSlashes(path: string): string {
  if (path.length <= 1) return path
  let end = path.length
  while (end > 1 && path.charCodeAt(end - 1) === 47) end--
  return path.slice(0, end)
}
