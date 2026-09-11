import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ravenclawHome } from '../home'
import type { PermissionHook } from './hooks'

const HOOK_TIMEOUT_MS = 5_000

export function loadFileHooks(cwd: string, home = ravenclawHome()): PermissionHook[] {
  const hooks: PermissionHook[] = []
  for (const path of [join(home, 'hooks.json'), join(cwd, '.ravenclaw', 'hooks.json')]) {
    hooks.push(...hooksFromFile(path))
  }
  return hooks
}

function hooksFromFile(path: string): PermissionHook[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return []
  }
  return extractCommands(parsed).map(commandHook)
}

function extractCommands(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== 'object') return []
  const rec = parsed as { pre_tool?: unknown }
  if (!Array.isArray(rec.pre_tool)) return []
  const out: string[] = []
  for (const item of rec.pre_tool) {
    if (!item || typeof item !== 'object') continue
    const command = (item as { command?: unknown }).command
    if (typeof command === 'string' && command.trim() !== '') out.push(command)
  }
  return out
}

function commandHook(command: string): PermissionHook {
  return (info) => {
    let result: ReturnType<typeof spawnSync>
    try {
      result = spawnSync(command, {
        input: JSON.stringify({ name: info.name, input: info.input }),
        encoding: 'utf8',
        timeout: HOOK_TIMEOUT_MS,
        shell: true,
      })
    } catch {
      return undefined
    }
    const stdout = (result.stdout ?? '').trim()
    if (stdout === '') return undefined
    let body: unknown
    try {
      body = JSON.parse(stdout) as unknown
    } catch {
      return undefined
    }
    if (!body || typeof body !== 'object') return undefined
    const rec = body as { behavior?: unknown; message?: unknown }
    if (rec.behavior === 'allow') return { behavior: 'allow', reason: 'hook' }
    if (rec.behavior === 'deny') {
      return {
        behavior: 'deny',
        reason: 'hook',
        message: typeof rec.message === 'string' && rec.message !== '' ? rec.message : 'denied by hook',
      }
    }
    return undefined
  }
}
