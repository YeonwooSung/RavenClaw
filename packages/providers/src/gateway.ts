import type { Provider, ProviderChunk, ProviderRequest } from '@ravenclaw/core'
import { isAbortError } from './errors'
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
    stream: (req, signal) => streamWithCatalogCoerce(inner, req, signal, opts.defaultModel),
  }
}

async function* streamWithCatalogCoerce(
  inner: OpenAICompatProvider,
  req: ProviderRequest,
  signal: AbortSignal,
  defaultModel: string | undefined,
): AsyncIterable<ProviderChunk> {
  const fallback = defaultModel
  try {
    yield* inner.stream(req, signal)
    return
  } catch (error) {
    if (isAbortError(error) || signal.aborted) throw error
    if (fallback === undefined || !shouldCoerceUnknownModel(error, req.model, fallback)) throw error
  }
  yield* inner.stream({ ...req, model: fallback }, signal)
}

function shouldCoerceUnknownModel(
  error: unknown,
  requested: string,
  defaultModel: string | undefined,
): boolean {
  if (defaultModel === undefined || defaultModel === '' || defaultModel === requested) return false
  return isUnknownCatalogModel(error)
}

function isUnknownCatalogModel(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = 'status' in error ? (error as { status?: unknown }).status : undefined
  if (status === 404) return true
  const message = error instanceof Error ? error.message : String(error)
  return /unknown model/i.test(message)
}
