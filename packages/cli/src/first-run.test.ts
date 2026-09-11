import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SETUP_HINT,
  parseProviderChoice,
  providerConfigured,
  runFirstRun,
  writeEnvKey,
} from './first-run'

function tempHome(suffix: string): string {
  const dir = join(tmpdir(), `raven-setup-${suffix}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function* lines(...values: string[]): AsyncIterable<string> {
  for (const value of values) yield value
}

describe('parseProviderChoice', () => {
  test('accepts 1 / anthropic and 2 / openai', () => {
    expect(parseProviderChoice('1')).toBe('anthropic')
    expect(parseProviderChoice('Anthropic')).toBe('anthropic')
    expect(parseProviderChoice('2')).toBe('openai_compat')
    expect(parseProviderChoice('openai')).toBe('openai_compat')
    expect(parseProviderChoice('nope')).toBeUndefined()
  })
})

describe('writeEnvKey', () => {
  test('creates a 0600 file and replaces an existing key', () => {
    const home = tempHome('env')
    const path = join(home, '.env')
    writeEnvKey(path, 'ANTHROPIC_API_KEY', 'sk-one')
    expect(readFileSync(path, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-one\n')
    writeEnvKey(path, 'ANTHROPIC_API_KEY', 'sk-two')
    expect(readFileSync(path, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-two\n')
    chmodSync(path, 0o600)
  })
})

describe('providerConfigured', () => {
  test('false when home has no keys', () => {
    expect(providerConfigured(tempHome('empty'))).toBe(false)
  })

  test('true when .env has ANTHROPIC_API_KEY', () => {
    const home = tempHome('key')
    writeFileSync(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-test\n', { mode: 0o600 })
    expect(providerConfigured(home)).toBe(true)
  })
})

describe('runFirstRun', () => {
  test('writes Anthropic key after 1 + secret', async () => {
    const home = tempHome('run')
    const out: string[] = []
    const ok = await runFirstRun({
      home,
      input: lines('1', 'sk-ant-test'),
      write: (chunk) => {
        out.push(chunk)
      },
    })
    expect(ok).toBe(true)
    expect(readFileSync(join(home, '.env'), 'utf8')).toBe('ANTHROPIC_API_KEY=sk-ant-test\n')
    expect(out.join('')).toContain('ANTHROPIC_API_KEY')
    expect(providerConfigured(home)).toBe(true)
  })

  test('readSecret is used and the key is never written to the prompt stream', async () => {
    const home = tempHome('secret')
    const out: string[] = []
    const ok = await runFirstRun({
      home,
      input: lines('1'),
      write: (chunk) => {
        out.push(chunk)
      },
      readSecret: async () => 'sk-ant-secret-value',
    })
    expect(ok).toBe(true)
    expect(out.join('')).not.toContain('sk-ant-secret-value')
    expect(readFileSync(join(home, '.env'), 'utf8')).toContain('sk-ant-secret-value')
  })

  test('empty key cancels without writing', async () => {
    const home = tempHome('cancel')
    const ok = await runFirstRun({
      home,
      input: lines('2', ''),
      write: () => {},
    })
    expect(ok).toBe(false)
    expect(providerConfigured(home)).toBe(false)
  })

  test('setup hint mentions raven and env vars', () => {
    expect(SETUP_HINT).toContain('raven')
    expect(SETUP_HINT).toContain('ANTHROPIC_API_KEY')
  })
})
