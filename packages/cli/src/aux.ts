import {
  getModelProfile,
  normalizeOpenAiBaseUrl,
  OLLAMA_DEFAULT_HOST,
  VLLM_DEFAULT_BASE_URL,
  type CompactPolicy,
  type Funding,
  type ModelProfile,
  type Provider,
  type ProviderKind,
  type ResolvedConfig,
} from '@ravenclaw/core'
import { createProvider } from '@ravenclaw/providers'

export function providerKindFromModelId(modelId: string): ProviderKind | undefined {
  const slash = modelId.indexOf('/')
  const prefix = (slash === -1 ? modelId : modelId.slice(0, slash)).toLowerCase()
  if (prefix === 'anthropic' || prefix.startsWith('claude-')) return 'anthropic'
  if (prefix === 'openai' || prefix.startsWith('gpt-')) return 'openai_compat'
  if (prefix === 'ollama') return 'ollama'
  if (prefix === 'vllm') return 'vllm'
  return undefined
}

export function auxSameProvider(sessionModel: string, auxModel: string): boolean {
  const sessionKind = providerKindFromModelId(sessionModel)
  const auxKind = providerKindFromModelId(auxModel)
  if (sessionKind === undefined || auxKind === undefined) return false
  return sessionKind === auxKind
}

export function tryBuildAuxProvider(opts: {
  modelId: string
  config: ResolvedConfig
  funding: Funding
  sessionModel: string
  liveProvider: Provider
}): { provider: Provider; model: ModelProfile } | undefined {
  const modelId = opts.modelId.trim()
  if (modelId === '') return undefined

  // Included sessions stay fail-closed: never open a BYOK client.
  if (opts.funding === 'included') {
    if (!auxSameProvider(opts.sessionModel, modelId)) return undefined
    return { provider: opts.liveProvider, model: getModelProfile(modelId) }
  }

  try {
    return {
      provider: createByokProviderForModel(opts.config, modelId),
      model: getModelProfile(modelId),
    }
  } catch {
    return undefined
  }
}

export function applyAuxCompactPolicy(
  compact: CompactPolicy,
  opts: {
    config: ResolvedConfig
    funding: Funding
    sessionModel: string
    liveProvider: Provider
  },
): CompactPolicy {
  const modelId = opts.config.auxiliary?.compact
  if (modelId === undefined || modelId.trim() === '') return compact
  compact.auxConfigured = true
  const built = tryBuildAuxProvider({
    modelId,
    config: opts.config,
    funding: opts.funding,
    sessionModel: opts.sessionModel,
    liveProvider: opts.liveProvider,
  })
  if (built) {
    compact.auxProvider = built.provider
    compact.auxModel = built.model
  }
  return compact
}

function createByokProviderForModel(config: ResolvedConfig, modelId: string): Provider {
  const kind = providerKindFromModelId(modelId) ?? config.provider
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
