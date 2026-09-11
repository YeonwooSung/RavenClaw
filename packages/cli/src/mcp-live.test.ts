import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMemoryStore, mergeToolPool, type ToolContext, type Turn } from '@ravenclaw/core'
import { createRootTools } from './engine'
import { loadConfiguredMcpTools } from './mcp'

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-echo-server.ts')

function makeTurn(): Turn {
  return {
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
    cwd: process.cwd(),
    model: 'dummy',
    readFiles: new Set(),
  }
}

function makeCtx(): ToolContext {
  const turn = makeTurn()
  return { turn, signal: turn.abort.signal, onProgress() {} }
}

describe('loadConfiguredMcpTools live stdio', () => {
  test(
    'spawns the echo fixture and executes echo_n',
    async () => {
      const loaded = await loadConfiguredMcpTools([
        { name: 'echo', command: process.execPath, args: [fixturePath] },
      ])
      try {
        expect(loaded.tools.map((tool) => tool.name)).toContain('echo_n')

        const builtins = createRootTools(createMemoryStore())
        const merged = mergeToolPool(builtins, loaded.tools)
        expect(merged.map((tool) => tool.name)).toContain('echo_n')

        const tool = loaded.tools.find((candidate) => candidate.name === 'echo_n')
        if (!tool) throw new Error('expected echo_n')
        const output = await tool.execute({ text: 'ping' }, makeCtx())
        expect(String(output)).toContain('ping')
      } finally {
        await loaded.close()
      }
    },
    { timeout: 10_000 },
  )
})
