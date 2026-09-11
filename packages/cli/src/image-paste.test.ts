import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectUserImages, mediaTypeForPath, parseOsascriptPng } from './image-paste'

describe('collectUserImages', () => {
  test('attaches @path.png and ignores leftover clipboard on a text prompt', () => {
    const cwd = join(tmpdir(), `raven-img-${Date.now()}`)
    mkdirSync(cwd, { recursive: true })
    const path = join(cwd, 'shot.png')
    writeFileSync(path, Buffer.from('89504e470d0a1a0a', 'hex'))
    const result = collectUserImages(`look at @shot.png`, cwd, () => ({
      mediaType: 'image/png',
      data: 'abc',
    }))
    expect(typeof result).toBe('object')
    if (typeof result === 'string') throw new Error('expected images')
    expect(result.text).toBe('look at @shot.png')
    expect(result.images).toHaveLength(1)
    expect(mediaTypeForPath('x.jpg')).toBe('image/jpeg')
  })

  test('empty text attaches the clipboard image', () => {
    const result = collectUserImages('', '/tmp', () => ({
      mediaType: 'image/png',
      data: 'abc',
    }))
    expect(typeof result).toBe('object')
    if (typeof result === 'string') throw new Error('expected images')
    expect(result.images).toEqual([{ mediaType: 'image/png', data: 'abc' }])
  })

  test('plain text stays a string', () => {
    expect(collectUserImages('hello', '/tmp', () => ({ mediaType: 'image/png', data: 'abc' }))).toBe(
      'hello',
    )
  })
})

describe('parseOsascriptPng', () => {
  test('extracts hex from «data PNGf…» and rejects garbage', () => {
    const payload = '89504e470d0a1a0a0000000d49484452'
    const stdout = `«data PNGf${payload}»`
    const buf = parseOsascriptPng(stdout)
    expect(buf?.equals(Buffer.from(payload, 'hex'))).toBe(true)
    expect(parseOsascriptPng(stdout.replace(/\s+/g, ''))?.equals(Buffer.from(payload, 'hex'))).toBe(
      true,
    )
    expect(parseOsascriptPng('«data PNGf89504e470d0a1a0a0000000d49484452»')).toBeDefined()
    expect(parseOsascriptPng('«data PNGf89504e470d0a1a0a0000000d49484452»')?.[0]).toBe(0x89)
    expect(parseOsascriptPng('not a png')).toBeUndefined()
    expect(parseOsascriptPng('')).toBeUndefined()
  })
})
