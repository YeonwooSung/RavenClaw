import { houseAds } from './house'
import { sanitizeAdText, sanitizeAdUrl } from './sanitize'
import type { AdCreative, AdMessage, AdPlacement, AdSlot, FetchAdsOptions } from './types'

const FETCH_TIMEOUT_MS = 2_000
const MESSAGE_CAP = 8
const DEFAULT_SLOT: AdSlot = 'raven-dock-1'

export async function fetchAds(opts: FetchAdsOptions): Promise<AdPlacement> {
  const paid = opts.hasPaidCapacityPlan === true
  const feedUrl = opts.feedUrl
  if (!opts.enabled || !hasFeedUrl(feedUrl)) return housePlacement(paid)

  try {
    const response = await fetch(feedUrl.trim(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(buildRequestBody(opts)),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return housePlacement(paid)
    const raw: unknown = await response.json()
    const creative = parseCreative(raw)
    if (!creative) return housePlacement(paid)
    return {
      id: parseSlot(raw),
      creative,
      receivedAtMs: Date.now(),
    }
  } catch {
    return housePlacement(paid)
  }
}

function hasFeedUrl(feedUrl: string | undefined): feedUrl is string {
  return feedUrl !== undefined && feedUrl.trim() !== ''
}

function housePlacement(hasPaidCapacityPlan: boolean): AdPlacement {
  return {
    id: DEFAULT_SLOT,
    creative: houseAds({ hasPaidCapacityPlan }),
    receivedAtMs: Date.now(),
  }
}

function buildRequestBody(opts: FetchAdsOptions): {
  sessionId: string
  placementIds: AdSlot[]
  messages: AdMessage[]
  device: { os: string; locale: string; tz: string }
  surface: 'cli'
} {
  return {
    sessionId: opts.sessionId ?? '',
    placementIds: opts.placementIds ?? [DEFAULT_SLOT],
    messages: takeMessages(opts.messages),
    device: opts.device ?? defaultDevice(),
    surface: 'cli',
  }
}

function takeMessages(messages: AdMessage[] | undefined): AdMessage[] {
  const src = messages ?? []
  const tail = src.length > MESSAGE_CAP ? src.slice(-MESSAGE_CAP) : src
  const out: AdMessage[] = []
  for (const msg of tail) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue
    out.push({ role: msg.role, text: msg.text })
  }
  return out
}

function defaultDevice(): { os: string; locale: string; tz: string } {
  const intl = Intl.DateTimeFormat().resolvedOptions()
  return {
    os: process.platform,
    locale: intl.locale,
    tz: intl.timeZone,
  }
}

function parseSlot(raw: unknown): AdSlot {
  if (!raw || typeof raw !== 'object') return DEFAULT_SLOT
  const rec = raw as Record<string, unknown>
  const id = rec.id ?? rec.placementId
  if (id === 'raven-dock-1' || id === 'raven-inline-1') return id
  return DEFAULT_SLOT
}

function parseCreative(raw: unknown): AdCreative | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const src =
    rec.creative && typeof rec.creative === 'object'
      ? (rec.creative as Record<string, unknown>)
      : rec
  const id = asNonEmpty(src.id)
  const title = asNonEmpty(src.title)
  const body = asNonEmpty(src.body)
  const cta = asNonEmpty(src.cta)
  const url = asNonEmpty(src.url)
  if (!id || !title || !body || !cta || !url) return null
  const safeUrl = sanitizeAdUrl(url)
  if (!safeUrl) return null
  const cleanTitle = sanitizeAdText(title)
  const cleanBody = sanitizeAdText(body)
  const cleanCta = sanitizeAdText(cta)
  if (cleanTitle === '' || cleanBody === '' || cleanCta === '') return null
  return {
    id: sanitizeAdText(id),
    title: cleanTitle,
    body: cleanBody,
    cta: cleanCta,
    url: safeUrl,
    provider: src.provider === 'house' ? 'house' : 'first_party',
  }
}

function asNonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
