import type { PermissionDecision, PermissionRule } from '../types'
import { isPlanFilePath } from '../tools/plan-file'
import { runPermissionHooks } from './hooks'
import { isInTreePath, isMutatingTool } from './modes'
import { ruleMatches } from './rules'
import { safetyCheck } from './safety'
import type { DecidePermissionOpts, PermissionRuleSet } from './types'

export type { DecidePermissionOpts, PermissionRuleSet } from './types'

const SCOPES = ['session', 'user', 'project'] as const

export async function decidePermission(opts: DecidePermissionOpts): Promise<PermissionDecision> {
  const denyRule = firstMatch(opts.rules, 'deny', opts.name, opts.input)
  if (denyRule) {
    return { behavior: 'deny', reason: 'rule', message: `denied by ${denyRule.scope} rule` }
  }

  const checked = await opts.tool.checkPermissions(opts.input, opts.ctx)
  if (checked.behavior === 'deny') return checked

  const safety = safetyCheck(opts.name, opts.input, opts.ctx.turn.cwd)
  if (safety) return safety

  let leftover: PermissionDecision = checked
  if (opts.hooks) {
    const hooked = await runPermissionHooks(opts.hooks, { name: opts.name, input: opts.input })
    if (hooked?.behavior === 'deny') return hooked
    if (hooked?.behavior === 'allow' && leftover.behavior === 'ask') leftover = hooked
  }

  if (
    opts.mode === 'plan' &&
    opts.name !== 'ExitPlanMode' &&
    isMutatingTool(opts.name, opts.input, opts.tool) &&
    !isPlanFileMutation(opts.name, opts.input, opts.ctx.turn.cwd)
  ) {
    return {
      behavior: 'deny',
      reason: 'mode',
      message: 'plan mode: mutating tools are denied until ExitPlanMode',
    }
  }

  if (leftover.behavior === 'ask') {
    const allow = firstMatch(opts.rules, 'allow', opts.name, opts.input)
    if (allow) leftover = { behavior: 'allow', reason: 'rule' }
  }

  if (leftover.behavior !== 'ask') return leftover

  if (
    opts.mode === 'acceptEdits' &&
    isAcceptEditsPromote(opts.name, opts.input, opts.ctx.turn.cwd, opts.ctx.turn.additionalDirectories)
  ) {
    return { behavior: 'allow', reason: 'mode' }
  }
  if (opts.mode === 'dontAsk' && opts.name !== 'ExitPlanMode') {
    if (opts.name === 'Fetch' || opts.name === 'AskUser') {
      return { behavior: 'deny', reason: 'mode', message: leftover.message }
    }
    if (opts.tool.isReadOnly()) return { behavior: 'allow', reason: 'mode' }
    if (isAcceptEditsPromote(opts.name, opts.input, opts.ctx.turn.cwd, opts.ctx.turn.additionalDirectories)) {
      return { behavior: 'allow', reason: 'mode' }
    }
    return { behavior: 'deny', reason: 'mode', message: leftover.message }
  }
  return leftover
}

function isAcceptEditsPromote(
  name: string,
  input: unknown,
  cwd: string,
  extraRoots?: string[],
): boolean {
  if (name === 'ApplyPatch') {
    const paths = applyPatchPaths(input)
    if (paths === undefined) return false
    return paths.every((path) => isInTreePath(cwd, path, extraRoots))
  }
  if (name !== 'Edit' && name !== 'Write') return false
  if (!input || typeof input !== 'object') return false
  const path = (input as { path?: unknown }).path
  if (typeof path !== 'string' || path.length === 0) return false
  return isInTreePath(cwd, path, extraRoots)
}

/** Every operation must have a path; mixed or empty patches are not promoted. */
function applyPatchPaths(input: unknown): string[] | undefined {
  if (!input || typeof input !== 'object') return undefined
  const operations = (input as { operations?: unknown }).operations
  if (!Array.isArray(operations) || operations.length === 0) return undefined
  const paths: string[] = []
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object') return undefined
    const path = (operation as { path?: unknown }).path
    if (typeof path !== 'string' || path.length === 0) return undefined
    paths.push(path)
  }
  return paths
}

/** Plan-mode one-path exception: Edit/Write of cwd/.ravenclaw/plan.md only. */
export function isPlanFileMutation(name: string, input: unknown, cwd: string): boolean {
  if (name !== 'Edit' && name !== 'Write') return false
  if (!input || typeof input !== 'object') return false
  const path = (input as { path?: unknown }).path
  if (typeof path !== 'string' || path.length === 0) return false
  return isPlanFilePath(cwd, path)
}

function firstMatch(
  rules: PermissionRuleSet,
  behavior: 'allow' | 'deny',
  name: string,
  input: unknown,
): { rule: PermissionRule; scope: (typeof SCOPES)[number] } | undefined {
  for (const scope of SCOPES) {
    for (const rule of rules[scope]) {
      if (rule.behavior === behavior && ruleMatches(rule, name, input)) {
        return { rule, scope }
      }
    }
  }
  return undefined
}
