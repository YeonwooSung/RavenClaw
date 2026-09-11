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

  test('supports --provider= and --model= forms', () => {
    expect(parseArgv(['--provider=anthropic', '--model=claude'])).toEqual({
      cmd: 'interactive',
      flags: { provider: 'anthropic', model: 'claude' },
    })
  })

  test('exec without a prompt still forces dontAsk', () => {
    expect(parseArgv(['exec'])).toEqual({
      cmd: 'exec',
      flags: { dontAsk: true },
    })
  })

  test('acp is unattended like exec', () => {
    expect(parseArgv(['acp'])).toEqual({
      cmd: 'acp',
      flags: { dontAsk: true },
    })
  })

  test('acp keeps provider and model flags and still forces dontAsk', () => {
    expect(parseArgv(['acp', '--provider', 'anthropic', '--model', 'claude'])).toEqual({
      cmd: 'acp',
      flags: { dontAsk: true, provider: 'anthropic', model: 'claude' },
    })
  })

  test('setup selects the setup command', () => {
    expect(parseArgv(['setup'])).toEqual({ cmd: 'setup', flags: {} })
  })

  test('sessions lists without forcing dontAsk', () => {
    expect(parseArgv(['sessions'])).toEqual({ cmd: 'sessions', flags: {} })
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
