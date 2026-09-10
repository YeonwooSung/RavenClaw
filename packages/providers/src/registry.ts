import type { Provider } from '@ravenclaw/core'
import { AnthropicMessagesProvider } from './anthropic'
import { createIncludedGatewayProvider } from './gateway'
import { OpenAICompatProvider } from './openai-compat'

export function createProvider(opts: {
  provider: 'anthropic' | 'openai_compat' | 'included'
  apiKey: string
  baseUrl?: string
  gatewayUrl?: string
  defaultModel?: string
}): Provider {
  const ctor: { apiKey: string; baseUrl?: string; defaultModel?: string } = {
    apiKey: opts.apiKey,
  }
  if (opts.baseUrl !== undefined) ctor.baseUrl = opts.baseUrl
  if (opts.defaultModel !== undefined) ctor.defaultModel = opts.defaultModel
  if (opts.provider === 'anthropic') return new AnthropicMessagesProvider(ctor)
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
