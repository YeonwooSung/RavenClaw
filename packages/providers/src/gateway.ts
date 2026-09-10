import type { Provider } from '@ravenclaw/core'
import { OpenAICompatProvider } from './openai-compat'

export function createIncludedGatewayProvider(opts: {
  baseUrl: string
  apiKey: string
  defaultModel?: string
}): Provider {
  const ctor: { apiKey: string; baseUrl: string; defaultModel?: string } = {
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
  }
  if (opts.defaultModel !== undefined) ctor.defaultModel = opts.defaultModel
  const inner = new OpenAICompatProvider(ctor)
  return {
    id: 'included-gateway',
    apiMode: inner.apiMode,
    profile: (model) => inner.profile(model),
    stream: (req, signal) => inner.stream(req, signal),
  }
}
