import { describe, expect, test } from 'bun:test'
import { formatSchedule, nextFireAt, parseJobSpec } from './cron'
import { MIN_INTERVAL_MS, type JobSchedule } from './types'

function expectOk(raw: string): JobSchedule {
  const result = parseJobSpec(raw)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.schedule
}

function expectFail(raw: string, ...needles: string[]): void {
  const result = parseJobSpec(raw)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected parse failure')
  expect(result.message.length).toBeGreaterThan(0)
  const lower = result.message.toLowerCase()
  for (const needle of needles) expect(lower).toContain(needle.toLowerCase())
}

describe('parseJobSpec', () => {
  test('trims surrounding whitespace', () => {
    expect(parseJobSpec('  every 30s  ')).toEqual({
      ok: true,
      schedule: { kind: 'every', everyMs: 30_000 },
    })
    expect(parseJobSpec('\n0 9 * * 1-5\t')).toEqual({
      ok: true,
      schedule: { kind: 'cron', expr: '0 9 * * 1-5' },
    })
  })

  test('empty and whitespace-only fail', () => {
    expectFail('', 'empty')
    expectFail('   ', 'empty')
    expectFail('\n\t', 'empty')
  })

  test('every 30s / 5m / 2h', () => {
    expect(expectOk('every 30s')).toEqual({ kind: 'every', everyMs: 30_000 })
    expect(expectOk('every 5m')).toEqual({ kind: 'every', everyMs: 5 * 60_000 })
    expect(expectOk('every 2h')).toEqual({ kind: 'every', everyMs: 2 * 3_600_000 })
  })

  test(`minimum interval is ${MIN_INTERVAL_MS}ms`, () => {
    expect(expectOk('every 15s')).toEqual({ kind: 'every', everyMs: MIN_INTERVAL_MS })
    expectFail('every 1s', '15000')
    expectFail('every 14s', '15000')
    expectFail('every 0s', '15000')
  })

  test('rejects malformed interval specs', () => {
    expectFail('every', 'every')
    expectFail('every 30', 'every')
    expectFail('every 30x', 'every')
    expectFail('every -30s', 'every')
    expectFail('every 30S', 'every')
    expectFail('every 30s extra', 'every')
    expectFail('every 30 s', 'every')
  })

  test('@hourly and @daily expand to 5-field cron', () => {
    expect(expectOk('@hourly')).toEqual({ kind: 'cron', expr: '0 * * * *' })
    expect(expectOk('@daily')).toEqual({ kind: 'cron', expr: '0 0 * * *' })
  })

  test('unknown aliases fail', () => {
    expectFail('@weekly', 'alias')
    expectFail('@Hourly', 'alias')
  })

  test('accepts 5-field cron tokens', () => {
    expect(expectOk('0 9 * * 1-5')).toEqual({ kind: 'cron', expr: '0 9 * * 1-5' })
    expect(expectOk('*/15 * * * *')).toEqual({ kind: 'cron', expr: '*/15 * * * *' })
    expect(expectOk('0,30 * * * *')).toEqual({ kind: 'cron', expr: '0,30 * * * *' })
    expect(expectOk('0-30/10 * * * *')).toEqual({ kind: 'cron', expr: '0-30/10 * * * *' })
    expect(expectOk('5 4 1 1 0')).toEqual({ kind: 'cron', expr: '5 4 1 1 0' })
  })

  test('normalizes extra cron whitespace', () => {
    expect(expectOk('0    9  *   *  1-5')).toEqual({ kind: 'cron', expr: '0 9 * * 1-5' })
  })

  test('rejects out-of-range cron fields', () => {
    expectFail('60 * * * *', 'minute')
    expectFail('* 24 * * *', 'hour')
    expectFail('* * 0 * *', 'day-of-month')
    expectFail('* * 32 * *', 'day-of-month')
    expectFail('* * * 0 *', 'month')
    expectFail('* * * 13 *', 'month')
    expectFail('* * * * 7', 'day-of-week')
  })

  test('rejects wrong field counts and invalid tokens', () => {
    expectFail('0 9 * *', '5')
    expectFail('0 9 * * 1-5 *', '5')
    expectFail('0 9 * * 1-5-9', 'day-of-week')
    expectFail('1/2 * * * *', 'minute')
    expectFail('30-0 * * * *', 'range')
    expectFail('*/0 * * * *', 'step')
  })
})

