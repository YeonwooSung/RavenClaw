import {
  normalizeOpenAiBaseUrl,
  OLLAMA_DEFAULT_HOST,
  VLLM_DEFAULT_BASE_URL,
  type Provider,
  type ProviderKind,
  type ResolvedConfig,
} from '@ravenclaw/core'
import { createProvider } from './registry'

/** BYOK provider for `kind` serving `modelId`, keyed from `config.env`. Throws on a missing key. */
export function byokProviderFactory(
  kind: ProviderKind,
  modelId: string,
  config: ResolvedConfig,
): Provider {
  if (kind === 'ollama') {
    return createProvider({
      provider: 'ollama',
      apiKey: firstNonEmpty(config.env.OLLAMA_API_KEY) ?? 'ollama',
      baseUrl: normalizeOpenAiBaseUrl(config.env.OLLAMA_HOST ?? OLLAMA_DEFAULT_HOST),
      defaultModel: modelId,
    })
  }
  if (kind === 'vllm') {
    return createProvider({
      provider: 'vllm',
      apiKey: firstNonEmpty(config.env.VLLM_API_KEY, config.env.OPENAI_API_KEY) ?? 'vllm',
      baseUrl: normalizeOpenAiBaseUrl(config.env.VLLM_BASE_URL ?? VLLM_DEFAULT_BASE_URL),
      defaultModel: modelId,
    })
  }
  if (kind === 'orcarouter') {
    const apiKey = firstNonEmpty(config.env.ORCAROUTER_API_KEY)
    if (apiKey === undefined) throw new Error('missing ORCAROUTER_API_KEY')
    const ctor: Parameters<typeof createProvider>[0] = {
      provider: 'orcarouter',
      apiKey,
      defaultModel: modelId,
    }
    if (config.env.ORCAROUTER_BASE_URL) {
      ctor.baseUrl = normalizeOpenAiBaseUrl(config.env.ORCAROUTER_BASE_URL)
    }
    return createProvider(ctor)
  }
  const apiKey = kind === 'anthropic' ? config.env.ANTHROPIC_API_KEY : config.env.OPENAI_API_KEY
  if (apiKey === undefined || apiKey === '') {
    throw new Error(kind === 'anthropic' ? 'missing ANTHROPIC_API_KEY' : 'missing OPENAI_API_KEY')
  }
  const ctor: Parameters<typeof createProvider>[0] = {
    provider: kind,
    apiKey,
    defaultModel: modelId,
  }
  if (kind === 'openai_compat' && config.env.OPENAI_BASE_URL) {
    ctor.baseUrl = config.env.OPENAI_BASE_URL
  }
  return createProvider(ctor)
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== '') return value
  }
  return undefined
}
