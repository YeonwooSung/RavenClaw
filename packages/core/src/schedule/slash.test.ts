import { describe, expect, test } from 'bun:test'
import { parseCronSlashArg } from './slash'

describe('parseCronSlashArg', () => {
  test('list default', () => {
    expect(parseCronSlashArg()).toEqual({ action: 'list' })
    expect(parseCronSlashArg('')).toEqual({ action: 'list' })
    expect(parseCronSlashArg('list')).toEqual({ action: 'list' })
  })

  test('add every and cron fields', () => {
    const every = parseCronSlashArg('add every 30m lint the repo')
    expect(every.action).toBe('add')
    if (every.action === 'add') {
      expect(every.prompt).toBe('lint the repo')
      expect(every.schedule).toEqual({ kind: 'every', everyMs: 1_800_000 })
    }
    const cron = parseCronSlashArg('add 0 9 * * 1-5 standup')
    expect(cron.action).toBe('add')
    if (cron.action === 'add') {
      expect(cron.spec).toBe('0 9 * * 1-5')
      expect(cron.prompt).toBe('standup')
    }
  })

  test('rm on off', () => {
    expect(parseCronSlashArg('rm c_abc')).toEqual({ action: 'rm', id: 'c_abc' })
    expect(parseCronSlashArg('on c_abc')).toEqual({ action: 'on', id: 'c_abc' })
    expect(parseCronSlashArg('off c_abc')).toEqual({ action: 'off', id: 'c_abc' })
  })

  test('bad add is usage', () => {
    const bad = parseCronSlashArg('add nope')
    expect(bad.action).toBe('error')
  })
})
