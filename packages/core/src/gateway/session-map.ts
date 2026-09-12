import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type SessionMap = Record<string, string>

export function gatewaySessionsPath(home: string): string {
  return join(home, 'gateway', 'sessions.json')
}

export function loadSessionMap(home: string): SessionMap {
  const path = gatewaySessionsPath(home)
  if (!existsSync(path)) return {}
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`invalid gateway sessions file: ${path}`)
  }
  const out: SessionMap = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

export function saveSessionMap(map: SessionMap, home: string): void {
  const path = gatewaySessionsPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`, 'utf8')
}

export function resolveSessionId(
  map: SessionMap,
  key: string,
  createId: () => string,
): { id: string; created: boolean } {
  const existing = map[key]
  if (existing !== undefined && existing !== '') return { id: existing, created: false }
  const id = createId()
  map[key] = id
  return { id, created: true }
}
