import type { McpServerConfig } from '@ravenclaw/core'
import { loadConfiguredMcpTools } from './mcp'

export async function formatMcpToolsReport(
  servers: McpServerConfig[],
  load = loadConfiguredMcpTools,
): Promise<string> {
  if (servers.length === 0) return 'no mcp servers'
  const lines: string[] = []
  for (const server of servers) {
    const loaded = await load([server])
    try {
      const names = loaded.tools
        .map((tool) => tool.name)
        .filter((name) => name !== 'ListMcpResources' && name !== 'ReadMcpResource')
      lines.push(
        names.length === 0
          ? `${server.name}  (no tools or failed)`
          : `${server.name}  ${names.join(', ')}`,
      )
    } finally {
      await loaded.close()
    }
  }
  return lines.join('\n')
}
