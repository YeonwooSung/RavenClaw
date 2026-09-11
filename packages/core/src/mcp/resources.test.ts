import { describe, expect, test } from 'bun:test'
import { createMcpToolBridge } from './client'
import { createMcpResourceTools } from './resources'
import type { McpTransport } from './types'

function fakeTransport(over: Record<string, unknown> = {}): McpTransport {
  return {
    async request(method) {
      if (method === 'initialize') return { protocolVersion: '2025-03-26' }
      if (method === 'resources/list') {
        return {
          resources: [{ uri: 'memo://notes', name: 'notes', mimeType: 'text/plain' }],
          ...over,
        }
      }
      if (method === 'resources/read') {
        return { contents: [{ uri: 'memo://notes', text: 'hello resource' }] }
      }
      if (method === 'tools/list') return { tools: [] }
      throw new Error(method)
    },
    async close() {},
  }
}

describe('MCP resource tools', () => {
  test('list and read across named bridges', async () => {
    const bridge = createMcpToolBridge(fakeTransport())
    const [list, read] = createMcpResourceTools([{ name: 'notes', bridge }])
    expect(list?.name).toBe('ListMcpResources')
    expect(read?.name).toBe('ReadMcpResource')
    expect(list?.isReadOnly({})).toBe(true)
    const listed = await list!.execute({}, {
      turn: {} as never,
      signal: new AbortController().signal,
      onProgress() {},
    })
    expect(listed).toContain('notes')
    expect(listed).toContain('memo://notes')
    const body = await read!.execute(
      { uri: 'memo://notes' },
      { turn: {} as never, signal: new AbortController().signal, onProgress() {} },
    )
    expect(body).toBe('hello resource')
  })
})
