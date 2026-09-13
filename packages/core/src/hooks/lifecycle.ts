import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ravenclawHome } from '../home'

const HOOK_TIMEOUT_MS = 5_000

export const LIFECYCLE_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
] as const

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number]

export type HookCommand = {
  command: string
  if?: string
}

export type HookCommandResult = {
  preventContinuation?: boolean
  message?: string
  behavior?: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
}

export type LifecycleRunResult = {
  preventContinuation?: boolean
  message?: string
  updatedInput?: Record<string, unknown>
}

export interface LifecycleHooks {
  run(event: LifecycleEvent, payload: Record<string, unknown>): Promise<LifecycleRunResult | undefined>
}

export function loadLifecycleHooks(cwd: string, home = ravenclawHome()): LifecycleHooks {
  const files = readHookFiles(cwd, home)
  return {
    async run(event, payload) {
      let last: LifecycleRunResult | undefined
      for (const spec of specsFor(files, event)) {
        if (!matchesToolIf(spec.if, payload.name)) continue
        const raw = runHookCommand(spec.command, payload, cwd)
        if (!raw) continue
        const mapped = mapRunResult(event, raw)
        if (!mapped) continue
        if (mapped.preventContinuation) return mapped
        last = mapped
      }
      return last
    },
  }
}

export function collectHookCommands(
  cwd: string,
  event: LifecycleEvent,
  home = ravenclawHome(),
): HookCommand[] {
  return specsFor(readHookFiles(cwd, home), event)
}

export function listConfiguredHookEvents(cwd: string, home: string): string[] {
  const files = readHookFiles(cwd, home)
  return LIFECYCLE_EVENTS.filter((event) => specsFor(files, event).length > 0)
}

/** `Bash` or `Bash(*)` matches tool name === "Bash". Unset `if` always matches. */
export function matchesToolIf(matcher: string | undefined, name: unknown): boolean {
  if (matcher === undefined || matcher === '') return true
  if (typeof name !== 'string') return false
  const expected = matcher.endsWith('(*)') ? matcher.slice(0, -3) : matcher
  return name === expected
}

export function runHookCommand(
  command: string,
  payload: Record<string, unknown>,
  cwd: string,
): HookCommandResult | undefined {
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(command, {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: HOOK_TIMEOUT_MS,
      shell: true,
      cwd,
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
  const rec = body as {
    preventContinuation?: unknown
    message?: unknown
    behavior?: unknown
    updatedInput?: unknown
  }
  const out: HookCommandResult = {}
  if (rec.preventContinuation === true) out.preventContinuation = true
  if (typeof rec.message === 'string' && rec.message !== '') out.message = rec.message
  if (rec.behavior === 'allow' || rec.behavior === 'deny') out.behavior = rec.behavior
  if (isPlainObject(rec.updatedInput)) out.updatedInput = rec.updatedInput
  if (
    out.preventContinuation === undefined &&
    out.message === undefined &&
    out.behavior === undefined &&
    out.updatedInput === undefined
  ) {
    return undefined
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readHookFiles(cwd: string, home: string): unknown[] {
  const out: unknown[] = []
  for (const path of [join(home, 'hooks.json'), join(cwd, '.ravenclaw', 'hooks.json')]) {
    const parsed = readHooksJson(path)
    if (parsed !== undefined) out.push(parsed)
  }
  return out
}

function readHooksJson(path: string): unknown | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function specsFor(files: unknown[], event: LifecycleEvent): HookCommand[] {
  const out: HookCommand[] = []
  for (const parsed of files) out.push(...parseEventSpecs(parsed, event))
  return out
}

function parseEventSpecs(parsed: unknown, event: LifecycleEvent): HookCommand[] {
  if (!parsed || typeof parsed !== 'object') return []
  const rec = parsed as Record<string, unknown>
  const out: HookCommand[] = []
  if (event === 'PreToolUse') out.push(...readSpecArray(rec.pre_tool))
  out.push(...readSpecArray(rec[event]))
  return out
}

function readSpecArray(value: unknown): HookCommand[] {
  if (!Array.isArray(value)) return []
  const out: HookCommand[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const command = (item as { command?: unknown }).command
    if (typeof command !== 'string' || command.trim() === '') continue
    const spec: HookCommand = { command }
    const when = (item as { if?: unknown }).if
    if (typeof when === 'string' && when !== '') spec.if = when
    out.push(spec)
  }
  return out
}

function mapRunResult(event: LifecycleEvent, raw: HookCommandResult): LifecycleRunResult | undefined {
  const prevent = raw.preventContinuation === true || (event === 'PreToolUse' && raw.behavior === 'deny')
  if (!prevent && raw.message === undefined && raw.updatedInput === undefined) return undefined
  const out: LifecycleRunResult = {}
  if (prevent) out.preventContinuation = true
  if (raw.message !== undefined) out.message = raw.message
  if (raw.updatedInput !== undefined) out.updatedInput = raw.updatedInput
  return out
}
