export type AdSlot = 'raven-dock-1' | 'raven-inline-1'

export interface AdCreative {
  id: string
  title: string
  body: string
  cta: string
  url: string
  provider: 'first_party' | 'house'
}

export interface AdCardLayout {
  lines: string[]
  height: 4 | 5
  width: number
  destinationShown: boolean
  disclosure: 'Ad'
}

export interface AdPlacement {
  id: AdSlot
  creative: AdCreative
  receivedAtMs: number
}

export interface HouseContext {
  hasPaidCapacityPlan: boolean
}

export interface AdDevice {
  os: string
  locale: string
  tz: string
}

export interface AdMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface FetchAdsOptions {
  feedUrl?: string
  enabled: boolean
  hasPaidCapacityPlan?: boolean
  sessionId?: string
  messages?: AdMessage[]
  device?: AdDevice
  placementIds?: AdSlot[]
}
