import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openRavenclawLog } from './log'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-log-'))
  tempDirs.push(dir)
  return dir
}

function logPath(home: string, suffix = ''): string {
  return join(home, 'logs', `ravenclaw.log${suffix}`)
}

function readLines(home: string, suffix = ''): string[] {
  return readFileSync(logPath(home, suffix), 'utf8').split('\n').filter((line) => line !== '')
}

describe('openRavenclawLog', () => {
  test('writes a line', () => {
    const home = tempHome()
    const log = openRavenclawLog(home)
    log.write({ type: 'round_end', sessionId: 'sess_1', reason: 'completed' })
    log.close()
    const lines = readLines(home)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      type: 'round_end',
      sessionId: 'sess_1',
      reason: 'completed',
    })
  })

  test('rotate at 5MB (tiny maxBytes inject)', () => {
    const home = tempHome()
    const log = openRavenclawLog(home, { maxBytes: 40 })
    log.write({ type: 'first', reason: 'xxxxxxxxxxxxxxxxxxxx' })
    expect(existsSync(logPath(home, '.1'))).toBe(false)
    log.write({ type: 'second', reason: 'yyyyyyyyyyyyyyyyyyyy' })
    log.close()
    expect(existsSync(logPath(home))).toBe(true)
    expect(existsSync(logPath(home, '.1'))).toBe(true)
    const current = readLines(home).map((line) => (JSON.parse(line) as { type: string }).type)
    const rotated = readLines(home, '.1').map((line) => (JSON.parse(line) as { type: string }).type)
    expect(current).toEqual(['second'])
    expect(rotated).toEqual(['first'])
  })

  test('keeps 3 files', () => {
    const home = tempHome()
    const log = openRavenclawLog(home, { maxBytes: 20 })
    for (const type of ['one', 'two', 'three', 'four']) {
      log.write({ type, reason: '01234567890123456789' })
    }
    log.close()
    const names = readdirSync(join(home, 'logs'))
      .filter((name) => name.startsWith('ravenclaw.log'))
      .sort()
    expect(names).toEqual(['ravenclaw.log', 'ravenclaw.log.1', 'ravenclaw.log.2'])
    expect(existsSync(logPath(home, '.3'))).toBe(false)
    expect(readLines(home).some((line) => line.includes('"type":"four"'))).toBe(true)
    expect(readLines(home, '.1').some((line) => line.includes('"type":"three"'))).toBe(true)
    expect(readLines(home, '.2').some((line) => line.includes('"type":"two"'))).toBe(true)
  })

  test('swallows write errors', () => {
    const parent = tempHome()
    const home = join(parent, 'not-a-dir')
    writeFileSync(home, 'blocked')
    const log = openRavenclawLog(home)
    expect(() => log.write({ type: 'round_end', reason: 'completed' })).not.toThrow()
    log.close()
  })

  test('does not include a prompt body even if someone passes one', () => {
    const home = tempHome()
    const log = openRavenclawLog(home)
    log.write({
      type: 'round_end',
      sessionId: 'sess_2',
      reason: 'completed',
      prompt: 'SECRET_PROMPT_BODY',
      output: 'TOOL_OUTPUT',
      text: 'PROMPT_TEXT',
      body: 'PROMPT_BODY',
    } as { type: string; sessionId: string; reason: string })
    log.close()
    const raw = readFileSync(logPath(home), 'utf8')
    expect(raw).not.toContain('SECRET_PROMPT_BODY')
    expect(raw).not.toContain('TOOL_OUTPUT')
    expect(raw).not.toContain('PROMPT_TEXT')
    expect(raw).not.toContain('PROMPT_BODY')
    expect(raw).not.toContain('"prompt"')
    expect(raw).not.toContain('"output"')
    expect(raw).not.toContain('"text"')
    expect(raw).not.toContain('"body"')
    expect(JSON.parse(raw)).toEqual({
      type: 'round_end',
      sessionId: 'sess_2',
      reason: 'completed',
    })
  })
})
