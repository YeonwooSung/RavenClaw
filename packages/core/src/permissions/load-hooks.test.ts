import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPermissionHooks } from './hooks'
import { loadFileHooks } from './load-hooks'

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

function writeHooks(dir: string, body: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'hooks.json'), `${JSON.stringify(body)}\n`, 'utf8')
}

describe('loadFileHooks', () => {
  test('missing files yield no hooks', () => {
    const home = tempDir('ravenclaw-hooks-home-')
    const cwd = tempDir('ravenclaw-hooks-cwd-')
    process.env[ENV_KEY] = home
    expect(loadFileHooks(cwd)).toEqual([])
  })

  test('invalid JSON and empty pre_tool yield no hooks', () => {
    const home = tempDir('ravenclaw-hooks-bad-')
    const cwd = tempDir('ravenclaw-hooks-empty-')
    process.env[ENV_KEY] = home
    writeFileSync(join(home, 'hooks.json'), '{not json', 'utf8')
    writeHooks(join(cwd, '.ravenclaw'), { pre_tool: [] })
    expect(loadFileHooks(cwd)).toEqual([])
  })

  test('pre_tool command allow/deny/empty stdout', async () => {
    const home = tempDir('ravenclaw-hooks-cmd-')
    const cwd = tempDir('ravenclaw-hooks-cmd-cwd-')
    process.env[ENV_KEY] = home
    writeHooks(home, {
      pre_tool: [{ command: `printf '%s' '{"behavior":"allow"}'` }],
    })
    writeHooks(join(cwd, '.ravenclaw'), {
      pre_tool: [
        { command: `printf '%s' '{"behavior":"deny","message":"blocked"}'` },
        { command: 'true' },
      ],
    })

    const hooks = loadFileHooks(cwd)
    expect(hooks).toHaveLength(3)
    expect(await hooks[0]!({ name: 'Bash', input: { command: 'ls' } })).toEqual({
      behavior: 'allow',
      reason: 'hook',
    })
    expect(await hooks[1]!({ name: 'Bash', input: { command: 'ls' } })).toEqual({
      behavior: 'deny',
      reason: 'hook',
      message: 'blocked',
    })
    expect(await hooks[2]!({ name: 'Read', input: { path: 'a' } })).toBeUndefined()
  })

  test('invalid stdout and timeout are void', async () => {
    const home = tempDir('ravenclaw-hooks-void-')
    const cwd = tempDir('ravenclaw-hooks-void-cwd-')
    process.env[ENV_KEY] = home
    writeHooks(home, {
      pre_tool: [
        { command: `printf '%s' 'not-json'` },
        { command: 'sleep 10' },
      ],
    })
    const hooks = loadFileHooks(cwd)
    expect(hooks).toHaveLength(2)
    expect(await hooks[0]!({ name: 'Bash', input: {} })).toBeUndefined()
    expect(await hooks[1]!({ name: 'Bash', input: {} })).toBeUndefined()
  }, 15_000)

  test('command receives JSON { name, input } on stdin', async () => {
    const home = tempDir('ravenclaw-hooks-stdin-')
    const cwd = tempDir('ravenclaw-hooks-stdin-cwd-')
    process.env[ENV_KEY] = home
    const script = join(home, 'hook.mjs')
    writeFileSync(
      script,
      `import { readFileSync } from 'node:fs'
const info = JSON.parse(readFileSync(0, 'utf8'))
const ok = info.name === 'Bash' && info.input && info.input.command === 'rm -rf /'
process.stdout.write(JSON.stringify(ok
  ? { behavior: 'deny', message: 'dangerous' }
  : { behavior: 'allow' }))
`,
      'utf8',
    )
    writeHooks(home, { pre_tool: [{ command: `bun "${script}"` }] })
    const [hook] = loadFileHooks(cwd)
    expect(hook).toBeDefined()
    expect(await hook!({ name: 'Bash', input: { command: 'rm -rf /' } })).toEqual({
      behavior: 'deny',
      reason: 'hook',
      message: 'dangerous',
    })
  })

  test('user hooks run before project hooks', async () => {
    const home = tempDir('ravenclaw-hooks-order-home-')
    const cwd = tempDir('ravenclaw-hooks-order-cwd-')
    process.env[ENV_KEY] = home
    writeHooks(home, {
      pre_tool: [{ command: `printf '%s' '{"behavior":"allow"}'` }],
    })
    writeHooks(join(cwd, '.ravenclaw'), {
      pre_tool: [{ command: `printf '%s' '{"behavior":"deny","message":"project"}'` }],
    })
    const hooks = loadFileHooks(cwd)
    expect(await runPermissionHooks(hooks, { name: 'Bash', input: {} })).toEqual({
      behavior: 'deny',
      reason: 'hook',
      message: 'project',
    })
  })

  test('PreToolUse aliases pre_tool', async () => {
    const home = tempDir('ravenclaw-hooks-alias-')
    const cwd = tempDir('ravenclaw-hooks-alias-cwd-')
    process.env[ENV_KEY] = home
    writeHooks(home, {
      PreToolUse: [{ command: `printf '%s' '{"behavior":"deny","message":"pascal"}'` }],
    })
    const hooks = loadFileHooks(cwd)
    expect(hooks).toHaveLength(1)
    expect(await hooks[0]!({ name: 'Bash', input: {} })).toEqual({
      behavior: 'deny',
      reason: 'hook',
      message: 'pascal',
    })
  })

  test('pre_tool and PreToolUse both become permission hooks', async () => {
    const home = tempDir('ravenclaw-hooks-both-')
    const cwd = tempDir('ravenclaw-hooks-both-cwd-')
    process.env[ENV_KEY] = home
    writeHooks(home, {
      pre_tool: [{ command: `printf '%s' '{"behavior":"allow"}'` }],
      PreToolUse: [{ command: `printf '%s' '{"behavior":"deny","message":"second"}'` }],
    })
    const hooks = loadFileHooks(cwd)
    expect(hooks).toHaveLength(2)
    expect(await hooks[0]!({ name: 'Bash', input: {} })).toEqual({
      behavior: 'allow',
      reason: 'hook',
    })
    expect(await hooks[1]!({ name: 'Bash', input: {} })).toEqual({
      behavior: 'deny',
      reason: 'hook',
      message: 'second',
    })
  })

  test('if skips non-matching tool names and Bash(*) matches Bash', async () => {
    const home = tempDir('ravenclaw-hooks-if-')
    const cwd = tempDir('ravenclaw-hooks-if-cwd-')
    process.env[ENV_KEY] = home
    writeHooks(home, {
      pre_tool: [
        { command: `printf '%s' '{"behavior":"deny","message":"bash"}'`, if: 'Bash' },
        { command: `printf '%s' '{"behavior":"deny","message":"star"}'`, if: 'Bash(*)' },
        { command: `printf '%s' '{"behavior":"allow"}'`, if: 'Read' },
      ],
    })
    const hooks = loadFileHooks(cwd)
    expect(hooks).toHaveLength(3)
    expect(await hooks[0]!({ name: 'Read', input: {} })).toBeUndefined()
    expect(await hooks[0]!({ name: 'Bash', input: {} })).toEqual({
      behavior: 'deny',
      reason: 'hook',
      message: 'bash',
    })
    expect(await hooks[1]!({ name: 'Bash', input: {} })).toEqual({
      behavior: 'deny',
      reason: 'hook',
      message: 'star',
    })
    expect(await hooks[2]!({ name: 'Bash', input: {} })).toBeUndefined()
    expect(await hooks[2]!({ name: 'Read', input: {} })).toEqual({
      behavior: 'allow',
      reason: 'hook',
    })
  })
})
