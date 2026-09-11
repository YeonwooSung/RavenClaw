import { ravenclawHome } from '../home'
import {
  collectHookCommands,
  matchesToolIf,
  runHookCommand,
  type HookCommand,
} from '../hooks/lifecycle'
import type { PermissionHook } from './hooks'

export function loadFileHooks(cwd: string, home = ravenclawHome()): PermissionHook[] {
  return collectHookCommands(cwd, 'PreToolUse', home).map((spec) => commandHook(spec, cwd))
}

function commandHook(spec: HookCommand, cwd: string): PermissionHook {
  return (info) => {
    if (!matchesToolIf(spec.if, info.name)) return undefined
    const raw = runHookCommand(spec.command, { name: info.name, input: info.input }, cwd)
    if (!raw) return undefined
    if (raw.behavior === 'allow') return { behavior: 'allow', reason: 'hook' }
    if (raw.behavior === 'deny') {
      return {
        behavior: 'deny',
        reason: 'hook',
        message: raw.message !== undefined ? raw.message : 'denied by hook',
      }
    }
    return undefined
  }
}
