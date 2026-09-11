import { INCLUDED_PRIVACY } from './privacy'
import type { AdCreative, HouseContext } from './types'

const LOCAL_FLOOR: AdCreative = {
  id: 'house-raven-local',
  title: 'RavenClaw stays local',
  body: INCLUDED_PRIVACY,
  cta: 'About',
  url: 'https://ravenclaw.dev/ads',
  provider: 'house',
}

const CAPACITY_FLOOR: AdCreative = {
  id: 'house-raven-capacity',
  title: 'Need a higher session cap?',
  body: 'A capacity plan raises included-model limits. Ads still fund the compute floor.',
  cta: 'Details',
  url: 'https://ravenclaw.dev/capacity',
  provider: 'house',
}

export function houseAds(ctx: HouseContext): AdCreative {
  return ctx.hasPaidCapacityPlan ? LOCAL_FLOOR : CAPACITY_FLOOR
}
