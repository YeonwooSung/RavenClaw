import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LEARN_PROMPT,
  NO_EXTRA_RULES_NOTICE,
  RELOAD_NOTICE,
  SLASH_COMMANDS,
  SLASH_HELP,
  TASKS_NOTICE,
  formatContextNotice,
  formatPermissionsNotice,
  handleSlashCommand,
} from './commands'

describe('handleSlashCommand', () => {
  test('plain text is a prompt', () => {
    expect(handleSlashCommand('list the files')).toEqual({
      type: 'prompt',
      text: 'list the files',
    })
  })

  test('trims surrounding whitespace on prompts', () => {
    expect(handleSlashCommand('  hello  ')).toEqual({
      type: 'prompt',
      text: 'hello',
    })
  })

  test.each([
    ['/resume', { type: 'command', name: 'resume' }],
    ['/resume abc123', { type: 'command', name: 'resume', arg: 'abc123' }],
    ['/compact', { type: 'command', name: 'compact' }],
    ['/mode plan', { type: 'command', name: 'mode', arg: 'plan' }],
    ['/cost', { type: 'command', name: 'cost' }],
    ['/search', { type: 'command', name: 'search' }],
    ['/search foo', { type: 'command', name: 'search', arg: 'foo' }],
    ['/search --all bar', { type: 'command', name: 'search', arg: '--all bar' }],
    ['/quit', { type: 'command', name: 'quit' }],
    ['/learn', { type: 'command', name: 'learn' }],
    ['/review', { type: 'command', name: 'review' }],
    ['/title Fix login', { type: 'command', name: 'title', arg: 'Fix login' }],
    ['/help', { type: 'command', name: 'help' }],
    ['/?', { type: 'command', name: 'help' }],
    ['/clear', { type: 'command', name: 'clear' }],
    ['/new', { type: 'command', name: 'clear' }],
    ['/model', { type: 'command', name: 'model' }],
    ['/model anthropic/claude-sonnet-4', { type: 'command', name: 'model', arg: 'anthropic/claude-sonnet-4' }],
    ['/permissions', { type: 'command', name: 'permissions' }],
    ['/tasks', { type: 'command', name: 'tasks' }],
    ['/tasks kill b_abc', { type: 'command', name: 'tasks', arg: 'kill b_abc' }],
    ['/undo', { type: 'command', name: 'undo' }],
    ['/reload', { type: 'command', name: 'reload' }],
    ['/mcp', { type: 'command', name: 'mcp' }],
    ['/skills', { type: 'command', name: 'skills' }],
    ['/cron', { type: 'command', name: 'cron' }],
    ['/cron add every 30m lint', { type: 'command', name: 'cron', arg: 'add every 30m lint' }],
    ['/config', { type: 'command', name: 'config' }],
    ['/context', { type: 'command', name: 'context' }],
  ] as const)('%s', (line, expected) => {
    expect(handleSlashCommand(line)).toEqual(expected)
  })

  test('unknown slash stays a command so the app can reject it', () => {
    expect(handleSlashCommand('/nope')).toEqual({ type: 'command', name: 'nope' })
  })

  test('SLASH_HELP is generated from the command table', () => {
    for (const command of SLASH_COMMANDS) {
      expect(SLASH_HELP).toContain(command.usage)
      expect(SLASH_HELP).toContain(command.summary)
    }
    expect(SLASH_HELP.split('\n')).toHaveLength(SLASH_COMMANDS.length)
  })

  test('SLASH_HELP lists the in-session commands', () => {
    expect(SLASH_HELP).toContain('/resume')
    expect(SLASH_HELP).toContain('/search')
    expect(SLASH_HELP).toContain('/help')
    expect(SLASH_HELP).toContain('/review')
    expect(SLASH_HELP).toContain('/title')
    expect(SLASH_HELP).toContain('/quit')
    expect(SLASH_HELP).toContain('/clear')
    expect(SLASH_HELP).toContain('/model')
    expect(SLASH_HELP).toContain('/permissions')
    expect(SLASH_HELP).toContain('/tasks')
    expect(SLASH_HELP).toContain('/undo')
    expect(SLASH_HELP).toContain('/reload')
    expect(SLASH_HELP).toContain('/mcp')
    expect(SLASH_HELP).toContain('/skills')
    expect(SLASH_HELP).toContain('/cron')
    expect(SLASH_HELP).toContain('/config')
    expect(SLASH_HELP).toContain('/context')
  })

  test('table includes existing commands plus the new session commands', () => {
    const names = SLASH_COMMANDS.map((command) => command.name)
    expect(names).toEqual([
      'resume',
      'compact',
      'cost',
      'search',
      'mode',
      'learn',
      'review',
      'title',
      'cancel',
      'clear',
      'model',
      'permissions',
      'tasks',
      'undo',
      'reload',
      'mcp',
      'skills',
      'cron',
      'config',
      'context',
      'help',
      'quit',
    ])
    expect(SLASH_COMMANDS.find((command) => command.name === 'clear')?.aliases).toContain('new')
    expect(SLASH_COMMANDS.find((command) => command.name === 'help')?.aliases).toContain('?')
  })

  test('learn prompt asks to write a skill, and is not a tool name', () => {
    expect(LEARN_PROMPT).toContain('SKILL.md')
    expect(LEARN_PROMPT.toLowerCase()).toContain('write a new skill')
    expect(handleSlashCommand('/learn')).toEqual({ type: 'command', name: 'learn' })
  })
})

describe('slash status helpers', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('context notice includes compact generation and message count', () => {
    expect(formatContextNotice(3, 12)).toBe('compact 3  messages 12')
  })

  test('tasks and reload notices are one-liners', () => {
    expect(TASKS_NOTICE).toBe('no background tasks')
    expect(RELOAD_NOTICE).toBe('skills reloaded')
  })

  test('permissions notice lists existing rule files or no extra rules', () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-perm-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-perm-cwd-'))
    tempDirs.push(home, cwd)
    expect(
      formatPermissionsNotice({
        home,
        cwd,
        sessionRuleCount: 0,
      }),
    ).toBe(NO_EXTRA_RULES_NOTICE)

    const userPath = join(home, 'permissions.json')
    const projectPath = join(cwd, '.ravenclaw', 'permissions.json')
    mkdirSync(join(cwd, '.ravenclaw'), { recursive: true })
    writeFileSync(userPath, '[]')
    writeFileSync(projectPath, '[]')
    expect(
      formatPermissionsNotice({
        home,
        cwd,
        sessionRuleCount: 2,
      }),
    ).toBe(`${userPath}\n${projectPath}\nsession  2 rules`)
  })
})
