import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { sliceUtf8Lines, streamUtf8LineWindow } from './read-lines'

describe('sliceUtf8Lines', () => {
  test('matches Buffer utf8 split for offset/limit and trailing newline', () => {
    const raw = 'alpha\nbeta\r\ngamma\n'
    const full = raw.split(/\r?\n/).join('\n')
    expect(sliceUtf8Lines(raw)).toBe(full)
    expect(sliceUtf8Lines(raw, 2, 2)).toBe('beta\ngamma')
  })
})

describe('streamUtf8LineWindow', () => {
  test('matches in-memory slice on a multi-line file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'raven-read-lines-'))
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'lines.txt')
    const body = Array.from({ length: 200 }, (_, i) => `line-${i + 1}`).join('\n') + '\n'
    writeFileSync(path, body)
    const streamed = await streamUtf8LineWindow(path, 10, 5)
    expect(streamed).toBe(sliceUtf8Lines(body, 10, 5))
  })
})
