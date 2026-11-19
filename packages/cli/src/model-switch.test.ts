import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootCli, openNewSession, resumeRuntime, type CliRuntime } from './engine'
import { dispatchSharedSlash, type SlashHost } from './slash/dispatch'

const tempDirs: string[] = []
const savedHome = process.env.RAVENCLAW_HOME
const savedFetch = globalThis.fetch
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OLLAMA_HOST',
  'OLLAMA_API_KEY',
  'VLLM_BASE_URL',
  'VLLM_API_KEY',
] as const
const savedEnv: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) savedEnv[key] = process.env[key]

afterEach(() => {
  globalThis.fetch = savedFetch
  if (savedHome === undefined) delete process.env.RAVENCLAW_HOME
  else process.env.RAVENCLAW_HOME = savedHome
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function anthropicHome(): string {
  return makeHome('ANTHROPIC_API_KEY=sk-ant\n', ['provider: anthropic', 'model: claude-sonnet-5'])
}

function makeHome(env: string, config: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'ravenclaw-model-switch-'))
  tempDirs.push(home)
  process.env.RAVENCLAW_HOME = home
  for (const key of ENV_KEYS) delete process.env[key]
  writeFileSync(join(home, '.env'), env)
  writeFileSync(join(home, 'config.yaml'), [...config, ''].join('\n'))
  return home
}

function host(get: () => CliRuntime): SlashHost & { notices: string[] } {
  const notices: string[] = []
  return {
    notices,
    runtime: get,
    notice(text) {
      notices.push(text)
    },
    runTurn() {},
  }
}

/** Record request URLs and fail each one with a non-retryable 400. */
function recordFetch(): string[] {
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return new Response('{"error":{"message":"stop"}}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return urls
}

async function submit(runtime: CliRuntime, text: string): Promise<void> {
  const gen = runtime.engine.submitMessage(text)
  while (true) {
    const next = await gen.next()
    if (next.done) return
  }
}

describe('cross-kind /model survives new sessions and resume', () => {
  test('/model updates runtime.provider and config.provider', async () => {
    anthropicHome()
    let runtime = await bootCli({ flags: {}, cwd: '/tmp' })
    try {
      expect(runtime.provider.id).toBe('anthropic')
      const h = host(() => runtime)
      await dispatchSharedSlash({ type: 'command', name: 'model', arg: 'ollama/qwen' }, h)
      expect(h.notices).toEqual(['model ollama/qwen'])
      expect(runtime.provider.id).toBe('ollama')
      expect(runtime.config.provider).toBe('ollama')
    } finally {
      await runtime.engine.close()
      ;(runtime.store as { close?: () => void }).close?.()
    }
  })

  test('/model cross-kind then /new sends the new session to the resolved-kind provider', async () => {
    anthropicHome()
    let runtime = await bootCli({ flags: {}, cwd: '/tmp' })
    try {
      const h = host(() => runtime)
      await dispatchSharedSlash({ type: 'command', name: 'model', arg: 'ollama/qwen' }, h)
      runtime = await openNewSession(runtime)
      expect(runtime.engine.session.model).toBe('ollama/qwen')
      expect(runtime.provider.id).toBe('ollama')
      const urls = recordFetch()
      await submit(runtime, 'hi')
      expect(urls.length).toBeGreaterThan(0)
      expect(urls.every((url) => url.startsWith('http://127.0.0.1:11434/'))).toBe(true)
      const same = runtime.modelResolver!.resolve('ollama/qwen')
      expect(same.ok && same.provider).toBe(runtime.provider)
    } finally {
      await runtime.engine.close()
      ;(runtime.store as { close?: () => void }).close?.()
    }
  })

  test('resume of a session whose model kind differs from config.provider uses that kind', async () => {
    anthropicHome()
    let runtime = await bootCli({ flags: {}, cwd: '/tmp' })
    try {
      const h = host(() => runtime)
      await dispatchSharedSlash({ type: 'command', name: 'model', arg: 'ollama/qwen' }, h)
      const switchedId = runtime.engine.session.id
      // Back on the configured kind, as a fresh process would be.
      runtime.config.provider = 'anthropic'
      runtime.config.model = 'claude-sonnet-5'
      runtime = await resumeRuntime(runtime, switchedId)
      expect(runtime.engine.session.model).toBe('ollama/qwen')
      expect(runtime.provider.id).toBe('ollama')
      const urls = recordFetch()
      await submit(runtime, 'hi')
      expect(urls.length).toBeGreaterThan(0)
      expect(urls.every((url) => url.startsWith('http://127.0.0.1:11434/'))).toBe(true)
    } finally {
      await runtime.engine.close()
      ;(runtime.store as { close?: () => void }).close?.()
    }
  })

  test('unprefixed /model back to the live kind restores config.provider before /new', async () => {
    makeHome('ANTHROPIC_API_KEY=sk-ant\n', ['provider: ollama', 'model: qwen3:8b'])
    let runtime = await bootCli({ flags: {}, cwd: '/tmp' })
    try {
      const h = host(() => runtime)
      await dispatchSharedSlash({ type: 'command', name: 'model', arg: 'claude-opus-5' }, h)
      expect(runtime.provider.id).toBe('anthropic')
      expect(runtime.config.provider).toBe('anthropic')
      await dispatchSharedSlash({ type: 'command', name: 'model', arg: 'qwen3:8b' }, h)
      expect(h.notices).toEqual(['model claude-opus-5', 'model qwen3:8b'])
      expect(runtime.provider.id).toBe('ollama')
      expect(runtime.config.provider).toBe('ollama')
      runtime = await openNewSession(runtime)
      expect(runtime.engine.session.model).toBe('qwen3:8b')
      expect(runtime.provider.id).toBe('ollama')
      const urls = recordFetch()
      await submit(runtime, 'hi')
      expect(urls.length).toBeGreaterThan(0)
      expect(urls.every((url) => url.startsWith('http://127.0.0.1:11434/'))).toBe(true)
    } finally {
      await runtime.engine.close()
      ;(runtime.store as { close?: () => void }).close?.()
    }
  })

  test('vllm serving openai/ ids keeps config.provider vllm across /model and /new', async () => {
    makeHome('VLLM_BASE_URL=http://127.0.0.1:8000/v1\n', [
      'provider: vllm',
      'model: openai/gpt-oss-120b',
    ])
    let runtime = await bootCli({ flags: {}, cwd: '/tmp' })
    try {
      const live = runtime.provider
      expect(live.id).toBe('vllm')
      const h = host(() => runtime)
      await dispatchSharedSlash({ type: 'command', name: 'model', arg: 'openai/gpt-oss-20b' }, h)
      expect(h.notices).toEqual(['model openai/gpt-oss-20b'])
      expect(runtime.provider).toBe(live)
      expect(runtime.config.provider).toBe('vllm')
      runtime = await openNewSession(runtime)
      expect(runtime.engine.session.model).toBe('openai/gpt-oss-20b')
      expect(runtime.provider.id).toBe('vllm')
      const urls = recordFetch()
      await submit(runtime, 'hi')
      expect(urls.length).toBeGreaterThan(0)
      expect(urls.every((url) => url.startsWith('http://127.0.0.1:8000/'))).toBe(true)
    } finally {
      await runtime.engine.close()
      ;(runtime.store as { close?: () => void }).close?.()
    }
  })
})
