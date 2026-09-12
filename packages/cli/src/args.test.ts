import { describe, expect, test } from 'bun:test'
import { parseArgv } from './args'

describe('parseArgv', () => {
  test('no args starts interactive with empty flags', () => {
    expect(parseArgv([])).toEqual({ cmd: 'interactive', flags: {} })
  })

  test('exec takes the remaining args as the prompt', () => {
    expect(parseArgv(['exec', 'hello', 'world'])).toEqual({
      cmd: 'exec',
      prompt: 'hello world',
      flags: { dontAsk: true },
    })
  })

  test('exec --json records json and still forces dontAsk', () => {
    expect(parseArgv(['exec', '--json', 'summarize this'])).toEqual({
      cmd: 'exec',
      prompt: 'summarize this',
      json: true,
      flags: { dontAsk: true },
    })
  })

  test('--json after the prompt still enables jsonl', () => {
    expect(parseArgv(['exec', 'ping', '--json'])).toEqual({
      cmd: 'exec',
      prompt: 'ping',
      json: true,
      flags: { dontAsk: true },
    })
  })

  test('--dont-ask sets the flag for interactive', () => {
    expect(parseArgv(['--dont-ask'])).toEqual({
      cmd: 'interactive',
      flags: { dontAsk: true },
    })
  })

  test('--provider and --model go into flags', () => {
    expect(
      parseArgv(['--provider', 'openai_compat', '--model', 'openai/gpt-4o']),
    ).toEqual({
      cmd: 'interactive',
      flags: { provider: 'openai_compat', model: 'openai/gpt-4o' },
    })
  })

  test('--tools-preset fills allowedTools when --allowed-tools is unset', () => {
    expect(parseArgv(['exec', '--tools-preset', 'ci', 'run bun test'])).toEqual({
      cmd: 'exec',
      prompt: 'run bun test',
      flags: {
        dontAsk: true,
        allowedTools: [
          'Read',
          'Grep',
          'Glob',
          'ListDir',
          'ReadSubtree',
          'Skill',
          'Edit',
          'Write',
          'ApplyPatch',
          'NotebookEdit',
          'Bash',
        ],
      },
    })
    expect(parseArgv(['--tools-preset=write']).flags.allowedTools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'ListDir',
      'ReadSubtree',
      'Skill',
      'Edit',
      'Write',
      'ApplyPatch',
      'NotebookEdit',
    ])
    expect(parseArgv(['--tools-preset', 'read']).flags.allowedTools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'ListDir',
      'ReadSubtree',
      'Skill',
    ])
  })

  test('--allowed-tools wins over --tools-preset', () => {
    expect(
      parseArgv(['--tools-preset', 'ci', '--allowed-tools', 'Read,Grep']).flags.allowedTools,
    ).toEqual(['Read', 'Grep'])
    expect(
      parseArgv(['--allowed-tools', 'Read', '--tools-preset', 'ci']).flags.allowedTools,
    ).toEqual(['Read'])
  })

  test('rejects an unknown or missing --tools-preset', () => {
    expect(() => parseArgv(['--tools-preset', 'yolo'])).toThrow(/tools preset/)
    expect(() => parseArgv(['--tools-preset'])).toThrow(/tools-preset/)
    expect(() => parseArgv(['--tools-preset='])).toThrow(/tools preset/)
  })

  test('--fallback-model --allowed-tools and --worktree parse', () => {
    expect(parseArgv(['--fallback-model', 'haiku', '--allowed-tools', 'Read,Grep'])).toEqual({
      cmd: 'interactive',
      flags: { fallbackModel: 'haiku', allowedTools: ['Read', 'Grep'] },
    })
    expect(parseArgv(['--worktree'])).toEqual({
      cmd: 'interactive',
      flags: { worktree: true },
    })
    expect(parseArgv(['--worktree', 'feat'])).toEqual({
      cmd: 'interactive',
      flags: { worktree: 'feat' },
    })
    expect(parseArgv(['--bare', '--agent', 'general', '--effort', 'high'])).toEqual({
      cmd: 'interactive',
      flags: { bare: true, agent: 'general', effort: 'high' },
    })
    expect(parseArgv(['serve', '--listen', '127.0.0.1:8787'])).toEqual({
      cmd: 'serve',
      flags: { dontAsk: true, listen: '127.0.0.1:8787' },
    })
  })

  test('supports --provider= and --model= forms', () => {
    expect(parseArgv(['--provider=anthropic', '--model=claude'])).toEqual({
      cmd: 'interactive',
      flags: { provider: 'anthropic', model: 'claude' },
    })
  })

  test('exec --verify-on-stop sets flags.verifyOnStop', () => {
    expect(parseArgv(['exec', '--verify-on-stop', 'implement the fix'])).toEqual({
      cmd: 'exec',
      prompt: 'implement the fix',
      flags: { dontAsk: true, verifyOnStop: true },
    })
  })

  test('default exec does not set verifyOnStop', () => {
    expect(parseArgv(['exec', 'hello']).flags.verifyOnStop).toBeUndefined()
    expect(parseArgv(['exec', 'hello']).flags).toEqual({ dontAsk: true })
  })

  test('exec without a prompt still forces dontAsk', () => {
    expect(parseArgv(['exec'])).toEqual({
      cmd: 'exec',
      flags: { dontAsk: true },
    })
  })

  test('acp without --dont-ask does not set flags.dontAsk', () => {
    expect(parseArgv(['acp'])).toEqual({
      cmd: 'acp',
      flags: {},
    })
  })

  test('acp keeps provider and model flags without forcing dontAsk', () => {
    expect(parseArgv(['acp', '--provider', 'anthropic', '--model', 'claude'])).toEqual({
      cmd: 'acp',
      flags: { provider: 'anthropic', model: 'claude' },
    })
  })

  test('acp --dont-ask still sets flags.dontAsk', () => {
    expect(parseArgv(['acp', '--dont-ask'])).toEqual({
      cmd: 'acp',
      flags: { dontAsk: true },
    })
  })

  test('setup selects the setup command', () => {
    expect(parseArgv(['setup'])).toEqual({ cmd: 'setup', flags: {} })
  })

  test('sessions lists without forcing dontAsk', () => {
    expect(parseArgv(['sessions'])).toEqual({ cmd: 'sessions', flags: {} })
  })

  test('skills lists discovered skills', () => {
    expect(parseArgv(['skills'])).toEqual({ cmd: 'skills', flags: {} })
  })

  test('skills new takes the name and optional --project', () => {
    expect(parseArgv(['skills', 'new', 'demo'])).toEqual({
      cmd: 'skills',
      prompt: 'new demo',
      flags: {},
    })
    expect(parseArgv(['skills', 'new', 'demo', '--project'])).toEqual({
      cmd: 'skills',
      prompt: 'new demo',
      project: true,
      flags: {},
    })
    expect(parseArgv(['skills', 'rm', 'demo'])).toEqual({
      cmd: 'skills',
      prompt: 'rm demo',
      flags: {},
    })
  })

  test('mcp lists configured servers', () => {
    expect(parseArgv(['mcp'])).toEqual({ cmd: 'mcp', flags: {} })
    expect(parseArgv(['mcp', 'list'])).toEqual({ cmd: 'mcp', prompt: 'list', flags: {} })
    expect(parseArgv(['mcp', 'tools'])).toEqual({ cmd: 'mcp', prompt: 'tools', flags: {} })
  })

  test('cron lists and adds without forcing dontAsk', () => {
    expect(parseArgv(['cron'])).toEqual({ cmd: 'cron', flags: {} })
    expect(parseArgv(['cron', 'list'])).toEqual({ cmd: 'cron', prompt: 'list', flags: {} })
    expect(parseArgv(['cron', 'add', 'every', '30m', 'lint'])).toEqual({
      cmd: 'cron',
      prompt: 'add every 30m lint',
      flags: {},
    })
  })

  test('completions takes bash or zsh as the prompt', () => {
    expect(parseArgv(['completions', 'zsh'])).toEqual({
      cmd: 'completions',
      prompt: 'zsh',
      flags: {},
    })
  })

  test('init selects the init command', () => {
    expect(parseArgv(['init'])).toEqual({ cmd: 'init', flags: {} })
  })

  test('config selects the config command', () => {
    expect(parseArgv(['config'])).toEqual({ cmd: 'config', flags: {} })
  })

  test('doctor selects the doctor command', () => {
    expect(parseArgv(['doctor'])).toEqual({ cmd: 'doctor', flags: {} })
  })

  test('title takes id and the rest as the title', () => {
    expect(parseArgv(['title', 'abc', 'Fix', 'login'])).toEqual({
      cmd: 'title',
      prompt: 'abc Fix login',
      flags: {},
    })
  })

  test('export takes the remaining args as the session id', () => {
    expect(parseArgv(['export', 'abc123'])).toEqual({
      cmd: 'export',
      prompt: 'abc123',
      flags: {},
    })
  })

  test('search takes the query and optional --all', () => {
    expect(parseArgv(['search', 'pairing'])).toEqual({
      cmd: 'search',
      prompt: 'pairing',
      flags: {},
    })
    expect(parseArgv(['search', '--all', 'pairing'])).toEqual({
      cmd: 'search',
      prompt: 'pairing',
      all: true,
      flags: {},
    })
  })

  test('resume takes the remaining args as the session id', () => {
    expect(parseArgv(['resume', 'abc123'])).toEqual({
      cmd: 'resume',
      prompt: 'abc123',
      flags: {},
    })
    expect(parseArgv(['resume'])).toEqual({ cmd: 'resume', flags: {} })
  })

  test('rm takes the remaining args as the session id', () => {
    expect(parseArgv(['rm', 'abc123'])).toEqual({
      cmd: 'rm',
      prompt: 'abc123',
      flags: {},
    })
  })

  test('show takes the remaining args as the session id', () => {
    expect(parseArgv(['show', 'abc123'])).toEqual({
      cmd: 'show',
      prompt: 'abc123',
      flags: {},
    })
  })

  test('smoke selects smoke and forces dontAsk', () => {
    expect(parseArgv(['smoke'])).toEqual({ cmd: 'smoke', flags: { dontAsk: true } })
  })

  test('slack does not force dontAsk', () => {
    expect(parseArgv(['slack'])).toEqual({ cmd: 'slack', flags: {} })
    expect(parseArgv(['slack', '--provider', 'anthropic']).flags).toEqual({
      provider: 'anthropic',
    })
  })

  test('discord and pairing are top-level commands', () => {
    expect(parseArgv(['discord'])).toEqual({ cmd: 'discord', flags: {} })
    expect(parseArgv(['pairing', 'list'])).toEqual({ cmd: 'pairing', prompt: 'list', flags: {} })
  })

  test('--help and -h select the help command', () => {
    expect(parseArgv(['--help'])).toEqual({ cmd: 'help', flags: {} })
    expect(parseArgv(['-h'])).toEqual({ cmd: 'help', flags: {} })
    expect(parseArgv(['help'])).toEqual({ cmd: 'help', flags: {} })
  })

  test('--version and -V select the version command', () => {
    expect(parseArgv(['--version'])).toEqual({ cmd: 'version', flags: {} })
    expect(parseArgv(['-V'])).toEqual({ cmd: 'version', flags: {} })
    expect(parseArgv(['version'])).toEqual({ cmd: 'version', flags: {} })
  })

  test('exec --help shows help rather than exec', () => {
    expect(parseArgv(['exec', '--help'])).toEqual({ cmd: 'help', flags: {} })
  })

  test('rejects an unknown provider', () => {
    expect(() => parseArgv(['--provider', 'mystery'])).toThrow(/provider/)
  })

  test('accepts ollama and vllm providers', () => {
    expect(parseArgv(['--provider', 'ollama', '--model', 'llama3.2']).flags).toEqual({
      provider: 'ollama',
      model: 'llama3.2',
    })
    expect(parseArgv(['--provider', 'vllm', '--model', 'local-model']).flags.provider).toBe(
      'vllm',
    )
  })

  test('--tui opentui is recorded on ParsedArgv, not flags', () => {
    expect(parseArgv(['--tui', 'opentui'])).toEqual({
      cmd: 'interactive',
      flags: {},
      tui: 'opentui',
    })
  })

  test('--tui=opentui and --tui ink are accepted', () => {
    expect(parseArgv(['--tui=opentui'])).toEqual({
      cmd: 'interactive',
      flags: {},
      tui: 'opentui',
    })
    expect(parseArgv(['--tui', 'ink'])).toEqual({
      cmd: 'interactive',
      flags: {},
      tui: 'ink',
    })
    expect(parseArgv(['--tui=ink', '--model', 'claude'])).toEqual({
      cmd: 'interactive',
      flags: { model: 'claude' },
      tui: 'ink',
    })
  })

  test('omitting --tui leaves tui unset so the default Ink path is used', () => {
    const parsed = parseArgv([])
    expect(parsed).toEqual({ cmd: 'interactive', flags: {} })
    expect(parsed.tui).toBeUndefined()
  })

  test('rejects an unknown or missing --tui value', () => {
    expect(() => parseArgv(['--tui', 'mystery'])).toThrow(/tui/)
    expect(() => parseArgv(['--tui'])).toThrow(/tui/)
    expect(() => parseArgv(['--tui='])).toThrow(/tui/)
  })
})
