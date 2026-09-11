import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMemoryStore, mergeToolPool, type ToolContext, type Turn } from '@ravenclaw/core'
import { createRootTools } from './engine'
import { loadConfiguredMcpTools } from './mcp'

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-fs-server.ts')

function makeCtx(cwd: string): ToolContext {
  const turn: Turn = {
    id: 'turn_1',
    sessionId: 'sess_1',
    messages: [],
    round: 1,
    maxRounds: 80,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd,
    model: 'dummy',
    readFiles: new Set(),
  }
  return { turn, signal: turn.abort.signal, onProgress() {} }
}

describe('loadConfiguredMcpTools filesystem fixture', () => {
  test(
    'lists and reads files under MCP_ROOT and rejects escape',
    async () => {
      const root = join(tmpdir(), `raven-mcp-fs-${Date.now()}`)
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'hello.txt'), 'hello from disk\n')

      const loaded = await loadConfiguredMcpTools([
        {
          name: 'fs',
          command: process.execPath,
          args: [fixturePath],
          env: { MCP_ROOT: root },
        },
      ])
      try {
        const names = loaded.tools.map((tool) => tool.name)
        expect(names).toContain('fs_list')
        expect(names).toContain('fs_read')
        expect(mergeToolPool(createRootTools(createMemoryStore()), loaded.tools).map((t) => t.name)).toContain(
          'fs_read',
        )

        const ctx = makeCtx(root)
        const list = loaded.tools.find((tool) => tool.name === 'fs_list')
        const read = loaded.tools.find((tool) => tool.name === 'fs_read')
        if (!list || !read) throw new Error('expected fs tools')

        expect(String(await list.execute({ path: '.' }, ctx))).toContain('hello.txt')
        expect(String(await read.execute({ path: 'hello.txt' }, ctx))).toContain('hello from disk')

        let escaped = ''
        try {
          escaped = String(await read.execute({ path: '../secret' }, ctx))
        } catch (error) {
          escaped = error instanceof Error ? error.message : String(error)
        }
        expect(escaped.toLowerCase()).toMatch(/escape|error/)
      } finally {
        await loaded.close()
      }
    },
    { timeout: 10_000 },
  )
})