describe('nextFireAt', () => {
  test('interval is fromMs + everyMs', () => {
    const schedule: JobSchedule = { kind: 'every', everyMs: 30_000 }
    expect(nextFireAt(schedule, 1_000)).toBe(31_000)
    expect(nextFireAt(schedule, 0)).toBe(30_000)
  })

  test('cron is the first UTC instant strictly after fromMs', () => {
    const nine = expectOk('0 9 * * *')
    const from = Date.UTC(2026, 0, 1, 8, 30, 0, 0)
    expect(nextFireAt(nine, from)).toBe(Date.UTC(2026, 0, 1, 9, 0, 0, 0))

    const exact = Date.UTC(2026, 0, 1, 9, 0, 0, 0)
    expect(nextFireAt(nine, exact)).toBe(Date.UTC(2026, 0, 2, 9, 0, 0, 0))
    expect(nextFireAt(nine, exact + 1)).toBe(Date.UTC(2026, 0, 2, 9, 0, 0, 0))
    expect(nextFireAt(nine, exact - 1)).toBe(exact)
  })

  test('@hourly fires at minute 0 of the next hour', () => {
    const hourly = expectOk('@hourly')
    expect(nextFireAt(hourly, Date.UTC(2026, 0, 1, 10, 15, 0, 0))).toBe(
      Date.UTC(2026, 0, 1, 11, 0, 0, 0),
    )
    expect(nextFireAt(hourly, Date.UTC(2026, 0, 1, 10, 0, 0, 0))).toBe(
      Date.UTC(2026, 0, 1, 11, 0, 0, 0),
    )
    expect(nextFireAt(hourly, Date.UTC(2026, 0, 1, 23, 30, 0, 0))).toBe(
      Date.UTC(2026, 0, 2, 0, 0, 0, 0),
    )
  })

  test('@daily fires at the next midnight UTC', () => {
    const daily = expectOk('@daily')
    expect(nextFireAt(daily, Date.UTC(2026, 0, 1, 0, 0, 0, 0))).toBe(Date.UTC(2026, 0, 2, 0, 0, 0, 0))
    expect(nextFireAt(daily, Date.UTC(2025, 11, 31, 23, 59, 0, 0))).toBe(
      Date.UTC(2026, 0, 1, 0, 0, 0, 0),
    )
  })

  test('weekdays 0 9 * * 1-5 skip the weekend', () => {
    const weekdays = expectOk('0 9 * * 1-5')
    // 2026-01-02 is Friday; 2026-01-03 is Saturday; 2026-01-05 is Monday.
    expect(nextFireAt(weekdays, Date.UTC(2026, 0, 2, 8, 59, 59, 999))).toBe(
      Date.UTC(2026, 0, 2, 9, 0, 0, 0),
    )
    expect(nextFireAt(weekdays, Date.UTC(2026, 0, 2, 9, 0, 0, 0))).toBe(
      Date.UTC(2026, 0, 5, 9, 0, 0, 0),
    )
    expect(nextFireAt(weekdays, Date.UTC(2026, 0, 3, 10, 0, 0, 0))).toBe(
      Date.UTC(2026, 0, 5, 9, 0, 0, 0),
    )
  })

  test('lists, steps, and ranges', () => {
    const quarters = expectOk('*/15 * * * *')
    expect(nextFireAt(quarters, Date.UTC(2026, 0, 1, 10, 0, 0, 0))).toBe(
      Date.UTC(2026, 0, 1, 10, 15, 0, 0),
    )
    expect(nextFireAt(quarters, Date.UTC(2026, 0, 1, 10, 14, 59, 0))).toBe(
      Date.UTC(2026, 0, 1, 10, 15, 0, 0),
    )
    expect(nextFireAt(quarters, Date.UTC(2026, 0, 1, 10, 45, 0, 0))).toBe(
      Date.UTC(2026, 0, 1, 11, 0, 0, 0),
    )

    const halfHours = expectOk('0,30 * * * *')
    expect(nextFireAt(halfHours, Date.UTC(2026, 0, 1, 10, 0, 0, 0))).toBe(
      Date.UTC(2026, 0, 1, 10, 30, 0, 0),
    )
    expect(nextFireAt(halfHours, Date.UTC(2026, 0, 1, 10, 30, 0, 0))).toBe(
      Date.UTC(2026, 0, 1, 11, 0, 0, 0),
    )

    const stepped = expectOk('0-30/10 * * * *')
    expect(nextFireAt(stepped, Date.UTC(2026, 0, 1, 10, 0, 0, 0))).toBe(
      Date.UTC(2026, 0, 1, 10, 10, 0, 0),
    )
    expect(nextFireAt(stepped, Date.UTC(2026, 0, 1, 10, 30, 0, 0))).toBe(
      Date.UTC(2026, 0, 1, 11, 0, 0, 0),
    )
  })

  test('month and day-of-month', () => {
    const firsts = expectOk('0 0 1 * *')
    expect(nextFireAt(firsts, Date.UTC(2026, 0, 1, 0, 0, 0, 0))).toBe(
      Date.UTC(2026, 1, 1, 0, 0, 0, 0),
    )
    expect(nextFireAt(firsts, Date.UTC(2026, 0, 15, 12, 0, 0, 0))).toBe(
      Date.UTC(2026, 1, 1, 0, 0, 0, 0),
    )

    const newYears = expectOk('0 0 1 1 *')
    expect(nextFireAt(newYears, Date.UTC(2026, 0, 1, 0, 0, 0, 0))).toBe(
      Date.UTC(2027, 0, 1, 0, 0, 0, 0),
    )
  })

  test('Feb 29 lands on leap years only', () => {
    const leap = expectOk('0 0 29 2 *')
    expect(nextFireAt(leap, Date.UTC(2024, 1, 1, 0, 0, 0, 0))).toBe(Date.UTC(2024, 1, 29, 0, 0, 0, 0))
    expect(nextFireAt(leap, Date.UTC(2024, 1, 29, 0, 0, 0, 0))).toBe(
      Date.UTC(2028, 1, 29, 0, 0, 0, 0),
    )
  })

  test('restricted DOM or DOW uses POSIX either-or matching', () => {
    // 1st of month or Monday at midnight.
    const either = expectOk('0 0 1 * 1')
    // 2026-01-04 is Sunday; next Monday is 2026-01-05, before Feb 1.
    expect(nextFireAt(either, Date.UTC(2026, 0, 4, 12, 0, 0, 0))).toBe(
      Date.UTC(2026, 0, 5, 0, 0, 0, 0),
    )
    // After Monday Jan 5, next 1st is Feb 1 (Sunday), before the next Monday.
    expect(nextFireAt(either, Date.UTC(2026, 0, 5, 0, 0, 0, 0))).toBe(
      Date.UTC(2026, 0, 12, 0, 0, 0, 0),
    )
    // After Monday Jan 26, Feb 1 (Sunday, DOM) beats the next Monday.
    expect(nextFireAt(either, Date.UTC(2026, 0, 26, 0, 0, 0, 0))).toBe(
      Date.UTC(2026, 1, 1, 0, 0, 0, 0),
    )

    const firstOnly = expectOk('0 0 1 * *')
    expect(nextFireAt(firstOnly, Date.UTC(2026, 0, 5, 0, 0, 0, 0))).toBe(
      Date.UTC(2026, 1, 1, 0, 0, 0, 0),
    )
  })

  test('impossible dates throw', () => {
    const feb31 = expectOk('0 0 31 2 *')
    expect(() => nextFireAt(feb31, Date.UTC(2026, 0, 1))).toThrow(/no fire time/i)
  })
})

