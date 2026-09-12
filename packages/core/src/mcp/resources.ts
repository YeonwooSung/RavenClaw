import { parseWithSchema } from '../tools/parse'
import type { Tool, ToolContext } from '../types'
import type { McpResource, McpToolBridge } from './types'

export interface NamedMcpBridge {
  name: string
  bridge: McpToolBridge
}

export function createMcpResourceTools(hosts: NamedMcpBridge[]): Tool[] {
  if (hosts.length === 0) return []
  return [listMcpResourcesTool(hosts), readMcpResourceTool(hosts)]
}

function listMcpResourcesTool(hosts: NamedMcpBridge[]): Tool<{ server?: string }, string> {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      server: { type: 'string' },
    },
  }
  return {
    name: 'ListMcpResources',
    description: 'List resources from connected MCP servers. Optional server name filters to one server.',
    inputSchema: schema,
    parse(input: unknown) {
      return parseWithSchema<{ server?: string }>(schema, input ?? {})
    },
    isEnabled(ctx: ToolContext) {
      return ctx.turn.unlockedToolNames?.includes('ListMcpResources') === true
    },
    isConcurrencySafe() {
      return true
    },
    isReadOnly() {
      return true
    },
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute(input) {
      const selected =
        input.server !== undefined && input.server !== ''
          ? hosts.filter((host) => host.name === input.server)
          : hosts
      if (selected.length === 0) return 'no matching MCP servers'
      const rows: string[] = []
      for (const host of selected) {
        const resources = await host.bridge.listResources()
        for (const resource of resources) {
          rows.push(formatResourceLine(host.name, resource))
        }
      }
      return rows.length === 0 ? 'no MCP resources' : rows.join('\n')
    },
  }
}

function readMcpResourceTool(
  hosts: NamedMcpBridge[],
): Tool<{ uri: string; server?: string }, string> {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['uri'],
    properties: {
      uri: { type: 'string', minLength: 1 },
      server: { type: 'string' },
    },
  }
  return {
    name: 'ReadMcpResource',
    description: 'Read one MCP resource by uri. Optional server name selects which connected server to query.',
    inputSchema: schema,
    parse(input: unknown) {
      return parseWithSchema<{ uri: string; server?: string }>(schema, input)
    },
    isEnabled(ctx: ToolContext) {
      return ctx.turn.unlockedToolNames?.includes('ReadMcpResource') === true
    },
    isConcurrencySafe() {
      return true
    },
    isReadOnly() {
      return true
    },
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute(input) {
      const selected =
        input.server !== undefined && input.server !== ''
          ? hosts.filter((host) => host.name === input.server)
          : hosts
      if (selected.length === 0) return `ReadMcpResource failed: no matching server`
      let lastError = 'not found'
      for (const host of selected) {
        try {
          const contents = await host.bridge.readResource(input.uri)
          if (contents.text !== undefined) return contents.text
          if (contents.blob !== undefined) {
            return `[binary ${contents.mimeType ?? 'application/octet-stream'} ${contents.blob.length} chars]`
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
        }
      }
      return `ReadMcpResource failed: ${lastError}`
    },
  }
}

function formatResourceLine(server: string, resource: McpResource): string {
  const name = resource.name ?? resource.uri
  const mime = resource.mimeType ? `  ${resource.mimeType}` : ''
  return `${server}  ${name}  ${resource.uri}${mime}`
}
