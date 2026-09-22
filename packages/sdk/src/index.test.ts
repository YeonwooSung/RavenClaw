import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelProfile, Provider, ProviderChunk, ProviderRequest, StreamEvent } from '@ravenclaw/core'
import {
  applyPatchTool,
  bashTool,
  createLocalTerminalBackend,
  createMemoryStore,
  editTool,
  globTool,
  grepTool,
  listDirTool,
  readSubtreeTool,
  readTool,
  writeTool,
} from '@ravenclaw/core'
import { createRavenSession, createRootTools } from './index'

const ENV_KEYS = [
  'RAVENCLAW_HOME',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_BASE_URL',
  'OLLAMA_HOST',
  'OLLAMA_API_KEY',
  'VLLM_BASE_URL',
  'VLLM_API_KEY',
] as const

let savedEnv: Record<string, string | undefined>
const tempDirs: string[] = []

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-sdk-'))
  tempDirs.push(dir)
  return dir
}

function defaultModel(id = 'dummy'): ModelProfile {
  return {
    id,
    contextWindow: 32_000,
    reserveOutputTokens: 3_200,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
  }
}

function createFakeProvider(scripts: ProviderChunk[][]): Provider & {
  requests: ProviderRequest[]
} {
  const requests: ProviderRequest[] = []
  const queue = [...scripts]
  return {
    id: 'fake',
    apiMode: 'openai_compat',
    requests,
    profile(model: string) {
      return defaultModel(model)
    },
    async *stream(req: ProviderRequest) {
      requests.push(req)
      const script = queue.shift() ?? [{ type: 'stop', reason: null }]
      for (const chunk of script) yield chunk
    },
  }
}

async function collectSubmit(session: { submit: (prompt: string) => AsyncGenerator<StreamEvent> }, prompt: string) {
  const events: StreamEvent[] = []
  const gen = session.submit(prompt)
  while (true) {
    const next = await gen.next()
    if (next.done) return { events, end: next.value }
    events.push(next.value)
  }
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

describe('createRavenSession', () => {
  test('memory store + fake provider submits hi and collects text', async () => {
    const home = tempHome()
    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
        { type: 'stop', reason: 'end' },
      ],
    ])
    const session = await createRavenSession({
      cwd: home,
      home,
      provider,
      store: 'memory',
      tools: [],
    })
    const { events, end } = await collectSubmit(session, 'hi')
    const text = events
      .filter((event): event is Extract<StreamEvent, { type: 'text_delta' }> => event.type === 'text_delta')
      .map((event) => event.text)
      .join('')
    expect(text).toBe('Hello world')
    expect(end).toEqual({ reason: 'completed' })
    await session.close()
  })

  test('default tools include Read and Agent, not a CLI-only command', async () => {
    const home = tempHome()
    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', reason: 'end' },
      ],
    ])
    const session = await createRavenSession({
      cwd: home,
      home,
      provider,
      store: 'memory',
    })
    await collectSubmit(session, 'hi')
    const names = provider.requests[0]?.tools.map((tool) => tool.name) ?? []
    expect(names).toContain('Read')
    expect(names).toContain('Agent')
    expect(names).not.toContain('help')
    expect(names).not.toContain('exec')
    expect(names).not.toContain('doctor')
    expect(names.some((name) => name.startsWith('mcp_'))).toBe(false)
    await session.close()
  })

  test('missing provider + no keys throws a setup hint', async () => {
    const home = tempHome()
    await expect(createRavenSession({ cwd: home, home })).rejects.toThrow(
      /config\.yaml|API key|provider/i,
    )
  })
})

describe('createRootTools', () => {
  test('with a backend does not reuse the Grep/Glob singletons', () => {
    const backend = createLocalTerminalBackend()
    const tools = createRootTools(createMemoryStore(), bashTool, false, backend)
    expect(tools.find((tool) => tool.name === 'Grep')).not.toBe(grepTool)
    expect(tools.find((tool) => tool.name === 'Glob')).not.toBe(globTool)
  })

  test('without a backend keeps the Grep/Glob singletons', () => {
    const tools = createRootTools(createMemoryStore())
    expect(tools.find((tool) => tool.name === 'Grep')).toBe(grepTool)
    expect(tools.find((tool) => tool.name === 'Glob')).toBe(globTool)
  })

  test('createRootTools with a backend does not reuse the file-tool singletons', () => {
    const backend = createLocalTerminalBackend()
    const tools = createRootTools(createMemoryStore(), bashTool, false, backend)
    expect(tools.find((tool) => tool.name === 'Read')).not.toBe(readTool)
    expect(tools.find((tool) => tool.name === 'Write')).not.toBe(writeTool)
    expect(tools.find((tool) => tool.name === 'Edit')).not.toBe(editTool)
    expect(tools.find((tool) => tool.name === 'ApplyPatch')).not.toBe(applyPatchTool)
    expect(tools.find((tool) => tool.name === 'ListDir')).not.toBe(listDirTool)
    expect(tools.find((tool) => tool.name === 'ReadSubtree')).not.toBe(readSubtreeTool)
  })

  test('createRootTools without a backend keeps the file-tool singletons', () => {
    const tools = createRootTools(createMemoryStore())
    expect(tools.find((tool) => tool.name === 'Read')).toBe(readTool)
    expect(tools.find((tool) => tool.name === 'Write')).toBe(writeTool)
    expect(tools.find((tool) => tool.name === 'Edit')).toBe(editTool)
    expect(tools.find((tool) => tool.name === 'ApplyPatch')).toBe(applyPatchTool)
    expect(tools.find((tool) => tool.name === 'ListDir')).toBe(listDirTool)
    expect(tools.find((tool) => tool.name === 'ReadSubtree')).toBe(readSubtreeTool)
  })

  test('omits NotebookEdit with and without a backend', () => {
    const unnamed = createRootTools(createMemoryStore()).map((tool) => tool.name)
    expect(unnamed).not.toContain('NotebookEdit')
    const named = createRootTools(
      createMemoryStore(),
      bashTool,
      false,
      createLocalTerminalBackend(),
    ).map((tool) => tool.name)
    expect(named).not.toContain('NotebookEdit')
  })
})

describe('sdk isolation', () => {
  test('does not import @ravenclaw/cli or ink', () => {
    const root = join(import.meta.dir, '..')
    const pkg = readFileSync(join(root, 'package.json'), 'utf8')
    expect(pkg).not.toContain('@ravenclaw/cli')
    expect(pkg).not.toContain('"ink"')

    const files = walk(join(root, 'src')).filter(
      (path) => path.endsWith('.ts') && !path.endsWith('.test.ts'),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      expect(text).not.toMatch(/@ravenclaw\/cli/)
      expect(text).not.toMatch(/from ['"]ink['"]/)
    }
  })
})
