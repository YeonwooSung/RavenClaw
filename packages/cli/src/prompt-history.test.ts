import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendPrompt, loadPrompts, promptHistoryPath } from './prompt-history'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raven-prompt-history-'))
  tempDirs.push(dir)
  return dir
}

describe('promptHistoryPath', () => {
  test('joins home and prompt-history.jsonl', () => {
    expect(promptHistoryPath('/tmp/rc-home')).toBe(join('/tmp/rc-home', 'prompt-history.jsonl'))
  })
})

describe('appendPrompt', () => {
  test('skips empty and whitespace-only text', () => {
    const home = tempHome()
    appendPrompt('', home)
    appendPrompt('   \n\t', home)
    expect(existsSync(promptHistoryPath(home))).toBe(false)
    expect(loadPrompts(home)).toEqual([])
  })

  test('appends a JSONL row with t and text', () => {
    const home = tempHome()
    const before = Date.now()
    appendPrompt('hello', home)
    const after = Date.now()
    const raw = readFileSync(promptHistoryPath(home), 'utf8').trim()
    const row = JSON.parse(raw) as { t: number; text: string }
    expect(row.text).toBe('hello')
    expect(row.t).toBeGreaterThanOrEqual(before)
    expect(row.t).toBeLessThanOrEqual(after)
  })

  test('caps the file at the last 500 lines', () => {
    const home = tempHome()
    const existing = Array.from({ length: 500 }, (_, i) => JSON.stringify({ t: i, text: `p${i}` }))
    writeFileSync(promptHistoryPath(home), `${existing.join('\n')}\n`, 'utf8')
    appendPrompt('newest', home)
    const loaded = loadPrompts(home)
    expect(loaded).toHaveLength(500)
    expect(loaded[0]).toBe('p1')
    expect(loaded[499]).toBe('newest')
  })
})

describe('loadPrompts', () => {
  test('returns oldest to newest and ignores bad lines', () => {
    const home = tempHome()
    appendPrompt('first', home)
    appendPrompt('second', home)
    const path = promptHistoryPath(home)
    const current = readFileSync(path, 'utf8')
    writeFileSync(
      path,
      `${current}not-json\n{"t":1}\n{"text":123}\n{"t":2,"text":"third"}\n`,
      'utf8',
    )
    expect(loadPrompts(home)).toEqual(['first', 'second', 'third'])
  })

  test('missing file is empty', () => {
    expect(loadPrompts(tempHome())).toEqual([])
  })
})
