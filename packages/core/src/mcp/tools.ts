import { parseWithSchema } from '../tools/parse'
import type { Tool, ToolContext } from '../types'
import type { McpToolBridge, McpToolDescriptor } from './types'

/** Built-ins stay a contiguous sorted prefix (prompt-cache breakpoint). MCP tools append, also sorted. Built-in names win. */
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

export function wrapMcpTool(bridge: McpToolBridge, descriptor: McpToolDescriptor): Tool {
  const schema = descriptor.inputSchema
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: schema,
    parse(input: unknown) {
      return parseWithSchema(schema, input)
    },
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return false
    },
    interruptBehavior() {
      return 'block'
    },
    async checkPermissions() {
      if (isReadOnlyMcpDescriptor(descriptor)) {
        return { behavior: 'allow', reason: 'mode' }
      }
      return { behavior: 'ask', message: 'Use this MCP tool?', saveAs: 'session' }
    },
    async execute(input: unknown, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      const result = await bridge.callTool(descriptor.name, input)
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

export async function loadMcpTools(bridge: McpToolBridge): Promise<Tool[]> {
  return wrapMcpTools(bridge, await bridge.listTools())
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