describe('formatSchedule', () => {
  test('uses s/m/h when evenly divisible, otherwise ms', () => {
    expect(formatSchedule({ kind: 'every', everyMs: 30_000 })).toBe('every 30s')
    expect(formatSchedule({ kind: 'every', everyMs: 5 * 60_000 })).toBe('every 5m')
    expect(formatSchedule({ kind: 'every', everyMs: 2 * 3_600_000 })).toBe('every 2h')
    expect(formatSchedule({ kind: 'every', everyMs: MIN_INTERVAL_MS })).toBe('every 15s')
    expect(formatSchedule({ kind: 'every', everyMs: 90_000 })).toBe('every 90s')
    expect(formatSchedule({ kind: 'every', everyMs: 120 * 60_000 })).toBe('every 2h')
    expect(formatSchedule({ kind: 'every', everyMs: 15_001 })).toBe('every 15001ms')
  })

  test('cron prints the expression', () => {
    expect(formatSchedule({ kind: 'cron', expr: '0 9 * * 1-5' })).toBe('0 9 * * 1-5')
    expect(formatSchedule(expectOk('@hourly'))).toBe('0 * * * *')
    expect(formatSchedule(expectOk('@daily'))).toBe('0 0 * * *')
  })

  test('parse then format round-trips the common interval units', () => {
    expect(formatSchedule(expectOk('every 30s'))).toBe('every 30s')
    expect(formatSchedule(expectOk('every 5m'))).toBe('every 5m')
    expect(formatSchedule(expectOk('every 2h'))).toBe('every 2h')
  })
})
