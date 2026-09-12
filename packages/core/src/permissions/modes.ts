import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { PermissionMode, Tool } from '../types'

const CYCLE: Record<Exclude<PermissionMode, 'dontAsk'>, PermissionMode> = {
  default: 'acceptEdits',
  acceptEdits: 'plan',
  plan: 'default',
}

const READ_ONLY_NAMES = new Set([
  'Read',
  'Grep',
  'Glob',
  'Skill',
  'Fetch',
  'EnterPlanMode',
  'ExitPlanMode',
  'TaskOutput',
  'ListMcpResources',
  'ReadMcpResource',
  'CronList',
  'ListDir',
  'ReadSubtree',
  'WebSearch',
  'SuggestFollowups',
  'SetOutput',
  'ToolSearch',
  'Sleep',
  'ThinkDeeply',
  'TaskGet',
  'TaskList',
  'LSP',
  'StructuredOutput',
  'SessionSearch',
])

const MUTATING_NAMES = new Set([
  'Edit',
  'Write',
  'Bash',
  'Agent',
  'TodoWrite',
  'TaskStop',
  'CronCreate',
  'CronDelete',
  'CronSetEnabled',
  'ApplyPatch',
  'AskUser',
  'NotebookEdit',
  'EnterWorktree',
  'ExitWorktree',
  'AddDir',
  'TaskCreate',
  'TaskUpdate',
  'Memory',
])

export function cyclePermissionMode(mode: PermissionMode): PermissionMode {
  if (mode === 'dontAsk') return 'dontAsk'
  return CYCLE[mode]
}

export function isMutatingTool(name: string, input?: unknown, tool?: Tool): boolean {
  if (name === 'ExitPlanMode' || name === 'EnterPlanMode') return false
  if (tool) return !tool.isReadOnly(input)
  if (READ_ONLY_NAMES.has(name)) return false
  return MUTATING_NAMES.has(name)
}

export function isInTreePath(cwd: string, inputPath: string, extraRoots?: string[]): boolean {
  const resolved = resolveExisting(cwd, inputPath)
  if (isResolvedInRoot(resolved, resolveExisting(cwd, '.'))) return true
  for (const extra of extraRoots ?? []) {
    if (isResolvedInRoot(resolved, resolveExisting(cwd, extra))) return true
  }
  return false
}

function isResolvedInRoot(resolved: string, root: string): boolean {
  if (resolved === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return resolved.startsWith(prefix)
}

export function resolveExisting(cwd: string, inputPath: string): string {
  const candidate = resolve(cwd, inputPath)
  try {
    return realpathSync(candidate)
  } catch {
    const parts = [basename(candidate)]
    let parent = dirname(candidate)
    while (true) {
      try {
        return join(realpathSync(parent), ...parts)
      } catch {
        const next = dirname(parent)
        if (next === parent) return candidate
        parts.unshift(basename(parent))
        parent = next
      }
    }
  }
}
