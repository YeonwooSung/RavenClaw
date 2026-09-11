import { describe, expect, test } from 'bun:test'
import { houseAds } from '@ravenclaw/ads'
import { loadIncludedDockLines } from './included-ads'

describe('loadIncludedDockLines', () => {
  test('disabled returns no lines', async () => {
    const lines = await loadIncludedDockLines({
      enabled: false,
      feedUrl: '',
      sessionId: 's1',
      width: 80,
      height: 24,
    })
    expect(lines).toEqual([])
  })

  test('paid plan uses the local house floor, not the cap upsell', async () => {
    const lines = await loadIncludedDockLines({
      enabled: true,
      feedUrl: '',
      sessionId: 's1',
      hasPaidCapacityPlan: true,
      width: 80,
      height: 24,
    })
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).toContain(houseAds({ hasPaidCapacityPlan: true }).title)
    expect(lines.join('\n')).not.toContain(houseAds({ hasPaidCapacityPlan: false }).title)
  })
})
