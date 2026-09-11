import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { decidePermission } from '../permissions/pipeline'
import { loadLocalPlugins } from './load'

const ENV_KEY = 'RAVENCLAW_HOME'
let savedHome: string | undefined
const tempDirs: string[] = []

beforeEach(() => {
  savedHome = process.env[ENV_KEY]
})

afterEach(() => {
  if (savedHome === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedHome
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writePlugin(
  root: string,
  dirName: string,
  manifest: unknown,
): void {
  const dir = join(root, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest), 'utf8')
}

function makeTurn(cwd: string): Turn {
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
    cwd,
    model: 'dummy',
    readFiles: new Set(),
  }
}

function makeCtx(cwd: string): ToolContext {
  const turn = makeTurn(cwd)
  return { turn, signal: turn.abort.signal, onProgress() {} }
}

describe('loadLocalPlugins', () => {
  test('discovers a project plugin that echoes JSON stdin', async () => {
    const cwd = tempDir('ravenclaw-plugin-echo-')
    writePlugin(join(cwd, '.ravenclaw', 'plugins'), 'echo', {
      name: 'echo',
      description: 'echo plugin',
      tools: [
        {
          name: 'EchoJson',
          description: 'echo stdin',
          command: '/bin/cat',
        },
      ],
    })

    expect(loadLocalPlugins(cwd)).toEqual([])

    const tools = loadLocalPlugins(cwd, undefined, { project: true })
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('EchoJson')
    expect(tools[0]?.description).toBe('echo stdin')
    expect(await tools[0]!.checkPermissions({}, makeCtx(cwd))).toEqual({
      behavior: 'ask',
      reason: 'user',
    })

    const result = await tools[0]!.execute({ hello: 'world' }, makeCtx(cwd))
    expect(result).toBe(JSON.stringify({ hello: 'world' }))
  })

  test('project plugin overrides a user plugin of the same name', async () => {
    const home = tempDir('ravenclaw-plugin-home-')
    const cwd = tempDir('ravenclaw-plugin-proj-')
    process.env[ENV_KEY] = home

    writePlugin(join(home, 'plugins'), 'echo', {
      name: 'echo',
      description: 'user echo',
      tools: [{ name: 'UserEcho', description: 'user', command: '/bin/cat' }],
    })
    writePlugin(join(cwd, '.ravenclaw', 'plugins'), 'echo', {
      name: 'echo',
      description: 'project echo',
      tools: [{ name: 'ProjectEcho', description: 'project', command: '/bin/cat' }],
    })

    expect(loadLocalPlugins(cwd).map((tool) => tool.name)).toEqual(['UserEcho'])
    expect(loadLocalPlugins(cwd, undefined, { project: true }).map((tool) => tool.name)).toEqual([
      'ProjectEcho',
    ])
  })

  test('skips invalid manifests and keeps valid plugins', () => {
    const cwd = tempDir('ravenclaw-plugin-skip-')
    const root = join(cwd, '.ravenclaw', 'plugins')
    mkdirSync(join(root, 'bad-json'), { recursive: true })
    writeFileSync(join(root, 'bad-json', 'plugin.json'), '{not json', 'utf8')
    writePlugin(root, 'no-name', { description: 'missing name', tools: [] })
    writePlugin(root, 'good', {
      name: 'good',
      description: 'ok',
      tools: [{ name: 'GoodTool', description: 'ok', command: '/bin/cat' }],
    })

    const tools = loadLocalPlugins(cwd, undefined, { project: true })
    expect(tools.map((tool) => tool.name)).toEqual(['GoodTool'])
  })

  test('dontAsk denies a leftover plugin ask', async () => {
    const cwd = tempDir('ravenclaw-plugin-deny-')
    writePlugin(join(cwd, '.ravenclaw', 'plugins'), 'echo', {
      name: 'echo',
      description: 'echo plugin',
      tools: [{ name: 'EchoJson', description: 'echo stdin', command: '/bin/cat' }],
    })
    const tool = loadLocalPlugins(cwd, undefined, { project: true })[0]
    if (!tool) throw new Error('expected plugin tool')
    const decision = await decidePermission({
      name: tool.name,
      input: {},
      tool,
      ctx: makeCtx(cwd),
      mode: 'dontAsk',
      rules: { session: [], user: [], project: [] },
    })
    expect(decision.behavior).toBe('deny')
    expect(decision.reason).toBe('mode')
  })
})
