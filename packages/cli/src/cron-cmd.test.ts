import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonCronStore } from '@ravenclaw/core'
import { applyCronMutate, handleCronCli, runCronTick } from './cron-cmd'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-cron-cmd-'))
  tempDirs.push(dir)
  return dir
}

describe('handleCronCli', () => {
  test('add, list, rm, on, off against a temp home', () => {
    const home = tempHome()
    const cwd = '/proj'

    const empty = handleCronCli(undefined, cwd, home)
    expect(empty).toEqual({ text: 'no cron jobs', code: 0 })
    expect(applyCronMutate('list', cwd, home)).toEqual(empty)

    const added = handleCronCli('add every 30m lint', cwd, home)
    expect(added.code).toBe(0)
    expect(added.text).toMatch(/^c_[0-9a-f]{8}  on  every 30m  lint$/)

    const listed = handleCronCli('list', cwd, home)
    expect(listed).toEqual(added)

    const id = added.text.split(/\s+/)[0] ?? ''
    expect(id).toMatch(/^c_[0-9a-f]{8}$/)

    const off = handleCronCli(`off ${id}`, cwd, home)
    expect(off.code).toBe(0)
    expect(off.text).toContain('off')
    expect(off.text).toContain(id)

    const on = handleCronCli(`on ${id}`, cwd, home)
    expect(on.code).toBe(0)
    expect(on.text).toContain('on')
    expect(on.text).not.toContain('off')

    const rm = handleCronCli(`rm ${id}`, cwd, home)
    expect(rm).toEqual({ text: `deleted ${id}`, code: 0 })
    expect(handleCronCli('list', cwd, home).text).toBe('no cron jobs')
  })

  test('unknown job and bad spec return errors', () => {
    const home = tempHome()
    expect(handleCronCli('rm c_missing', '/proj', home)).toEqual({
      text: 'unknown job c_missing',
      code: 1,
    })
    expect(handleCronCli('on c_missing', '/proj', home).code).toBe(1)
    expect(handleCronCli('add nope', '/proj', home).code).toBe(2)
  })

  test('tick and watch are not mutated here', () => {
    const home = tempHome()
    expect(handleCronCli('tick', '/proj', home)).toEqual({ text: '', code: -1 })
    expect(handleCronCli('watch', '/proj', home)).toEqual({ text: '', code: -1 })
  })

  test('name is the first 40 characters of the prompt', () => {
    const home = tempHome()
    const prompt = 'x'.repeat(50)
    const added = handleCronCli(`add every 30m ${prompt}`, '/work', home)
    expect(added.code).toBe(0)
    const id = added.text.split(/\s+/)[0] ?? ''
    const job = createJsonCronStore({ home }).get(id)
    expect(job?.name).toBe('x'.repeat(40))
    expect(job?.cwd).toBe('/work')
    expect(job?.enabled).toBe(true)
  })
})

describe('runCronTick', () => {
  test('formats fired jobs or reports none due', async () => {
    const home = tempHome()
    const added = handleCronCli('add every 30m ping', '/proj', home)
    const id = added.text.split(/\s+/)[0] ?? ''
    const store = createJsonCronStore({ home })
    const job = store.get(id)
    expect(job).toBeDefined()
    if (!job) throw new Error('expected job')
    store.upsert({ ...job, nextFireAt: 1 })

    const text = await runCronTick({
      home,
      now: 10,
      run: async () => ({ ok: true, sessionId: 'sess_1' }),
    })
    expect(text).toContain(id)
    expect(text).toContain('last ok')

    const none = await runCronTick({
      home,
      now: 10,
      run: async () => ({ ok: true }),
    })
    expect(none).toBe('no due cron jobs')
  })
})
