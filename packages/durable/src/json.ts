import { DurableFault } from './errors.ts'
import type { JsonObject, JsonValue } from './storage/types.ts'

export function assertStrictJson(value: unknown): JsonValue {
  return walk(value, new WeakSet<object>())
}

export function copyStrict<T>(value: T): T {
  return JSON.parse(JSON.stringify(assertStrictJson(value))) as T
}

function walk(value: unknown, seen: WeakSet<object>): JsonValue {
  if (value === null) return null
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DurableFault('non-finite number')
    return value
  }
  if (typeof value === 'bigint') throw new DurableFault('bigint')
  if (typeof value === 'undefined') throw new DurableFault('undefined')
  if (typeof value === 'function' || typeof value === 'symbol') throw new DurableFault('non-json value')
  if (typeof value !== 'object') throw new DurableFault('non-json value')
  if (seen.has(value)) throw new DurableFault('cycle')
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, seen))
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) throw new DurableFault('non-plain object')
    if (Object.getOwnPropertySymbols(value).length > 0) throw new DurableFault('symbol key')
    const out: JsonObject = {}
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined) throw new DurableFault('undefined')
      out[key] = walk(item, seen)
    }
    return out
  } finally {
    seen.delete(value)
  }
}
