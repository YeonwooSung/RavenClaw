export interface Entitlement {
  admitted: boolean
  placementRequired: boolean
  hasPaidCapacityPlan: boolean
  sessionCap?: number
  remainingSessions?: number
  defaultModel?: string
}

export interface ProbeEntitlementOptions {
  fetch?: (input: string, init?: RequestInit) => Promise<Response> | Response
  token?: string
}

const TIMEOUT_MS = 2_000

const DENIED: Entitlement = {
  admitted: false,
  placementRequired: false,
  hasPaidCapacityPlan: false,
}

export async function probeEntitlement(
  baseUrl: string,
  opts?: ProbeEntitlementOptions,
): Promise<Entitlement> {
  const fetchImpl = opts?.fetch ?? globalThis.fetch
  const url = `${stripTrailingSlash(baseUrl)}/v1/entitlement`
  const headers: Record<string, string> = { accept: 'application/json' }
  if (opts?.token !== undefined && opts.token !== '') {
    headers.authorization = `Bearer ${opts.token}`
  }
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return { ...DENIED }
    const raw: unknown = await response.json()
    return parseEntitlement(raw)
  } catch {
    return { ...DENIED }
  }
}

function parseEntitlement(raw: unknown): Entitlement {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DENIED }
  const rec = raw as Record<string, unknown>
  const out: Entitlement = {
    admitted: rec.admitted === true,
    placementRequired: rec.placementRequired === true,
    hasPaidCapacityPlan: rec.hasPaidCapacityPlan === true,
  }
  const sessionCap = asFiniteNumber(rec.sessionCap)
  if (sessionCap !== undefined) out.sessionCap = sessionCap
  const remainingSessions = asFiniteNumber(rec.remainingSessions)
  if (remainingSessions !== undefined) out.remainingSessions = remainingSessions
  if (typeof rec.defaultModel === 'string' && rec.defaultModel !== '') {
    out.defaultModel = rec.defaultModel
  }
  return out
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stripTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}
