import type { PermissionRule, Tool, ToolContext, PermissionMode } from '../types'

export interface PermissionRuleSet {
  session: PermissionRule[]
  user: PermissionRule[]
  project: PermissionRule[]
}

export interface DecidePermissionOpts {
  tool: Tool
  name: string
  input: unknown
  ctx: ToolContext
  mode: PermissionMode
  rules: PermissionRuleSet
}
