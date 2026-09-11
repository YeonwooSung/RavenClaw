import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorFailed, formatDoctorReport, probeLocalLlm, runDoctor } from './doctor'

function tempHome(suffix: string): string {
  const dir = join(tmpdir(), `raven-doctor-${suffix}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('runDoctor', () => {
  test('missing home and env fail; missing db is ok', () => {
    const home = join(tmpdir(), `raven-doctor-missing-${Date.now()}`)
    const checks = runDoctor({ home })
    expect(checks.find((c) => c.name === 'home')?.ok).toBe(false)
    expect(checks.find((c) => c.name === 'env')?.ok).toBe(false)
    expect(checks.find((c) => c.name === 'db')?.ok).toBe(true)
    expect(checks.find((c) => c.name === 'config')?.ok).toBe(true)
    expect(doctorFailed(checks)).toBe(true)
  })

  test('reports key presence without echoing the secret', () => {
    const home = tempHome('ok')
    writeFileSync(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-ant-secret-value\n', { mode: 0o600 })
    const checks = runDoctor({ home })
    const env = checks.find((c) => c.name === 'env')
    expect(env?.ok).toBe(true)
    expect(env?.detail).toContain('ANTHROPIC_API_KEY is set')
    expect(env?.detail).toMatch(/\(\d+ chars\)/)
    expect(formatDoctorReport(checks)).not.toContain('sk-ant-secret-value')
    expect(doctorFailed(checks)).toBe(false)
  })

  test('present config.yaml is reported ok', () => {
    const home = tempHome('yaml')
    writeFileSync(join(home, '.env'), 'OPENAI_API_KEY=sk-test\n')
    writeFileSync(join(home, 'config.yaml'), 'permissionMode: default\n')
    const checks = runDoctor({ home })
    expect(checks.find((c) => c.name === 'config')?.ok).toBe(true)
    expect(checks.find((c) => c.name === 'config')?.detail).toContain('config.yaml')
    expect(doctorFailed(checks)).toBe(false)
  })

  test('skips local probe when no ollama/vllm is configured', async () => {
    const home = tempHome('no-local')
    writeFileSync(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-test\n')
    expect(await probeLocalLlm({ home, fetch: async () => { throw new Error('no fetch') } })).toBeUndefined()
  })

  test('probes ollama /api/tags and lists model names', async () => {
    const home = tempHome('ollama')
    writeFileSync(join(home, 'config.yaml'), 'provider: ollama\n')
    const seen: string[] = []
    const check = await probeLocalLlm({
      home,
      fetch: async (url) => {
        seen.push(url)
        return {
          ok: true,
          async json() {
            return { models: [{ name: 'llama3.2:1b' }] }
          },
        }
      },
    })
    expect(seen[0]).toContain('/api/tags')
    expect(check).toEqual({ name: 'local', ok: true, detail: 'ollama llama3.2:1b' })
  })

  test('fails when the local endpoint is unreachable', async () => {
    const home = tempHome('down')
    writeFileSync(join(home, '.env'), 'OLLAMA_HOST=http://127.0.0.1:11434\n')
    const check = await probeLocalLlm({
      home,
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('cannot reach ollama')
  })
})
