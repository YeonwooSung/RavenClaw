import type { ModelProfile } from '../types'

export interface ModelPriceOverride {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

export interface ModelProfileOverrides {
  contextWindow?: number
  prices?: ModelPriceOverride
}

const CONTEXT_WINDOW_CAP_RESERVE = 20_000
const CONSERVATIVE_CONTEXT_WINDOW = 32_000

type BuiltInRow = Omit<ModelProfile, 'reserveOutputTokens'>

const BUILT_INS: Record<string, BuiltInRow> = {
  'anthropic/claude-sonnet-4': {
    id: 'anthropic/claude-sonnet-4',
    contextWindow: 200_000,
    inputUsdPerMTok: 3.0,
    outputUsdPerMTok: 15.0,
    cacheReadUsdPerMTok: 0.3,
    cacheWriteUsdPerMTok: 3.75,
    supportsThinking: true,
  },
  'anthropic/claude-opus-4': {
    id: 'anthropic/claude-opus-4',
    contextWindow: 200_000,
    inputUsdPerMTok: 15.0,
    outputUsdPerMTok: 75.0,
    cacheReadUsdPerMTok: 1.5,
    cacheWriteUsdPerMTok: 18.75,
    supportsThinking: true,
  },
  'openai/gpt-4o': {
    id: 'openai/gpt-4o',
    contextWindow: 128_000,
    inputUsdPerMTok: 2.5,
    outputUsdPerMTok: 10.0,
    cacheReadUsdPerMTok: 1.25,
    cacheWriteUsdPerMTok: 2.5,
    supportsThinking: false,
  },
  'openai/gpt-4o-mini': {
    id: 'openai/gpt-4o-mini',
    contextWindow: 128_000,
    inputUsdPerMTok: 0.15,
    outputUsdPerMTok: 0.6,
    cacheReadUsdPerMTok: 0.075,
    cacheWriteUsdPerMTok: 0.15,
    supportsThinking: false,
  },
}

export function reserveOutputTokens(contextWindow: number): number {
  return Math.min(CONTEXT_WINDOW_CAP_RESERVE, Math.floor(0.1 * contextWindow))
}

export function conservativeProfile(id: string): ModelProfile {
  return {
    id,
    contextWindow: CONSERVATIVE_CONTEXT_WINDOW,
    reserveOutputTokens: reserveOutputTokens(CONSERVATIVE_CONTEXT_WINDOW),
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
  }
}

export function getModelProfile(id: string, overrides?: ModelProfileOverrides): ModelProfile {
  const builtIn = BUILT_INS[id]
  const base: ModelProfile = builtIn
    ? { ...builtIn, reserveOutputTokens: reserveOutputTokens(builtIn.contextWindow) }
    : conservativeProfile(id)

  const contextWindow = overrides?.contextWindow ?? base.contextWindow
  const reserve =
    overrides?.contextWindow !== undefined
      ? reserveOutputTokens(overrides.contextWindow)
      : base.reserveOutputTokens

  const prices = overrides?.prices
  return {
    id: base.id,
    contextWindow,
    reserveOutputTokens: reserve,
    inputUsdPerMTok: prices?.input ?? base.inputUsdPerMTok,
    outputUsdPerMTok: prices?.output ?? base.outputUsdPerMTok,
    cacheReadUsdPerMTok: prices?.cacheRead ?? base.cacheReadUsdPerMTok,
    cacheWriteUsdPerMTok: prices?.cacheWrite ?? base.cacheWriteUsdPerMTok,
    supportsThinking: base.supportsThinking,
  }
}
