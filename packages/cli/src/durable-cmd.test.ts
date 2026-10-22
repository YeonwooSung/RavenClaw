import { describe, expect, test } from 'bun:test'
import { parseArgv } from './args'

describe('parseArgv durable', () => {
  test('reads the command, path, and prompt', () => {
    const parsed = parseArgv(['durable', '--path', 'sess.sqlite', 'hello', 'there'])
    expect(parsed.cmd).toBe('durable')
    expect(parsed.path).toBe('sess.sqlite')
    expect(parsed.prompt).toBe('hello there')
    expect(parsed.flags.dontAsk).toBe(true)
  })

  test('accepts --path= and a path before the command', () => {
    const eq = parseArgv(['durable', '--path=sess.sqlite', 'hi'])
    expect(eq.path).toBe('sess.sqlite')
    expect(eq.prompt).toBe('hi')
    const before = parseArgv(['--path', 'sess.sqlite', 'durable', 'hi'])
    expect(before.cmd).toBe('durable')
    expect(before.path).toBe('sess.sqlite')
    expect(before.prompt).toBe('hi')
  })

  test('rejects --path on exec', () => {
    expect(() => parseArgv(['exec', '--path', 'sess.sqlite', 'hi'])).toThrow('unknown flag: --path')
  })

  test('rejects --path= on resume', () => {
    expect(() => parseArgv(['resume', '--path=sess.sqlite'])).toThrow('unknown flag: --path')
  })
})
