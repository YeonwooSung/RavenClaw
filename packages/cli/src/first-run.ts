import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type ConfigFlags } from '@ravenclaw/core'

export const SETUP_HINT =
  'No provider configured. Run `raven` in a terminal, or set ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_HOST / VLLM_BASE_URL.'

const ANTHROPIC_KEY = 'ANTHROPIC_API_KEY'
const OPENAI_KEY = 'OPENAI_API_KEY'

export function providerConfigured(home: string, flags?: ConfigFlags): boolean {
  try {
    loadConfig({ home, flags })
    return true
  } catch {
    return false
  }
}

export async function runFirstRun(opts: {
  home: string
  input: AsyncIterable<string>
  write: (chunk: string) => void
  readSecret?: () => Promise<string | undefined>
}): Promise<boolean> {
  const read = lineReader(opts.input)
  opts.write('No API key found. Set one up to use RavenClaw.\n')
  opts.write('Provider [1] Anthropic  [2] OpenAI  [3] Ollama  [4] vLLM: ')
  const choice = (await read())?.trim() ?? ''
  const kind = parseProviderChoice(choice)
  if (!kind) {
    opts.write('Cancelled. Expected 1, 2, 3, or 4.\n')
    return false
  }

  if (kind === 'ollama') {
    writeEnvKey(join(opts.home, '.env'), 'OLLAMA_HOST', 'http://127.0.0.1:11434')
    opts.write(`Wrote OLLAMA_HOST to ${join(opts.home, '.env')}. Default model llama3.2.\n`)
    opts.write('Pull a model first: ollama pull llama3.2\n')
    return true
  }
  if (kind === 'vllm') {
    writeEnvKey(join(opts.home, '.env'), 'VLLM_BASE_URL', 'http://127.0.0.1:8000/v1')
    opts.write(`Wrote VLLM_BASE_URL to ${join(opts.home, '.env')}. Pass --model <served-name>.\n`)
    return true
  }

  const envName = kind === 'anthropic' ? ANTHROPIC_KEY : OPENAI_KEY
  opts.write(`${envName}: `)
  const raw = opts.readSecret ? await opts.readSecret() : await read()
  const key = raw?.trim() ?? ''
  if (key === '') {
    opts.write('Cancelled. Empty key.\n')
    return false
  }

  writeEnvKey(join(opts.home, '.env'), envName, key)
  opts.write(`Wrote ${envName} to ${join(opts.home, '.env')} (mode 0600).\n`)
  return true
}

export function parseProviderChoice(
  raw: string,
): 'anthropic' | 'openai_compat' | 'ollama' | 'vllm' | undefined {
  const key = raw.trim().toLowerCase()
  if (key === '1' || key === 'anthropic' || key === 'a') return 'anthropic'
  if (key === '2' || key === 'openai' || key === 'openai_compat' || key === 'o') {
    return 'openai_compat'
  }
  if (key === '3' || key === 'ollama') return 'ollama'
  if (key === '4' || key === 'vllm') return 'vllm'
  return undefined
}

export function writeEnvKey(path: string, name: string, value: string): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const re = new RegExp(`^${name}=.*$`, 'm')
  let next: string
  if (re.test(existing)) {
    next = existing.replace(re, `${name}=${value}`)
  } else if (existing === '' || existing.endsWith('\n')) {
    next = `${existing}${name}=${value}\n`
  } else {
    next = `${existing}\n${name}=${value}\n`
  }
  if (!next.endsWith('\n')) next += '\n'
  writeFileSync(path, next, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function lineReader(source: AsyncIterable<string>): () => Promise<string | undefined> {
  const iterator = source[Symbol.asyncIterator]()
  return async () => {
    const next = await iterator.next()
    return next.done ? undefined : next.value
  }
}
