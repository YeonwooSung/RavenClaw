import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CREW_LIST_NOTICE,
  CREW_PRESET_TEXT,
  CREW_SHARED,
  LEARN_PROMPT,
  NO_EXTRA_RULES_NOTICE,
  ONBOARDING_PROMPT,
  RELOAD_NOTICE,
  SLASH_COMMANDS,
  SLASH_HELP,
  TASKS_NOTICE,
  formatContextNotice,
  formatCrewTurn,
  formatOnboardingTurn,
  formatPermissionsNotice,
  handleSlashCommand,
  parseCrewArg,
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
    ['/stop', { type: 'command', name: 'stop' }],
    ['/cancel', { type: 'command', name: 'stop' }],
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
    ['/tasks steer t_1 hello', { type: 'command', name: 'tasks', arg: 'steer t_1 hello' }],
    ['/undo', { type: 'command', name: 'undo' }],
    ['/rewind', { type: 'command', name: 'rewind' }],
    ['/diff', { type: 'command', name: 'diff' }],
    ['/diff 2', { type: 'command', name: 'diff', arg: '2' }],
    ['/diff close', { type: 'command', name: 'diff', arg: 'close' }],
    ['/steer keep going', { type: 'command', name: 'steer', arg: 'keep going' }],
    ['/add-dir ../pkg', { type: 'command', name: 'add-dir', arg: '../pkg' }],
    ['/effort high', { type: 'command', name: 'effort', arg: 'high' }],
    ['/agents', { type: 'command', name: 'agents' }],
    ['/hooks', { type: 'command', name: 'hooks' }],
    ['/reload', { type: 'command', name: 'reload' }],
    ['/mcp', { type: 'command', name: 'mcp' }],
    ['/skills', { type: 'command', name: 'skills' }],
    ['/skills show review', { type: 'command', name: 'skills', arg: 'show review' }],
    ['/loop 3 fix tests', { type: 'command', name: 'loop', arg: '3 fix tests' }],
    ['/cron', { type: 'command', name: 'cron' }],
    ['/cron add every 30m lint', { type: 'command', name: 'cron', arg: 'add every 30m lint' }],
    ['/queue', { type: 'command', name: 'queue' }],
    ['/follow', { type: 'command', name: 'follow' }],
    ['/follow run tests', { type: 'command', name: 'follow', arg: 'run tests' }],
    ['/follow clear', { type: 'command', name: 'follow', arg: 'clear' }],
    ['/retry', { type: 'command', name: 'retry' }],
    ['/retry new text', { type: 'command', name: 'retry', arg: 'new text' }],
    ['/copy', { type: 'command', name: 'copy' }],
    ['/interview', { type: 'command', name: 'interview' }],
    ['/team-onboarding', { type: 'command', name: 'team-onboarding' }],
    ['/onboard', { type: 'command', name: 'team-onboarding' }],
    ['/crew', { type: 'command', name: 'crew' }],
    ['/CREW research', { type: 'command', name: 'crew', arg: 'research' }],
    ['/crew REVIEW ship  it', { type: 'command', name: 'crew', arg: 'REVIEW ship  it' }],
    ['/bash echo hi', { type: 'command', name: 'bash', arg: 'echo hi' }],
    ['/skill:foo', { type: 'command', name: 'skill', arg: 'foo' }],
    ['/config', { type: 'command', name: 'config' }],
    ['/context', { type: 'command', name: 'context' }],
  ] as const)('%s', (line, expected) => {
    expect(handleSlashCommand(line)).toEqual(expected)
  })

  test('unknown slash stays a command so the app can reject it', () => {
    expect(handleSlashCommand('/nope')).toEqual({ type: 'command', name: 'nope' })
  })

  test('/team is not an alias of /crew', () => {
    expect(handleSlashCommand('/team')).toEqual({ type: 'command', name: 'team' })
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
    expect(SLASH_HELP).toContain('/stop')
    expect(SLASH_HELP).toContain('/search')
    expect(SLASH_HELP).toContain('/help')
    expect(SLASH_HELP).toContain('/review')
    expect(SLASH_HELP).toContain('/title')
    expect(SLASH_HELP).toContain('/quit')
    expect(SLASH_HELP).toContain('/clear')
    expect(SLASH_HELP).toContain('/model')
    expect(SLASH_HELP).toContain('/permissions')
    expect(SLASH_HELP).toContain('/tasks')
    expect(SLASH_HELP).toContain('steer')
    expect(SLASH_HELP).toContain('/undo')
    expect(SLASH_HELP).toContain('/rewind')
    expect(SLASH_HELP).toContain('/diff')
    expect(SLASH_HELP).toContain('/steer')
    expect(SLASH_HELP).toContain('/reload')
    expect(SLASH_HELP).toContain('/mcp')
    expect(SLASH_HELP).toContain('/skills')
    expect(SLASH_HELP).toContain('/loop')
    expect(SLASH_HELP).toContain('/cron')
    expect(SLASH_HELP).toContain('/queue')
    expect(SLASH_HELP).toContain('/follow')
    expect(SLASH_HELP).toContain('/retry')
    expect(SLASH_HELP).toContain('/copy')
    expect(SLASH_HELP).toContain('/interview')
    expect(SLASH_HELP).toContain('/team-onboarding')
    expect(SLASH_HELP).toContain('/crew [<preset> <goal>]')
    expect(SLASH_HELP).toContain('list presets, or start one frozen crew turn')
    expect(SLASH_HELP).toContain('/bash')
    expect(SLASH_HELP).toContain('/skill:')
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
      'stop',
      'clear',
      'model',
      'permissions',
      'tasks',
      'undo',
      'rewind',
      'diff',
      'job',
      'pr',
      'steer',
      'add-dir',
      'effort',
      'agents',
      'hooks',
      'reload',
      'mcp',
      'skills',
      'loop',
      'cron',
      'queue',
      'follow',
      'retry',
      'copy',
      'interview',
      'team-onboarding',
      'crew',
      'bash',
      'skill',
      'config',
      'context',
      'help',
      'quit',
    ])
    expect(SLASH_COMMANDS.find((command) => command.name === 'clear')?.aliases).toContain('new')
    expect(SLASH_COMMANDS.find((command) => command.name === 'help')?.aliases).toContain('?')
    expect(SLASH_COMMANDS.find((command) => command.name === 'crew')?.aliases).toBe(undefined)
  })

  test('onboarding prompt is frozen and formatOnboardingTurn seeds the scan', () => {
    expect(ONBOARDING_PROMPT).toContain('Do not invent')
    expect(
      formatOnboardingTurn({
        teamName: 'Acme',
        projectFiles: [],
        skills: [],
        agents: [],
        hookEvents: [],
        mcpServers: [],
        usage: { label: 'your last 30 days in this workspace', days: 30, sessionCount: 0, slashCounts: [] },
        missing: [],
      }).startsWith('Walk this human'),
    ).toBe(true)
  })

  test('learn prompt asks to write a skill, and is not a tool name', () => {
    expect(LEARN_PROMPT).toContain('SKILL.md')
    expect(LEARN_PROMPT.toLowerCase()).toContain('write a new skill')
    expect(handleSlashCommand('/learn')).toEqual({ type: 'command', name: 'learn' })
  })

  test('learn prompt encodes authoring rules for the skill index', () => {
    expect(LEARN_PROMPT).toContain('60')
    expect(LEARN_PROMPT).toContain('references/')
    expect(LEARN_PROMPT.toLowerCase()).toContain('do not retype')
    expect(LEARN_PROMPT).toContain('.ravenclaw/skills/<name>/')
    expect(LEARN_PROMPT).toContain('~/.ravenclaw/skills/<name>/')
  })
})

