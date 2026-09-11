import { MIN_INTERVAL_MS, type JobSchedule } from './types'

type ParseResult =
  | { ok: true; schedule: JobSchedule }
  | { ok: false; message: string }

const EVERY_RE = /^every\s+(\d+)([smh])$/

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 6 },
] as const

interface CompiledCron {
  expr: string
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domStar: boolean
  dowStar: boolean
}

export function parseJobSpec(raw: string): ParseResult {
  const trimmed = raw.trim()
  if (trimmed === '') return fail('empty schedule')

  if (trimmed === '@hourly') return { ok: true, schedule: { kind: 'cron', expr: '0 * * * *' } }
  if (trimmed === '@daily') return { ok: true, schedule: { kind: 'cron', expr: '0 0 * * *' } }

  const every = EVERY_RE.exec(trimmed)
  if (every) {
    const n = parseIntToken(every[1] ?? '')
    const unit = every[2]
    if (n === undefined || unit === undefined) return fail('expected every <n>s|m|h')
    const everyMs = unit === 's' ? n * 1_000 : unit === 'm' ? n * 60_000 : n * 3_600_000
    if (!Number.isSafeInteger(everyMs) || everyMs < MIN_INTERVAL_MS) {
      return fail(`interval must be at least ${MIN_INTERVAL_MS}ms`)
    }
    return { ok: true, schedule: { kind: 'every', everyMs } }
  }

  if (trimmed.startsWith('every')) return fail('expected every <n>s|m|h')
  if (trimmed.startsWith('@')) return fail(`unknown schedule alias '${trimmed}'`)

  const compiled = compileCron(trimmed)
  if (!compiled.ok) return compiled
  return { ok: true, schedule: { kind: 'cron', expr: compiled.cron.expr } }
}

export function nextFireAt(schedule: JobSchedule, fromMs: number): number {
  if (schedule.kind === 'every') return fromMs + schedule.everyMs
  return nextCronFire(schedule.expr, fromMs)
}

export function formatSchedule(schedule: JobSchedule): string {
  if (schedule.kind === 'cron') return schedule.expr
  const ms = schedule.everyMs
  if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `every ${ms / 60_000}m`
  if (ms % 1_000 === 0) return `every ${ms / 1_000}s`
  return `every ${ms}ms`
}

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message }
}

function parseIntToken(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : undefined
}

function compileCron(raw: string): { ok: true; cron: CompiledCron } | { ok: false; message: string } {
  const fields = raw.trim().split(/\s+/)
  if (fields.length !== 5) return fail('cron must have 5 fields (min hour dom month dow)')

  const parsed: Array<Set<number>> = []
  for (let i = 0; i < FIELDS.length; i++) {
    const spec = FIELDS[i]
    const field = fields[i]
    if (!spec || field === undefined) return fail('cron must have 5 fields (min hour dom month dow)')
    const result = parseField(field, spec.min, spec.max, spec.name)
    if (!result.ok) return result
    parsed.push(result.values)
  }

  const minute = parsed[0]
  const hour = parsed[1]
  const dom = parsed[2]
  const month = parsed[3]
  const dow = parsed[4]
  if (!minute || !hour || !dom || !month || !dow) {
    return fail('cron must have 5 fields (min hour dom month dow)')
  }

  return {
    ok: true,
    cron: {
      expr: fields.join(' '),
      minute,
      hour,
      dom,
      month,
      dow,
      domStar: fields[2] === '*',
      dowStar: fields[4] === '*',
    },
  }
}

function parseField(
  raw: string,
  min: number,
  max: number,
  name: string,
): { ok: true; values: Set<number> } | { ok: false; message: string } {
  if (raw === '') return fail(`empty ${name} field`)
  const values = new Set<number>()
  for (const part of raw.split(',')) {
    const result = parseFieldPart(part, min, max, name)
    if (!result.ok) return result
    for (const value of result.values) values.add(value)
  }
  return { ok: true, values }
}

