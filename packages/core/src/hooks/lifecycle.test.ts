import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LIFECYCLE_EVENTS,
  collectHookCommands,
  loadLifecycleHooks,
  matchesToolIf,
} from './lifecycle'

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

describe('loadLifecycleHooks', () => {
  test('missing files and invalid JSON yield no-op run', async () => {
    const home = tempDir('ravenclaw-life-home-')
    const cwd = tempDir('ravenclaw-life-cwd-')
    writeFileSync(join(home, 'hooks.json'), '{not json', 'utf8')
    const hooks = loadLifecycleHooks(cwd, home)
    expect(await hooks.run('PostToolUse', { name: 'Bash' })).toBeUndefined()
    expect(await hooks.run('UserPromptSubmit', { text: 'hi' })).toBeUndefined()
    expect(collectHookCommands(cwd, 'PreToolUse', home)).toEqual([])
  })

  test('script receives payload on stdin and echoes JSON', async () => {
    const home = tempDir('ravenclaw-life-script-')
    const cwd = tempDir('ravenclaw-life-script-cwd-')
    const script = join(home, 'hook.mjs')
    writeFileSync(
      script,
      `import { readFileSync } from 'node:fs'
const payload = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify({
  message: \`saw:\${payload.name}\`,
  preventContinuation: payload.stop === true,
}))
`,
      'utf8',
    )
    writeHooks(home, {
      PostToolUse: [{ command: `bun "${script}"` }],
    })
    const hooks = loadLifecycleHooks(cwd, home)
    expect(await hooks.run('PostToolUse', { name: 'Bash', output: 'ok' })).toEqual({
      message: 'saw:Bash',
    })
    expect(await hooks.run('PostToolUse', { name: 'Read', stop: true })).toEqual({
      preventContinuation: true,
      message: 'saw:Read',
    })
  })

  test('each lifecycle event loads its own commands', async () => {
    const home = tempDir('ravenclaw-life-events-')
    const cwd = tempDir('ravenclaw-life-events-cwd-')
    const body: Record<string, unknown> = {}
    for (const event of LIFECYCLE_EVENTS) {
      body[event] = [{ command: `printf '%s' '{"message":"${event}"}'` }]
    }
    writeHooks(home, body)
    const hooks = loadLifecycleHooks(cwd, home)
    for (const event of LIFECYCLE_EVENTS) {
      expect(await hooks.run(event, {})).toEqual({ message: event })
    }
  })

  test('pre_tool aliases PreToolUse', async () => {
    const home = tempDir('ravenclaw-life-alias-')
    const cwd = tempDir('ravenclaw-life-alias-cwd-')
    writeHooks(home, {
      pre_tool: [{ command: `printf '%s' '{"behavior":"deny","message":"legacy"}'` }],
    })
    const hooks = loadLifecycleHooks(cwd, home)
    expect(collectHookCommands(cwd, 'PreToolUse', home)).toHaveLength(1)
    expect(await hooks.run('PreToolUse', { name: 'Bash' })).toEqual({
      preventContinuation: true,
      message: 'legacy',
    })
  })

  test('if skips when payload.name does not match', async () => {
    const home = tempDir('ravenclaw-life-if-')
    const cwd = tempDir('ravenclaw-life-if-cwd-')
    writeHooks(home, {
      PostToolUse: [
        { command: `printf '%s' '{"message":"bash"}'`, if: 'Bash' },
        { command: `printf '%s' '{"message":"star"}'`, if: 'Read(*)' },
      ],
    })
    const hooks = loadLifecycleHooks(cwd, home)
    expect(await hooks.run('PostToolUse', { name: 'Write' })).toBeUndefined()
    expect(await hooks.run('PostToolUse', { name: 'Bash' })).toEqual({ message: 'bash' })
    expect(await hooks.run('PostToolUse', { name: 'Read' })).toEqual({ message: 'star' })
  })

  test('preventContinuation stops later hooks', async () => {
    const home = tempDir('ravenclaw-life-stop-')
    const cwd = tempDir('ravenclaw-life-stop-cwd-')
    writeHooks(home, {
      Stop: [{ command: `printf '%s' '{"preventContinuation":true,"message":"home"}'` }],
    })
    writeHooks(join(cwd, '.ravenclaw'), {
      Stop: [{ command: `printf '%s' '{"message":"project"}'` }],
    })
    const hooks = loadLifecycleHooks(cwd, home)
    expect(await hooks.run('Stop', {})).toEqual({
      preventContinuation: true,
      message: 'home',
    })
  })

  test('user hooks run before project hooks', async () => {
    const home = tempDir('ravenclaw-life-order-')
    const cwd = tempDir('ravenclaw-life-order-cwd-')
    writeHooks(home, {
      UserPromptSubmit: [{ command: `printf '%s' '{"message":"home"}'` }],
    })
    writeHooks(join(cwd, '.ravenclaw'), {
      UserPromptSubmit: [{ command: `printf '%s' '{"message":"project"}'` }],
    })
    const hooks = loadLifecycleHooks(cwd, home)
    expect(await hooks.run('UserPromptSubmit', { text: 'go' })).toEqual({
      message: 'project',
    })
  })

  test('invalid stdout and timeout are void', async () => {
    const home = tempDir('ravenclaw-life-void-')
    const cwd = tempDir('ravenclaw-life-void-cwd-')
    writeHooks(home, {
      SessionEnd: [
        { command: `printf '%s' 'not-json'` },
        { command: 'sleep 10' },
      ],
    })
    const hooks = loadLifecycleHooks(cwd, home)
    expect(await hooks.run('SessionEnd', {})).toBeUndefined()
  }, 15_000)

  test('empty stdout is void', async () => {
    const home = tempDir('ravenclaw-life-empty-')
    const cwd = tempDir('ravenclaw-life-empty-cwd-')
    writeHooks(home, {
      SessionStart: [{ command: 'true' }],
    })
    const hooks = loadLifecycleHooks(cwd, home)
    expect(await hooks.run('SessionStart', {})).toBeUndefined()
  })
})

describe('matchesToolIf', () => {
  test('unset matches any name; Bash and Bash(*) match Bash only', () => {
    expect(matchesToolIf(undefined, 'Bash')).toBe(true)
    expect(matchesToolIf('', 'Read')).toBe(true)
    expect(matchesToolIf('Bash', 'Bash')).toBe(true)
    expect(matchesToolIf('Bash(*)', 'Bash')).toBe(true)
    expect(matchesToolIf('Bash', 'Read')).toBe(false)
    expect(matchesToolIf('Bash(*)', 'Read')).toBe(false)
    expect(matchesToolIf('Bash', undefined)).toBe(false)
  })
})