describe('parseCrewArg', () => {
  test('CREW_LIST_NOTICE is the preset list and the generic usage line', () => {
    expect(CREW_LIST_NOTICE).toBe(
      ['crew presets: review, research, implement', 'usage: /crew <preset> <goal>'].join('\n'),
    )
  })

  test('missing or whitespace-only arg is the list notice', () => {
    expect(parseCrewArg(undefined)).toEqual({ ok: false, notice: CREW_LIST_NOTICE })
    expect(parseCrewArg('   ')).toEqual({ ok: false, notice: CREW_LIST_NOTICE })
  })

  test('a known preset with an empty goal notices usage with that preset', () => {
    expect(parseCrewArg('review')).toEqual({ ok: false, notice: 'usage: /crew review <goal>' })
    expect(parseCrewArg('research')).toEqual({ ok: false, notice: 'usage: /crew research <goal>' })
    expect(parseCrewArg('implement')).toEqual({ ok: false, notice: 'usage: /crew implement <goal>' })
  })

  test('an unknown preset wins and is lowercased in the notice', () => {
    expect(parseCrewArg('startup')).toEqual({ ok: false, notice: 'unknown crew preset: startup' })
    expect(parseCrewArg('Startup ship it')).toEqual({ ok: false, notice: 'unknown crew preset: startup' })
  })

  test('a valid call lowercases the preset and keeps the goal verbatim', () => {
    expect(parseCrewArg('REVIEW ship it')).toEqual({ ok: true, preset: 'review', goal: 'ship it' })
    expect(parseCrewArg('research Keep  THIS')).toEqual({ ok: true, preset: 'research', goal: 'Keep  THIS' })
  })
})

