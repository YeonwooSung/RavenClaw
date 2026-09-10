import type { PermissionDecision } from '../types'

export type PermissionHook = (
  info: { name: string; input: unknown },
) => PermissionDecision | void | Promise<PermissionDecision | void>

export async function runPermissionHooks(
  hooks: PermissionHook[],
  info: { name: string; input: unknown },
): Promise<PermissionDecision | undefined> {
  let notedAllow: Extract<PermissionDecision, { behavior: 'allow' }> | undefined
  for (const hook of hooks) {
    const result = await hook(info)
    if (result === undefined) continue
    if (result.behavior === 'deny') {
      return { behavior: 'deny', reason: 'hook', message: result.message }
    }
    if (result.behavior === 'allow' && notedAllow === undefined) {
      notedAllow = { behavior: 'allow', reason: 'hook' }
    }
  }
  return notedAllow
}
