import type { Provider } from '@ravenclaw/core'
import { AnthropicMessagesProvider } from './anthropic'
import { createIncludedGatewayProvider } from './gateway'
import { OpenAICompatProvider } from './openai-compat'
import { OpenAIResponsesProvider } from './responses'

export function createProvider(opts: {
  provider: 'anthropic' | 'openai_compat' | 'openai_responses' | 'included' | 'ollama' | 'vllm'
  apiKey: string
  baseUrl?: string
  gatewayUrl?: string
  defaultModel?: string
}): Provider {
  const ctor: { apiKey: string; baseUrl?: string; defaultModel?: string; id?: string } = {
    apiKey: opts.apiKey,
  }
  if (opts.baseUrl !== undefined) ctor.baseUrl = opts.baseUrl
  if (opts.defaultModel !== undefined) ctor.defaultModel = opts.defaultModel
  if (opts.provider === 'ollama') {
    ctor.id = 'ollama'
    ctor.apiKey = opts.apiKey === '' ? 'ollama' : opts.apiKey
    ctor.baseUrl = opts.baseUrl ?? 'http://127.0.0.1:11434/v1'
    return new OpenAICompatProvider(ctor)
  }
  if (opts.provider === 'vllm') {
    ctor.id = 'vllm'
    ctor.apiKey = opts.apiKey === '' ? 'vllm' : opts.apiKey
    ctor.baseUrl = opts.baseUrl ?? 'http://127.0.0.1:8000/v1'
    return new OpenAICompatProvider(ctor)
  }
  if (opts.provider === 'anthropic') return new AnthropicMessagesProvider(ctor)
  if (opts.provider === 'openai_responses') return new OpenAIResponsesProvider(ctor)
  if (opts.provider === 'included') {
    const baseUrl = firstNonEmpty(opts.baseUrl, opts.gatewayUrl)
    if (baseUrl === undefined) {
      throw new Error(
        'Included-model gateway is not configured. Set included.gatewayUrl in config.yaml or pass baseUrl. First public release is BYOK-default.',
      )
    }
    const included: { baseUrl: string; apiKey: string; defaultModel?: string } = {
      baseUrl,
      apiKey: opts.apiKey,
    }
    if (opts.defaultModel !== undefined) included.defaultModel = opts.defaultModel
    return createIncludedGatewayProvider(included)
  }
  return new OpenAICompatProvider(ctor)
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== '') return value
  }
  return undefined
}
