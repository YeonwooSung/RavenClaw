import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultConfig, parseConfigYaml, ravenclawHome, type McpServerConfig } from '@ravenclaw/core'

export function loadMcpServers(home?: string): McpServerConfig[] {
  const dir = home ?? ravenclawHome()
  const path = join(dir, 'config.yaml')
  if (!existsSync(path)) return defaultConfig().mcp.servers
  return parseConfigYaml(readFileSync(path, 'utf8')).mcp?.servers ?? defaultConfig().mcp.servers
}

export function formatMcpServerLine(server: McpServerConfig): string {
  const args = server.args !== undefined && server.args.length > 0 ? ` ${server.args.join(' ')}` : ''
  const envKeys = server.env !== undefined ? Object.keys(server.env) : []
  const env = envKeys.length > 0 ? `  env: ${envKeys.join(',')}` : ''
  return `${server.name}  ${server.command}${args}${env}`
}

export function formatMcpList(servers: McpServerConfig[]): string {
  if (servers.length === 0) return 'no mcp servers'
  return servers.map(formatMcpServerLine).join('\n')
}