const CREW_SHARED_SENTENCES = [
  'Call the Agent tool. /crew does not spawn agents.',
  'You are the root. You still do the work. Do not only delegate.',
  'Do not tell a child to call Agent. Copy that rule into every child prompt.',
  'Do not set run_in_background.',
  'Do not set isolation.',
  'At most 6 children in one agents[] batch.',
  'The next wave is a later Agent call in this same turn.',
  'command-runner is not in this preset.',
  'Do not call a disk agent unless the user named that agent.',
  'If Agent returns an error, report that result and stop. Do not retry.',
  "If the tool result contains Agent failed:, Subagent ', Unknown subagent:, aborted:, or permission_denied:, report that result and stop. Do not retry.",
] as const

const CREW_PRESET_SENTENCES = {
  review: [
    'Preset: review. Read-only.',
    'Wave 1 is one file-finder. No agents[].',
    'You may Read and Grep.',
    'Do not Edit, Write, ApplyPatch, or mutate with Bash.',
    'Wave 2 is one reviewer given the findings.',
    'Do not assign the reviewer Edit, Write, ApplyPatch, or Bash.',
    'No implement follow-up.',
    'Then answer and stop.',
  ],
  research: [
    'Preset: research. Default no repo writes.',
    'If the goal refers to this repository, wave 1 is one agents[] batch with researcher-web and file-finder.',
    'Otherwise wave 1 is researcher-web only. No agents[].',
    'No reviewer unless the goal asks for critique.',
    'You synthesize the answer.',
    'Then answer and stop.',
  ],
  implement: [
    'Preset: implement.',
    'You may inspect first.',
    'Wave 1 is agents[] of general, 1 through 6, each prompt listing exclusive paths.',
    'Unsplittable work is one general.',
    'Wave 2 is one reviewer on the summary you collected.',
    'Do not assign the reviewer Edit, Write, ApplyPatch, or Bash.',
    'At most one fix-up wave after that, by you or one general. No agents[].',
    'Then answer and stop. No standing crew.',
  ],
} as const

describe('formatCrewTurn', () => {
  test.each(['review', 'research', 'implement'] as const)(
    '%s contains every shared sentence and that preset sentences',
    (preset) => {
      const goal = 'Keep  THIS'
      const text = formatCrewTurn(preset, goal)
      for (const sentence of CREW_SHARED_SENTENCES) expect(text).toContain(sentence)
      for (const sentence of CREW_PRESET_SENTENCES[preset]) expect(text).toContain(sentence)
      const head = `${CREW_SHARED}\n${CREW_PRESET_TEXT[preset]}\nGoal:\n`
      expect(text.startsWith(head)).toBe(true)
      expect(text.slice(head.length)).toBe(goal)
    },
  )

  test('research goal is byte-identical and is not lowercased', () => {
    const goal = 'Keep  THIS'
    const text = formatCrewTurn('research', goal)
    expect(text).toContain('Keep  THIS')
    expect(text).not.toContain('keep  this')
    const head = `${CREW_SHARED}\n${CREW_PRESET_TEXT.research}\nGoal:\n`
    expect(text.startsWith(head)).toBe(true)
    expect(text.slice(head.length)).toBe(goal)
  })

  test('a goal with edge whitespace is not trimmed and nothing follows it', () => {
    const goal = ' Keep  THIS \n'
    const text = formatCrewTurn('implement', goal)
    const head = `${CREW_SHARED}\n${CREW_PRESET_TEXT.implement}\nGoal:\n`
    expect(text.startsWith(CREW_SHARED)).toBe(true)
    expect(text.startsWith(`${CREW_SHARED}\n${CREW_PRESET_TEXT.implement}\nGoal:\n`)).toBe(true)
    expect(text.slice(head.length)).toBe(goal)
    expect(text.endsWith(goal)).toBe(true)
    expect(text.slice(head.length + goal.length)).toBe('')
  })

  test('no preset body contains a permission bypass', () => {
    for (const preset of ['review', 'research', 'implement'] as const) {
      const body = CREW_PRESET_TEXT[preset]
      expect(body).not.toContain('auto-allow')
      expect(body).not.toContain('allow_always')
      expect(body).not.toContain('skip the permission')
      const text = formatCrewTurn(preset, 'Keep  THIS')
      expect(text).not.toContain('auto-allow')
      expect(text).not.toContain('allow_always')
      expect(text).not.toContain('skip the permission')
    }
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
