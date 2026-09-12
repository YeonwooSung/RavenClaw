import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectUserImages, mediaTypeForPath, parseOsascriptPng } from './image-paste'
import { expandMentions } from './mentions'

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

  test('attaches a bare image path that is the whole line', () => {
    const cwd = join(tmpdir(), `raven-img-bare-${Date.now()}`)
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
    const result = collectUserImages('shot.png', cwd)
    expect(typeof result).toBe('object')
    if (typeof result === 'string') throw new Error('expected images')
    expect(result.images).toHaveLength(1)
    expect(result.images[0]?.mediaType).toBe('image/png')
  })

  test('refuses image paths outside cwd and symlink escapes', () => {
    const cwd = join(tmpdir(), `raven-img-jail-${Date.now()}`)
    mkdirSync(cwd, { recursive: true })
    const outside = join(tmpdir(), `raven-img-out-${Date.now()}.png`)
    writeFileSync(outside, Buffer.from('89504e470d0a1a0a', 'hex'))
    expect(collectUserImages(`look at @${outside}`, cwd)).toBe(`look at @${outside}`)

    symlinkSync(outside, join(cwd, 'link.png'))
    expect(collectUserImages('look at @link.png', cwd)).toBe('look at @link.png')
  })

  test('TUI order: expandMentions then collectUserImages attaches @png without inlining bytes', () => {
    const cwd = join(tmpdir(), `raven-img-pipe-${Date.now()}`)
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
    const expanded = expandMentions('look at @shot.png', cwd)
    expect(expanded.files).toEqual([])
    expect(expanded.text).toBe('look at @shot.png')
    const payload = collectUserImages(expanded.text, cwd)
    expect(typeof payload).toBe('object')
    if (typeof payload === 'string') throw new Error('expected images')
    expect(payload.images).toHaveLength(1)
    expect(payload.text).toBe('look at @shot.png')
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
