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

  if (opts.mode === 'acceptEdits' && isAcceptEditsPromote(opts.name, opts.input, opts.ctx.turn.cwd)) {
    return { behavior: 'allow', reason: 'mode' }
  }
  if (opts.mode === 'dontAsk' && opts.name !== 'ExitPlanMode') {
    return { behavior: 'deny', reason: 'mode', message: leftover.message }
  }
  return leftover
}

function isAcceptEditsPromote(name: string, input: unknown, cwd: string): boolean {
  if (name !== 'Edit' && name !== 'Write') return false
  if (!input || typeof input !== 'object') return false
  const path = (input as { path?: unknown }).path
  if (typeof path !== 'string' || path.length === 0) return false
  return isInTreePath(cwd, path)
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
