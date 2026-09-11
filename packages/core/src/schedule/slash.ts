import { parseJobSpec } from './cron'
import type { JobSchedule } from './types'

export type CronSlashAction =
  | { action: 'list' }
  | { action: 'add'; spec: string; prompt: string; schedule: JobSchedule }
  | { action: 'rm'; id: string }
  | { action: 'on'; id: string }
  | { action: 'off'; id: string }
  | { action: 'error'; message: string }

export const CRON_USAGE = 'usage: /cron | /cron add <spec> <prompt> | /cron rm|on|off <id>'

export function parseCronSlashArg(arg?: string): CronSlashAction {
  if (arg === undefined || arg.trim() === '') return { action: 'list' }
  const trimmed = arg.trim()
  const verb = trimmed.split(/\s+/, 1)[0]?.toLowerCase()
  const rest = trimmed.slice(verb?.length ?? 0).trim()
  if (verb === 'list') return { action: 'list' }
  if (verb === 'rm' || verb === 'on' || verb === 'off') {
    const id = rest.split(/\s+/, 1)[0]
    if (!id) return { action: 'error', message: CRON_USAGE }
    if (verb === 'rm') return { action: 'rm', id }
    if (verb === 'on') return { action: 'on', id }
    return { action: 'off', id }
  }
  if (verb === 'add') {
    const parsed = splitAddSpec(rest)
    if (!parsed) return { action: 'error', message: CRON_USAGE }
    const spec = parseJobSpec(parsed.spec)
    if (!spec.ok) return { action: 'error', message: spec.message }
    return { action: 'add', spec: parsed.spec, prompt: parsed.prompt, schedule: spec.schedule }
  }
  return { action: 'error', message: CRON_USAGE }
}

function splitAddSpec(rest: string): { spec: string; prompt: string } | undefined {
  const every = /^(every\s+\d+[smh])\s+(.+)$/i.exec(rest)
  if (every?.[1] && every[2]) return { spec: every[1], prompt: every[2] }
  const alias = /^(@hourly|@daily)\s+(.+)$/i.exec(rest)
  if (alias?.[1] && alias[2]) return { spec: alias[1], prompt: alias[2] }
  const fields = rest.split(/\s+/)
  if (fields.length >= 6) {
    return { spec: fields.slice(0, 5).join(' '), prompt: fields.slice(5).join(' ') }
  }
  return undefined
}
