import type { Tool, ToolContext } from '../types'

export interface ToolRegistry {
  register(tool: Tool): void
  get(name: string): Tool | undefined
  list(filter?: { names?: string[] }, ctx?: ToolContext): Tool[]
}

export function createToolRegistry(tools?: Tool[]): ToolRegistry {
  const items: Tool[] = []
  const indexByName = new Map<string, number>()

  function register(tool: Tool): void {
    const existing = indexByName.get(tool.name)
    if (existing !== undefined) {
      items[existing] = tool
      return
    }
    indexByName.set(tool.name, items.length)
    items.push(tool)
  }

  if (tools) {
    for (const tool of tools) register(tool)
  }

  return {
    register,
    get(name) {
      const index = indexByName.get(name)
      if (index === undefined) return undefined
      return items[index]
    },
    list(filter, ctx) {
      let out = items.slice()
      if (filter?.names) {
        const allow = new Set(filter.names)
        out = out.filter((tool) => allow.has(tool.name))
      }
      if (ctx) {
        out = out.filter((tool) => (tool.isEnabled ? tool.isEnabled(ctx) : true))
      }
      return out
    },
  }
}