function parseFieldPart(
  part: string,
  min: number,
  max: number,
  name: string,
): { ok: true; values: number[] } | { ok: false; message: string } {
  if (part === '') return fail(`empty ${name} field`)

  const star = /^\*(?:\/(\d+))?$/.exec(part)
  if (star) {
    const step = star[1] === undefined ? 1 : parseIntToken(star[1])
    if (step === undefined || step < 1) return fail(`invalid ${name} step`)
    return { ok: true, values: steppedRange(min, max, step) }
  }

  const ranged = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part)
  if (ranged) {
    const start = parseIntToken(ranged[1] ?? '')
    const end = parseIntToken(ranged[2] ?? '')
    const step = ranged[3] === undefined ? 1 : parseIntToken(ranged[3])
    if (start === undefined || end === undefined || step === undefined || step < 1) {
      return fail(`invalid ${name} field`)
    }
    if (start < min || start > max || end < min || end > max) return fail(`${name} out of range`)
    if (start > end) return fail(`invalid ${name} range`)
    return { ok: true, values: steppedRange(start, end, step) }
  }

  const single = parseIntToken(part)
  if (single === undefined) return fail(`invalid ${name} field`)
  if (single < min || single > max) return fail(`${name} out of range`)
  return { ok: true, values: [single] }
}

function steppedRange(start: number, end: number, step: number): number[] {
  const values: number[] = []
  for (let value = start; value <= end; value += step) values.push(value)
  return values
}

function nextCronFire(expr: string, fromMs: number): number {
  const compiled = compileCron(expr)
  if (!compiled.ok) throw new Error(compiled.message)

  const cron = compiled.cron
  const date = new Date(fromMs)
  date.setUTCSeconds(0, 0)
  date.setUTCMinutes(date.getUTCMinutes() + 1)

  const firstMinute = minOf(cron.minute)
  const firstHour = minOf(cron.hour)
  const deadline = Date.UTC(date.getUTCFullYear() + 5, date.getUTCMonth(), date.getUTCDate())

  while (date.getTime() <= deadline) {
    const month = date.getUTCMonth() + 1
    if (!cron.month.has(month)) {
      rollMonth(date, cron.month, firstHour, firstMinute)
      continue
    }

    if (!dayMatches(date, cron)) {
      date.setUTCDate(date.getUTCDate() + 1)
      date.setUTCHours(firstHour, firstMinute, 0, 0)
      continue
    }

    const hour = date.getUTCHours()
    if (!cron.hour.has(hour)) {
      const nextHour = nextAtOrAfter(cron.hour, hour + 1)
      if (nextHour === undefined) {
        date.setUTCDate(date.getUTCDate() + 1)
        date.setUTCHours(firstHour, firstMinute, 0, 0)
      } else {
        date.setUTCHours(nextHour, firstMinute, 0, 0)
      }
      continue
    }

    const minute = date.getUTCMinutes()
    if (!cron.minute.has(minute)) {
      const nextMinute = nextAtOrAfter(cron.minute, minute + 1)
      if (nextMinute === undefined) {
        date.setUTCHours(hour + 1, firstMinute, 0, 0)
      } else {
        date.setUTCMinutes(nextMinute, 0, 0)
      }
      continue
    }

    return date.getTime()
  }

  throw new Error(`no fire time for cron '${expr}'`)
}

// When both DOM and DOW are restricted, either may match (POSIX cron).
function dayMatches(date: Date, cron: CompiledCron): boolean {
  const domMatch = cron.dom.has(date.getUTCDate())
  const dowMatch = cron.dow.has(date.getUTCDay())
  if (cron.domStar && cron.dowStar) return true
  if (cron.domStar) return dowMatch
  if (cron.dowStar) return domMatch
  return domMatch || dowMatch
}

function rollMonth(date: Date, months: Set<number>, hour: number, minute: number): void {
  let year = date.getUTCFullYear()
  let month = date.getUTCMonth() + 1
  for (let i = 0; i < 24; i++) {
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
    if (months.has(month)) {
      date.setUTCFullYear(year, month - 1, 1)
      date.setUTCHours(hour, minute, 0, 0)
      return
    }
  }
  date.setUTCFullYear(year + 1, 0, 1)
  date.setUTCHours(hour, minute, 0, 0)
}

function minOf(values: Set<number>): number {
  let min = Number.POSITIVE_INFINITY
  for (const value of values) if (value < min) min = value
  return min
}

function nextAtOrAfter(values: Set<number>, start: number): number | undefined {
  let next: number | undefined
  for (const value of values) {
    if (value >= start && (next === undefined || value < next)) next = value
  }
  return next
}
