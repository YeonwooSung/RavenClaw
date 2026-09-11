import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseConfigYaml, ravenclawHome } from '@ravenclaw/core'

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
