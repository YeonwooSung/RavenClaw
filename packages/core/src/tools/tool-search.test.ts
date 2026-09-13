import { describe, expect, test } from 'bun:test'
import type { Tool, ToolContext, Turn } from '../types'
import { filterToolsForTurn } from './skill'
import { createToolSearchTool } from './tool-search'

function stubTool(name: string, description: string): Tool {
  return {
    name,
    description,
    inputSchema: {},
    parse() {
      return { ok: true, value: {} }
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
    async execute() {
      return ''
    },
  }
}

function makeCtx(signal?: AbortSignal): ToolContext {
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
    cwd: '/tmp',
    model: 'dummy',
    readFiles: new Set(),
  }
  return {
    turn,
    signal: signal ?? turn.abort.signal,
    onProgress() {},
  }
}

const longDesc =
  'Replace exactly one unique occurrence of old_string with new_string in a utf-8 file. path is resolved relative to the turn cwd.'

const pool = [
  stubTool('Read', 'Read a utf-8 text file or a small image'),
  stubTool('Edit', longDesc),
  stubTool('Write', 'Create or overwrite a utf-8 file'),
  stubTool('Bash', 'Run a shell command in the project'),
  stubTool('Grep', 'Search file contents with a regular expression'),
  stubTool('Glob', 'Find files by glob pattern'),
]

function searchTool(pool: Tool[]) {
  return createToolSearchTool({ deferred: pool })
}

describe('ToolSearch', () => {
  const tool = searchTool(pool)

  test('is a concurrency-safe read-only tool that allows by mode', async () => {
    expect(tool.name).toBe('ToolSearch')
    expect(tool.isConcurrencySafe({ query: 'read' })).toBe(true)
    expect(tool.isReadOnly({ query: 'read' })).toBe(true)
    expect(tool.interruptBehavior?.()).toBe('cancel')
    const decision = await tool.checkPermissions({ query: 'read' }, makeCtx())
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('parse requires a non-empty query', () => {
    expect(tool.parse({ query: 'edit' }).ok).toBe(true)
    expect(tool.parse({ query: 'edit', max_results: 3 }).ok).toBe(true)
    expect(tool.parse({}).ok).toBe(false)
    expect(tool.parse({ query: '' }).ok).toBe(false)
    expect(tool.parse({ query: 'x', max_results: 0 }).ok).toBe(false)
  })

  test('select: returns existing names from the pool', async () => {
    const ctx = makeCtx()
    const selecting = searchTool(pool)
    const out = await selecting.execute({ query: 'select:Edit,Missing,bash' }, ctx)
    const lines = out.split('\n')
    expect(lines[0]?.startsWith('Edit — ')).toBe(true)
    expect(lines[1]?.startsWith('Bash — ')).toBe(true)
    expect(out).not.toContain('Missing')
    expect(lines[lines.length - 1]).toBe('total 4 deferred')
    expect(ctx.turn.unlockedToolNames).toBeUndefined()
  })

  test('select does not unlock deferred tools onto the filter/wire prefix', async () => {
    const mcp = stubTool('mcp_ping', 'Ping a deferred MCP server')
    mcp.isEnabled = (ctx) => ctx.turn.unlockedToolNames?.includes('mcp_ping') === true
    const ctx = makeCtx()
    const search = searchTool([mcp])
    const catalog = [search, mcp]
    expect(filterToolsForTurn(catalog, ctx.turn).map((tool) => tool.name)).toEqual(['ToolSearch'])
    const out = await search.execute({ query: 'select:mcp_ping' }, ctx)
    expect(out).toContain('mcp_ping — ')
    expect(out.endsWith('total 0 deferred')).toBe(true)
    expect(ctx.turn.unlockedToolNames).toBeUndefined()
    expect(filterToolsForTurn(catalog, ctx.turn).map((tool) => tool.name)).toEqual(['ToolSearch'])
  })

  test('keyword match is case-insensitive on name and description', async () => {
    const out = await tool.execute({ query: 'GLOB' }, makeCtx())
    expect(out).toContain('Glob — ')
    const byDesc = await tool.execute({ query: 'regular expression' }, makeCtx())
    expect(byDesc).toContain('Grep — ')
    expect(byDesc).toContain('total 6 deferred')
  })

  test('caps keyword results at max_results default 5', async () => {
    const defaulted = await tool.execute({ query: 'e' }, makeCtx())
    const defaultLines = defaulted.split('\n').filter((line) => line.includes(' — '))
    expect(defaultLines.length).toBeLessThanOrEqual(5)
    const capped = await tool.execute({ query: 'e', max_results: 2 }, makeCtx())
    const cappedLines = capped.split('\n').filter((line) => line.includes(' — '))
    expect(cappedLines).toHaveLength(2)
    expect(capped.endsWith('total 6 deferred')).toBe(true)
  })

  test('truncates the description to 80 characters', async () => {
    const out = await tool.execute({ query: 'Edit' }, makeCtx())
    const line = out.split('\n').find((row) => row.startsWith('Edit — '))
    expect(line).toBeDefined()
    const desc = line?.slice('Edit — '.length) ?? ''
    expect(desc.length).toBe(80)
    expect(desc).toBe(longDesc.slice(0, 80))
  })

  test('execute refuses when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(tool.execute({ query: 'read' }, makeCtx(ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
