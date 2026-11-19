import {
  createModelResolver,
  providerKindFromModelId,
  type CompactPolicy,
  type Funding,
  type ModelProfile,
  type Provider,
  type ResolvedConfig,
} from '@ravenclaw/core'
import { byokProviderFactory } from '@ravenclaw/providers'

export { byokProviderFactory, providerKindFromModelId }

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
  // Included sessions stay fail-closed: unknown or cross-kind aux models disable aux.
  if (opts.funding === 'included' && !auxSameProvider(opts.sessionModel, modelId)) {
    return undefined
  }
  const resolved = createModelResolver({
    config: opts.config,
    funding: opts.funding,
    liveProvider: opts.liveProvider,
    liveModel: opts.sessionModel,
    reuseLiveProvider: false,
    createProvider: byokProviderFactory,
  }).resolve(modelId)
  if (!resolved.ok) return undefined
  return { provider: resolved.provider, model: resolved.profile }
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
