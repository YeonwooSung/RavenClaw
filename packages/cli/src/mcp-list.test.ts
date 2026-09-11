import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatMcpList, formatMcpServerLine, loadMcpServers } from './mcp-list'

describe('formatMcpServerLine', () => {
  test('prints name, command, args, and env keys not values', () => {
    const line = formatMcpServerLine({
      name: 'fs',
      command: 'bun',
      args: ['server.ts'],
      env: { MCP_ROOT: '/secret/path', TOKEN: 'sk-live' },
    })
    expect(line).toBe('fs  bun server.ts  env: MCP_ROOT,TOKEN')
    expect(line).not.toContain('/secret/path')
    expect(line).not.toContain('sk-live')
  })
})

describe('loadMcpServers', () => {
  test('missing yaml is empty', () => {
    const home = join(tmpdir(), `raven-mcp-empty-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    expect(loadMcpServers(home)).toEqual([])
    expect(formatMcpList([])).toBe('no mcp servers')
  })

  test('reads servers from config.yaml', () => {
    const home = join(tmpdir(), `raven-mcp-yaml-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    writeFileSync(
      join(home, 'config.yaml'),
      'mcp:\n  servers:\n    - name: echo\n      command: bun\n      args: ["echo.ts"]\n',
    )
    const servers = loadMcpServers(home)
    expect(servers.map((s) => s.name)).toEqual(['echo'])
    expect(formatMcpList(servers)).toContain('echo  bun echo.ts')
  })
})
