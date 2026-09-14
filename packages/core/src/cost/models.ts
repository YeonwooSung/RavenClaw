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

export type ModelFamily = 'anthropic' | 'openai'
export type ModelRole = 'default' | 'strong' | 'fast'

export const MODEL_FAMILIES = ['anthropic', 'openai'] as const
export const MODEL_ROLES = ['default', 'strong', 'fast'] as const

// Role → current official snapshot. Bump these when a generation ships;
// call sites should use defaultModelId(), not the snapshot strings.
// Steps: CONTRIBUTING.md § Updating the model catalog.
const CURRENT: Record<ModelFamily, Record<ModelRole, string>> = {
  anthropic: {
    default: 'claude-sonnet-5',
    strong: 'claude-opus-5',
    fast: 'claude-haiku-4-5',
  },
  openai: {
    default: 'gpt-5.6-terra',
    strong: 'gpt-6-astra',
    fast: 'gpt-5.6-luna',
  },
}

export function defaultModelId(family: ModelFamily, role: ModelRole = 'default'): string {
  return CURRENT[family][role]
}

type BuiltInRow = Omit<ModelProfile, 'reserveOutputTokens'>

// Official Claude API IDs: https://docs.anthropic.com/en/docs/about-claude/models/overview
// Official OpenAI flagship IDs: https://developers.openai.com/api/docs/models
// Cache-write figures are the 5-minute / short-context list prices.
const BUILT_INS: Record<string, BuiltInRow> = {
  'claude-fable-5-1': {
    id: 'claude-fable-5-1',
    contextWindow: 1_000_000,
    inputUsdPerMTok: 10.0,
    outputUsdPerMTok: 50.0,
    cacheReadUsdPerMTok: 0.25,
    cacheWriteUsdPerMTok: 12.5,
    supportsThinking: true,
  },
  'claude-opus-5': {
    id: 'claude-opus-5',
    contextWindow: 1_000_000,
    inputUsdPerMTok: 5.0,
    outputUsdPerMTok: 25.0,
    cacheReadUsdPerMTok: 0.5,
    cacheWriteUsdPerMTok: 6.25,
    supportsThinking: true,
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    contextWindow: 1_000_000,
    inputUsdPerMTok: 2.0,
    outputUsdPerMTok: 10.0,
    cacheReadUsdPerMTok: 0.2,
    cacheWriteUsdPerMTok: 2.5,
    supportsThinking: true,
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    contextWindow: 200_000,
    inputUsdPerMTok: 1.0,
    outputUsdPerMTok: 5.0,
    cacheReadUsdPerMTok: 0.1,
    cacheWriteUsdPerMTok: 1.25,
    supportsThinking: true,
  },
  'gpt-6-astra': {
    id: 'gpt-6-astra',
    contextWindow: 1_050_000,
    inputUsdPerMTok: 10.0,
    outputUsdPerMTok: 50.0,
    cacheReadUsdPerMTok: 1.0,
    cacheWriteUsdPerMTok: 12.5,
    supportsThinking: false,
  },
  'gpt-5.6-sol': {
    id: 'gpt-5.6-sol',
    contextWindow: 1_050_000,
    inputUsdPerMTok: 4.0,
    outputUsdPerMTok: 20.0,
    cacheReadUsdPerMTok: 0.4,
    cacheWriteUsdPerMTok: 5.0,
    supportsThinking: false,
  },
  'gpt-5.6-terra': {
    id: 'gpt-5.6-terra',
    contextWindow: 1_050_000,
    inputUsdPerMTok: 2.0,
    outputUsdPerMTok: 12.0,
    cacheReadUsdPerMTok: 0.2,
    cacheWriteUsdPerMTok: 2.5,
    supportsThinking: false,
  },
  'gpt-5.6-luna': {
    id: 'gpt-5.6-luna',
    contextWindow: 1_050_000,
    inputUsdPerMTok: 0.2,
    outputUsdPerMTok: 1.2,
    cacheReadUsdPerMTok: 0.02,
    cacheWriteUsdPerMTok: 0.25,
    supportsThinking: false,
  },
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

const ALIASES: Record<string, string> = {
  'anthropic/claude-fable-5-1': 'claude-fable-5-1',
  'anthropic/claude-opus-5': 'claude-opus-5',
  'anthropic/claude-sonnet-5': 'claude-sonnet-5',
  'anthropic/claude-haiku-4-5': 'claude-haiku-4-5',
  'anthropic/claude-haiku-4.5': 'claude-haiku-4-5',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  'openai/gpt-6-astra': 'gpt-6-astra',
  'openai/gpt-5.6-sol': 'gpt-5.6-sol',
  'openai/gpt-5.6': 'gpt-5.6-sol',
  'gpt-5.6': 'gpt-5.6-sol',
  'openai/gpt-5.6-terra': 'gpt-5.6-terra',
  'openai/gpt-5.6-luna': 'gpt-5.6-luna',
}

function lookupBuiltIn(id: string): BuiltInRow | undefined {
  const canonical = ALIASES[id] ?? id
  const row = BUILT_INS[canonical]
  if (row === undefined) return undefined
  return row.id === id ? row : { ...row, id }
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
  const builtIn = lookupBuiltIn(id)
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
