import { fetchAds, layoutDock } from '@ravenclaw/ads'

export async function loadIncludedDockLines(opts: {
  enabled: boolean
  feedUrl: string
  sessionId: string
  hasPaidCapacityPlan?: boolean
  width: number
  height: number
  reserved?: number
}): Promise<string[]> {
  if (!opts.enabled) return []
  const placement = await fetchAds({
    enabled: true,
    feedUrl: opts.feedUrl,
    sessionId: opts.sessionId,
    hasPaidCapacityPlan: opts.hasPaidCapacityPlan === true,
  })
  const dock = layoutDock(opts.width, opts.height, placement.creative, opts.reserved ?? 3)
  return dock.opened ? dock.lines : []
}
