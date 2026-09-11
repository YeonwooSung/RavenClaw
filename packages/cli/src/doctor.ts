import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  OLLAMA_DEFAULT_HOST,
  VLLM_DEFAULT_BASE_URL,
  normalizeOpenAiBaseUrl,
  parseConfigYaml,
  ravenclawHome,
} from '@ravenclaw/core'

export type DoctorCheck = {
  name: string
  ok: boolean
  detail: string
}

export function runDoctor(opts?: { home?: string }): DoctorCheck[] {
  const home = opts?.home ?? ravenclawHome()
  const checks: DoctorCheck[] = []

  checks.push(checkHome(home))
  checks.push(checkEnv(home))
  checks.push(checkConfigYaml(home))
  checks.push(checkStateDb(home))
  checks.push(checkRuntime())
  return checks
}

export function formatDoctorReport(checks: DoctorCheck[]): string {
  return checks
    .map((check) => `${check.ok ? 'ok' : 'fail'}  ${check.name}  ${check.detail}`)
    .join('\n')
}

export function doctorFailed(checks: DoctorCheck[]): boolean {
  return checks.some((check) => !check.ok)
}

function checkHome(home: string): DoctorCheck {
  if (!existsSync(home)) {
    return { name: 'home', ok: false, detail: `${home} is missing (run raven setup)` }
  }
  return { name: 'home', ok: true, detail: home }
}

function checkEnv(home: string): DoctorCheck {
  const yamlPath = join(home, 'config.yaml')
  if (existsSync(yamlPath)) {
    try {
      const parsed = parseConfigYaml(readFileSync(yamlPath, 'utf8'))
      if (parsed.provider === 'ollama' || parsed.provider === 'vllm') {
        return { name: 'env', ok: true, detail: `provider ${parsed.provider} (no cloud key)` }
      }
    } catch {
      /* config check reports yaml errors */
    }
  }
  const path = join(home, '.env')
  if (!existsSync(path)) {
    return { name: 'env', ok: false, detail: `${path} is missing (run raven setup)` }
  }
  const text = readFileSync(path, 'utf8')
  const keys = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OLLAMA_HOST',
    'VLLM_BASE_URL',
  ] as const
  for (const key of keys) {
    const value = envValue(text, key)
    if (value !== undefined && value !== '') {
      return { name: 'env', ok: true, detail: `${key} is set (${value.length} chars)` }
    }
  }
  return {
    name: 'env',
    ok: false,
    detail: '.env has no API key or OLLAMA_HOST / VLLM_BASE_URL',
  }
}

function checkConfigYaml(home: string): DoctorCheck {
  const path = join(home, 'config.yaml')
  if (!existsSync(path)) {
    return { name: 'config', ok: true, detail: 'no config.yaml (defaults)' }
  }
  try {
    parseConfigYaml(readFileSync(path, 'utf8'))
    return { name: 'config', ok: true, detail: path }
  } catch (error) {
    return {
      name: 'config',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function checkStateDb(home: string): DoctorCheck {
  const path = join(home, 'state.db')
  if (!existsSync(path)) {
    return { name: 'db', ok: true, detail: 'no state.db yet (created on first session)' }
  }
  const bytes = statSync(path).size
  return { name: 'db', ok: true, detail: `${path} (${bytes} bytes)` }
}

function checkRuntime(): DoctorCheck {
  const bun = process.versions.bun
  if (bun === undefined || bun === '') {
    return { name: 'runtime', ok: false, detail: 'not running on Bun' }
  }
  return { name: 'runtime', ok: true, detail: `bun ${bun}` }
}

export type DoctorFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>

export async function probeLocalLlm(opts?: {
  home?: string
  fetch?: DoctorFetch
}): Promise<DoctorCheck | undefined> {
  const home = opts?.home ?? ravenclawHome()
  const target = resolveLocalLlmTarget(home)
  if (!target) return undefined
  const fetchFn = opts?.fetch ?? globalThis.fetch
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 2_000)
  try {
    const response = await fetchFn(target.probeUrl, { signal: ac.signal })
    if (!response.ok) {
      return {
        name: 'local',
        ok: false,
        detail: `${target.kind} ${target.displayUrl} HTTP error`,
      }
    }
    const names = modelNamesFromProbe(target.kind, await response.json())
    const listed = names.length > 0 ? names.slice(0, 5).join(', ') : 'reachable (no models listed)'
    return { name: 'local', ok: true, detail: `${target.kind} ${listed}` }
  } catch {
    return {
      name: 'local',
      ok: false,
      detail: `cannot reach ${target.kind} at ${target.displayUrl}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

function resolveLocalLlmTarget(
  home: string,
): { kind: 'ollama' | 'vllm'; probeUrl: string; displayUrl: string } | undefined {
  let provider: string | undefined
  const yamlPath = join(home, 'config.yaml')
  if (existsSync(yamlPath)) {
    try {
      provider = parseConfigYaml(readFileSync(yamlPath, 'utf8')).provider
    } catch {
      /* config check reports yaml errors */
    }
  }
  const envText = existsSync(join(home, '.env')) ? readFileSync(join(home, '.env'), 'utf8') : ''
  const ollamaHost = envValue(envText, 'OLLAMA_HOST')
  const vllmUrl = envValue(envText, 'VLLM_BASE_URL')
  if (provider === 'ollama' || (provider === undefined && ollamaHost !== undefined)) {
    const host = stripTrailingSlash(ollamaHost ?? OLLAMA_DEFAULT_HOST)
    const origin = host.replace(/\/v1$/i, '')
    return { kind: 'ollama', probeUrl: `${origin}/api/tags`, displayUrl: origin }
  }
  if (provider === 'vllm' || (provider === undefined && vllmUrl !== undefined)) {
    const base = normalizeOpenAiBaseUrl(vllmUrl ?? VLLM_DEFAULT_BASE_URL)
    return { kind: 'vllm', probeUrl: `${base}/models`, displayUrl: base }
  }
  return undefined
}

function modelNamesFromProbe(kind: 'ollama' | 'vllm', body: unknown): string[] {
  if (!body || typeof body !== 'object') return []
  if (kind === 'ollama') {
    const models = (body as { models?: unknown }).models
    if (!Array.isArray(models)) return []
    return models.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const name = (entry as { name?: unknown }).name
      return typeof name === 'string' && name !== '' ? [name] : []
    })
  }
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const id = (entry as { id?: unknown }).id
    return typeof id === 'string' && id !== '' ? [id] : []
  })
}

function stripTrailingSlash(raw: string): string {
  return raw.replace(/\/+$/, '')
}

function envValue(text: string, key: string): string | undefined {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text)
  if (!match?.[1]) return undefined
  let value = match[1].trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  return value
}
