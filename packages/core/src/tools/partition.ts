import type { Tool } from '../types'

const DEFAULT_PARALLEL_CAP = 8
const FILE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write'])
const MUTATING_FILE_TOOLS = new Set(['Edit', 'Write'])

export function partitionToolCalls(
  calls: Array<{ id: string; name: string; input: unknown }>,
  tools: Tool[],
  opts?: { cap?: number },
): Array<Array<{ id: string; name: string; input: unknown }>> {
  const cap = opts?.cap ?? DEFAULT_PARALLEL_CAP
  const byName = new Map<string, Tool>()
  for (const tool of tools) byName.set(tool.name, tool)

  type Prepared = {
    call: { id: string; name: string; input: unknown }
    serial: boolean
    mutating: boolean
    value: unknown
  }

  const prepared: Prepared[] = calls.map((call) => {
    const tool = byName.get(call.name)
    if (!tool) {
      return { call, serial: true, mutating: MUTATING_FILE_TOOLS.has(call.name), value: call.input }
    }
    let parsed: { ok: true; value: unknown } | { ok: false; message: string }
    try {
      parsed = tool.parse(call.input)
    } catch {
      return { call, serial: true, mutating: MUTATING_FILE_TOOLS.has(call.name), value: call.input }
    }
    if (!parsed.ok) {
      return { call, serial: true, mutating: MUTATING_FILE_TOOLS.has(call.name), value: call.input }
    }
    const safe = tool.isConcurrencySafe(parsed.value)
    return {
      call,
      serial: !safe,
      mutating: MUTATING_FILE_TOOLS.has(call.name),
      value: parsed.value,
    }
  })

  const batches: Array<Array<{ id: string; name: string; input: unknown }>> = []
  let current: Prepared[] = []

  function flush(): void {
    if (current.length === 0) return
    batches.push(current.map((item) => item.call))
    current = []
  }

  for (const item of prepared) {
    if (item.serial) {
      flush()
      batches.push([item.call])
      continue
    }

    const overlap = current.some((existing) => filePathConflict(existing, item))
    if (overlap) {
      flush()
      if (item.mutating) {
        batches.push([item.call])
        continue
      }
    }

    if (current.length >= cap) flush()
    current.push(item)
  }
  flush()
  return batches
}

function filePathConflict(a: { call: { name: string }; value: unknown }, b: {
  call: { name: string }
  value: unknown
}): boolean {
  if (!FILE_TOOLS.has(a.call.name) || !FILE_TOOLS.has(b.call.name)) return false
  if (!MUTATING_FILE_TOOLS.has(a.call.name) && !MUTATING_FILE_TOOLS.has(b.call.name)) {
    return false
  }
  const pathA = seenPath(a.value)
  const pathB = seenPath(b.value)
  if (pathA === undefined || pathB === undefined) return false
  return pathsOverlap(pathA, pathB)
}

function seenPath(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (!('path' in value)) return undefined
  const path = (value as { path: unknown }).path
  if (typeof path !== 'string' || path.length === 0) return undefined
  return path
}

function pathsOverlap(a: string, b: string): boolean {
  const na = normalizePath(a)
  const nb = normalizePath(b)
  if (na === nb) return true
  return na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`)
}

function normalizePath(path: string): string {
  let out = path.replace(/\\/g, '/')
  if (out.startsWith('./')) out = out.slice(2)
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}
