import { parseWithSchema } from '../tools/parse'
import type { Tool, ToolContext } from '../types'
import type { McpToolBridge, McpToolDescriptor } from './types'

export interface McpToolFilter {
  tools?: string[]
  excludeTools?: string[]
}

/** Built-ins stay a contiguous sorted prefix (prompt-cache breakpoint). MCP tools append, also sorted. Built-in names win. */
/** Append newly ready MCP tools after the existing prefix. Does not re-sort or replace names. */
export function appendDeferredMcpTools(existing: Tool[], incoming: Tool[]): Tool[] {
  const names = new Set(existing.map((tool) => tool.name))
  for (const tool of incoming) {
    if (names.has(tool.name)) continue
    names.add(tool.name)
    existing.push(tool)
  }
  return existing
}

export function mergeToolPool(builtins: Tool[], mcpTools: Tool[]): Tool[] {
  const sortedBuiltins = sortByName(builtins)
  const builtinNames = new Set(sortedBuiltins.map((tool) => tool.name))
  const sortedMcp: Tool[] = []
  const seenMcp = new Set<string>()
  for (const tool of sortByName(mcpTools)) {
    if (builtinNames.has(tool.name) || seenMcp.has(tool.name)) continue
    seenMcp.add(tool.name)
    sortedMcp.push(tool)
  }
  return [...sortedBuiltins, ...sortedMcp]
}

export function filterMcpDescriptors(
  descriptors: McpToolDescriptor[],
  opts?: McpToolFilter,
): McpToolDescriptor[] {
  let out = descriptors
  if (opts?.tools !== undefined) {
    const allow = new Set(opts.tools)
    out = out.filter((descriptor) => allow.has(descriptor.name))
  }
  if (opts?.excludeTools !== undefined && opts.excludeTools.length > 0) {
    const deny = new Set(opts.excludeTools)
    out = out.filter((descriptor) => !deny.has(descriptor.name))
  }
  return out
}

export function deferUntilUnlocked(tool: Tool): Tool {
  const prior = tool.isEnabled
  return {
    ...tool,
    isEnabled(ctx: ToolContext) {
      if (!ctx.turn.unlockedToolNames?.includes(tool.name)) return false
      return prior ? prior.call(tool, ctx) : true
    },
  }
}

export function wrapMcpTool(bridge: McpToolBridge, descriptor: McpToolDescriptor): Tool {
  const schema = descriptor.inputSchema
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: schema,
    parse(input: unknown) {
      return parseWithSchema(schema, input)
    },
    isEnabled(ctx: ToolContext) {
      return ctx.turn.unlockedToolNames?.includes(descriptor.name) === true
    },
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return false
    },
    interruptBehavior() {
      return 'cancel'
    },
    async checkPermissions() {
      if (isReadOnlyMcpDescriptor(descriptor)) {
        return { behavior: 'allow', reason: 'mode' }
      }
      return { behavior: 'ask', message: 'Use this MCP tool?', saveAs: 'session' }
    },
    async execute(input: unknown, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      const result = await bridge.callTool(descriptor.name, input, { signal: ctx.signal })
      return formatMcpCallResult(result)
    },
  }
}

function isReadOnlyMcpDescriptor(descriptor: McpToolDescriptor): boolean {
  return (descriptor as McpToolDescriptor & { readOnly?: unknown }).readOnly === true
}

export function wrapMcpTools(bridge: McpToolBridge, descriptors: McpToolDescriptor[]): Tool[] {
  return descriptors.map((descriptor) => wrapMcpTool(bridge, descriptor))
}

export async function loadMcpTools(bridge: McpToolBridge, opts?: McpToolFilter): Promise<Tool[]> {
  return wrapMcpTools(bridge, filterMcpDescriptors(await bridge.listTools(), opts))
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return items.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function formatMcpCallResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return result === undefined || result === null ? '' : String(result)
  const rec = result as { isError?: unknown; content?: unknown }
  const text = formatMcpContent(rec.content)
  if (rec.isError === true) {
    throw new Error(text || 'MCP tool error')
  }
  return text
}

function formatMcpContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content === undefined || content === null) return ''
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    if ((item as { type?: unknown }).type !== 'text') continue
    const text = (item as { text?: unknown }).text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
