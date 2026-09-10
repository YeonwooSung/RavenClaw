import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PermissionRule, PermissionScope, SessionStore } from '../types'
import { ravenclawHome } from '../home'
import type { PermissionRuleSet } from './types'

export async function loadPermissionRules(opts: {
  cwd: string
  store: SessionStore
  sessionId: string
}): Promise<PermissionRuleSet> {
  const [session, user, project] = await Promise.all([
    opts.store.listPermissionRules(opts.sessionId),
    readRuleFile(userRulesPath(), ''),
    readRuleFile(projectRulesPath(opts.cwd), ''),
  ])
  return { session, user, project }
}

export async function persistAllowAlways(opts: {
  store: SessionStore
  sessionId: string
  cwd: string
  scope: PermissionScope
  tool: string
  spec?: unknown
}): Promise<PermissionRule> {
  const rule: PermissionRule = {
    id: crypto.randomUUID(),
    sessionId: opts.scope === 'session' ? opts.sessionId : '',
    tool: opts.tool,
    spec: opts.spec ?? {},
    behavior: 'allow',
  }
  if (opts.scope === 'session') {
    const existing = await opts.store.listPermissionRules(opts.sessionId)
    rule.sessionId = opts.sessionId
    await opts.store.setPermissionRules(opts.sessionId, [...existing, rule])
    return rule
  }
  const path = opts.scope === 'user' ? userRulesPath() : projectRulesPath(opts.cwd)
  const current = await readRuleFile(path, '')
  await writeRuleFile(path, [...current, rule])
  return rule
}

export function ruleMatches(rule: PermissionRule, name: string, input: unknown): boolean {
  if (rule.tool !== '*' && rule.tool !== name) return false
  const spec = specPrefix(rule.spec)
  if (spec === undefined) return true
  const target = commandOrPath(input)
  if (target === undefined) return true
  return target === spec || target.startsWith(spec)
}

export function commandOrPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const rec = input as { path?: unknown; command?: unknown }
  if (typeof rec.path === 'string') return rec.path
  if (typeof rec.command === 'string') return rec.command
  return undefined
}

function specPrefix(spec: unknown): string | undefined {
  if (spec === undefined || spec === null || spec === '' || spec === '*') return undefined
  if (typeof spec === 'string') return spec
  if (typeof spec === 'object' && !Array.isArray(spec)) {
    const rec = spec as { path?: unknown; command?: unknown; prefix?: unknown }
    if (typeof rec.path === 'string') return rec.path
    if (typeof rec.command === 'string') return rec.command
    if (typeof rec.prefix === 'string') return rec.prefix
    if (Object.keys(rec).length === 0) return undefined
  }
  return undefined
}

function projectRulesPath(cwd: string): string {
  return join(cwd, '.ravenclaw', 'permissions.json')
}

function userRulesPath(): string {
  return join(ravenclawHome(), 'permissions.json')
}

async function readRuleFile(path: string, sessionId: string): Promise<PermissionRule[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: PermissionRule[] = []
  for (const item of parsed) {
    const rule = asFileRule(item, sessionId)
    if (rule) out.push(rule)
  }
  return out
}

async function writeRuleFile(path: string, rules: PermissionRule[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const body = rules.map((rule) => ({
    id: rule.id,
    tool: rule.tool,
    spec: rule.spec,
    behavior: rule.behavior,
  }))
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
}

function asFileRule(item: unknown, sessionId: string): PermissionRule | undefined {
  if (!item || typeof item !== 'object') return undefined
  const rec = item as { id?: unknown; tool?: unknown; spec?: unknown; behavior?: unknown }
  if (typeof rec.tool !== 'string' || rec.tool.length === 0) return undefined
  if (rec.behavior !== 'allow' && rec.behavior !== 'deny' && rec.behavior !== 'ask') {
    return undefined
  }
  return {
    id: typeof rec.id === 'string' && rec.id.length > 0 ? rec.id : crypto.randomUUID(),
    sessionId,
    tool: rec.tool,
    spec: rec.spec ?? {},
    behavior: rec.behavior,
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  )
}
