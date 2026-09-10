import type { Provider } from '@ravenclaw/core'
import { AnthropicMessagesProvider } from './anthropic'
import { OpenAICompatProvider } from './openai-compat'

export function createProvider(opts: {
  provider: 'anthropic' | 'openai_compat'
  apiKey: string
  baseUrl?: string
  defaultModel?: string
}): Provider {
  const ctor: { apiKey: string; baseUrl?: string; defaultModel?: string } = {
    apiKey: opts.apiKey,
  }
  if (opts.baseUrl !== undefined) ctor.baseUrl = opts.baseUrl
  if (opts.defaultModel !== undefined) ctor.defaultModel = opts.defaultModel
  if (opts.provider === 'anthropic') return new AnthropicMessagesProvider(ctor)
  return new OpenAICompatProvider(ctor)
}
