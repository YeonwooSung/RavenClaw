import type { ProviderKind, ResolvedConfig } from '../config'
import { getModelProfile, type ModelProfileOverrides } from '../cost/models'
import type { Funding, ModelProfile, Provider } from '../types'

export function providerKindFromModelId(modelId: string): ProviderKind | undefined {
  const slash = modelId.indexOf('/')
  const prefix = (slash === -1 ? modelId : modelId.slice(0, slash)).toLowerCase()
  if (prefix === 'anthropic' || prefix.startsWith('claude-')) return 'anthropic'
  if (prefix === 'openai' || prefix.startsWith('gpt-')) return 'openai_compat'
  if (prefix === 'ollama') return 'ollama'
  if (prefix === 'vllm') return 'vllm'
  if (prefix === 'orcarouter') return 'orcarouter'
  return undefined
}

/**
 * Profile overrides for `id`. The global `contextWindow` applies only to the
 * configured session model; per-id `prices` always apply.
 */
export function profileOverridesFor(
  config: Pick<ResolvedConfig, 'model' | 'contextWindow' | 'prices'>,
  id: string,
): ModelProfileOverrides | undefined {
  const out: ModelProfileOverrides = {}
  if (id === config.model && config.contextWindow !== undefined) {
    out.contextWindow = config.contextWindow
  }
  const prices = config.prices?.[id]
  if (prices !== undefined) out.prices = prices
  if (out.contextWindow === undefined && out.prices === undefined) return undefined
  return out
}

export interface ModelResolverOptions {
  config: ResolvedConfig
  funding: Funding
  liveProvider: Provider
  /** Session model id the liveProvider serves. */
  liveModel: string
  /** BYOK factory, injected by cli/sdk (core cannot import providers). */
  createProvider?: (kind: ProviderKind, modelId: string, config: ResolvedConfig) => Provider
}

export type ResolvedModel =
  | { ok: true; provider: Provider; profile: ModelProfile; kind: ProviderKind | undefined }
  | { ok: false; error: string }

export interface ModelResolver {
  resolve(id: string): ResolvedModel
  profile(id: string): ModelProfile
}

export function createModelResolver(opts: ModelResolverOptions): ModelResolver {
  const { config, funding, liveProvider, liveModel, createProvider } = opts
  const liveKind = providerKindFromModelId(liveModel) ?? config.provider
  const cache = new Map<ProviderKind, Provider>()

  const profile = (id: string): ModelProfile =>
    getModelProfile(id, profileOverridesFor(config, id))

  const resolve = (id: string): ResolvedModel => {
    const kind = providerKindFromModelId(id)
    if (kind === undefined || kind === liveKind) {
      return { ok: true, provider: liveProvider, profile: profile(id), kind }
    }
    if (funding === 'included') {
      return {
        ok: false,
        error: `model ${id} needs provider ${kind}; included sessions cannot switch provider`,
      }
    }
    if (createProvider === undefined) {
      return { ok: false, error: `model ${id} needs provider ${kind}; no provider factory available` }
    }
    let provider = cache.get(kind)
    if (provider === undefined) {
      try {
        provider = createProvider(kind, id, config)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      cache.set(kind, provider)
    }
    return { ok: true, provider, profile: profile(id), kind }
  }

  return { resolve, profile }
}
