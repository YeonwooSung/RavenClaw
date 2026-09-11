import { describe, expect, test } from 'bun:test'
import { houseAds } from './house'
import { INCLUDED_PRIVACY } from './privacy'
import { sanitizeAdUrl } from './sanitize'

describe('houseAds', () => {
  test('hasPaidCapacityPlan false always returns a creative', () => {
    const creative = houseAds({ hasPaidCapacityPlan: false })
    expect(creative.id.length).toBeGreaterThan(0)
    expect(creative.title.length).toBeGreaterThan(0)
    expect(creative.body.length).toBeGreaterThan(0)
    expect(creative.cta.length).toBeGreaterThan(0)
    expect(creative.provider).toBe('house')
    expect(sanitizeAdUrl(creative.url)).toBe(creative.url)
    expect(creative.url.startsWith('https://')).toBe(true)
  })

  test('hasPaidCapacityPlan true still returns a non-empty floor and does not sell silence', () => {
    const creative = houseAds({ hasPaidCapacityPlan: true })
    expect(creative.provider).toBe('house')
    expect(creative.title.length).toBeGreaterThan(0)
    const blob = `${creative.title} ${creative.body} ${creative.cta}`.toLowerCase()
    expect(blob).not.toContain('no ads')
    expect(blob).not.toContain('remove ads')
    expect(blob).not.toContain('ad-free')
  })

  test('local floor body includes the included-privacy sentence', () => {
    const creative = houseAds({ hasPaidCapacityPlan: true })
    expect(creative.body).toContain(INCLUDED_PRIVACY)
    expect(creative.body).toContain(INCLUDED_PRIVACY)
  })
})
