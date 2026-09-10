import { describe, expect, test } from 'bun:test'
import { layoutAdCard, layoutDock } from './layout'
import type { AdCreative } from './types'

const sample: AdCreative = {
  id: 'c1',
  title: 'Acme CI',
  body: 'Ship on every push with reproducible builds and signed artifacts for the team.',
  cta: 'Open',
  url: 'https://ads.example.com/acme',
  provider: 'first_party',
}

function assertGrid(lines: string[], width: number, height: number): void {
  expect(lines).toHaveLength(height)
  for (const line of lines) {
    expect(line.length).toBe(width)
  }
}

describe('layoutAdCard', () => {
  test.each([20, 48, 80, 120] as const)(
    'fills a %i-col grid, discloses Ad, and keeps line lengths === width',
    (width) => {
      const card = layoutAdCard(width, sample)
      expect(card.width).toBe(width)
      expect(card.height === 4 || card.height === 5).toBe(true)
      expect(card.disclosure).toBe('Ad')
      assertGrid(card.lines, width, card.height)
      expect(card.lines.some((line) => line.includes('Ad'))).toBe(true)
    },
  )

  test('width 20 drops the destination; width 48+ may show it', () => {
    const narrow = layoutAdCard(20, sample)
    expect(narrow.destinationShown).toBe(false)
    expect(narrow.lines.join('\n')).not.toContain('ads.example.com')

    for (const width of [48, 80, 120] as const) {
      const wide = layoutAdCard(width, sample)
      expect(wide.destinationShown).toBe(true)
      expect(wide.lines.join('\n')).toContain('ads.example.com')
    }
  })

  test('width below 20 is a one-line stub that still discloses Ad', () => {
    const stub = layoutAdCard(19, sample)
    expect(stub.disclosure).toBe('Ad')
    expect(stub.destinationShown).toBe(false)
    assertGrid(stub.lines, 19, stub.height)
    const content = stub.lines.filter((line) => line.trim() !== '')
    expect(content).toHaveLength(1)
    expect(content[0]).toContain('Ad')
  })
})

describe('layoutDock', () => {
  test('refuses expand when termHeight is too small vs composerReservedRows', () => {
    const refused = layoutDock(80, 6, sample, 3)
    expect(refused.opened).toBe(false)
    expect(refused.lines).toEqual([])
  })

  test('opens a full card when the terminal has room above the composer', () => {
    const opened = layoutDock(80, 24, sample, 3)
    expect(opened.opened).toBe(true)
    expect(opened.lines.length).toBeGreaterThan(0)
    for (const line of opened.lines) expect(line.length).toBe(80)
    expect(opened.lines.some((line) => line.includes('Ad'))).toBe(true)
  })

  test('drops extra body before refusing when height is tight', () => {
    const degraded = layoutDock(80, 7, sample, 3)
    expect(degraded.opened).toBe(true)
    expect(degraded.lines).toHaveLength(4)
    for (const line of degraded.lines) expect(line.length).toBe(80)
  })
})
