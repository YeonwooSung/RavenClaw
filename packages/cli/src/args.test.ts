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

  test('rejects an unknown provider', () => {
    expect(() => parseArgv(['--provider', 'mystery'])).toThrow(/provider/)
  })
})
