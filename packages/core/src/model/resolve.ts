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
  /**
   * Kind the liveProvider was built with; reported as `providerKind` when it is
   * reused. Default: the `liveModel` id prefix, else `config.provider`.
   */
  liveKind?: ProviderKind
  /**
   * Model the global `contextWindow` override belongs to. Default: `config.model`
   * snapshotted at creation, so a later `/model` mutation does not move it.
   */
  configuredModel?: string
  /** Default true. When false and funding is byok, every resolve builds (and caches) a provider via the factory. */
  reuseLiveProvider?: boolean
  /** BYOK factory, injected by cli/sdk (core cannot import providers). */
  createProvider?: (kind: ProviderKind, modelId: string, config: ResolvedConfig) => Provider
}

export type ResolvedModel =
  | {
      ok: true
      provider: Provider
      profile: ModelProfile
      /** Kind of `provider`: the live kind when reused, else the factory kind. */
      providerKind: ProviderKind
    }
  | { ok: false; error: string }

export interface ModelResolver {
  resolve(id: string): ResolvedModel
  profile(id: string): ModelProfile
}

export function createModelResolver(opts: ModelResolverOptions): ModelResolver {
  const { config, funding, liveProvider, liveModel, createProvider } = opts
  const reuseLive = opts.reuseLiveProvider ?? true
  // Ids of this kind reuse the live provider (e.g. vllm serving `openai/...`).
  const servedKind = providerKindFromModelId(liveModel) ?? config.provider
  const liveKind = opts.liveKind ?? servedKind
  const cache = new Map<string, Provider>()
  const configuredModel = opts.configuredModel ?? config.model

  const profile = (id: string): ModelProfile =>
    getModelProfile(
      id,
      profileOverridesFor(
        { model: configuredModel, contextWindow: config.contextWindow, prices: config.prices },
        id,
      ),
    )

  const resolve = (id: string): ResolvedModel => {
    const idKind = providerKindFromModelId(id)
    const sameKind = idKind === undefined || idKind === servedKind
    if (sameKind && (reuseLive || funding === 'included')) {
      return { ok: true, provider: liveProvider, profile: profile(id), providerKind: liveKind }
    }
    const kind = idKind ?? liveKind
    if (funding === 'included') {
      return {
        ok: false,
        error: `model ${id} needs provider ${kind}; included sessions cannot switch provider`,
      }
    }
    if (createProvider === undefined) {
      return { ok: false, error: `model ${id} needs provider ${kind}; no provider factory available` }
    }
    const key = `${kind}\0${id}`
    let provider = cache.get(key)
    if (provider === undefined) {
      try {
        provider = createProvider(kind, id, config)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      cache.set(key, provider)
    }
    return { ok: true, provider, profile: profile(id), providerKind: kind }
  }

  return { resolve, profile }
}
