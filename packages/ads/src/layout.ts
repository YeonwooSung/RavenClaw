import type { AdCardLayout, AdCreative } from './types'

const STUB_MAX_WIDTH = 20
const DESTINATION_MIN_WIDTH = 48
const INLINE_HEIGHT = 4
const LANDING_HEIGHT = 5

export function layoutAdCard(width: number, creative: AdCreative): AdCardLayout {
  const cols = normalizeWidth(width)
  if (cols < STUB_MAX_WIDTH) return stubCard(cols, creative)
  const showDestination = cols >= DESTINATION_MIN_WIDTH
  const height: 4 | 5 = showDestination ? LANDING_HEIGHT : INLINE_HEIGHT
  return buildCard(cols, creative, height, showDestination)
}

export function layoutDock(
  width: number,
  termHeight: number,
  creative: AdCreative,
  composerReservedRows: number,
): { lines: string[]; opened: boolean } {
  const cols = normalizeWidth(width)
  if (cols < STUB_MAX_WIDTH) {
    const stub = stubCard(cols, creative)
    const line = stub.lines[0] ?? pad('', cols)
    if (!fits(termHeight, composerReservedRows, 1)) return { lines: [], opened: false }
    return { lines: [line], opened: true }
  }

  const wantDestination = cols >= DESTINATION_MIN_WIDTH
  const candidates: Array<{ height: 4 | 5; destination: boolean }> = wantDestination
    ? [
        { height: LANDING_HEIGHT, destination: true },
        { height: INLINE_HEIGHT, destination: true },
        { height: INLINE_HEIGHT, destination: false },
      ]
    : [{ height: INLINE_HEIGHT, destination: false }]

  for (const candidate of candidates) {
    if (!fits(termHeight, composerReservedRows, candidate.height)) continue
    const card = buildCard(cols, creative, candidate.height, candidate.destination)
    return { lines: card.lines, opened: true }
  }
  return { lines: [], opened: false }
}

function buildCard(
  width: number,
  creative: AdCreative,
  height: 4 | 5,
  destination: boolean,
): AdCardLayout {
  const host = destination ? hostnameOf(creative.url) : ''
  const bodyBudget = height === LANDING_HEIGHT ? 2 : 1
  const bodyLines = wrapLines(creative.body, width, bodyBudget)
  const ctaLine = formatCtaLine(creative.cta, host, width, destination && host !== '')

  const rows: string[] = [pad('Ad', width), pad(creative.title, width), pad(bodyLines[0] ?? '', width)]
  if (height === LANDING_HEIGHT) rows.push(pad(bodyLines[1] ?? '', width))
  rows.push(pad(ctaLine, width))

  return {
    lines: rows,
    height,
    width,
    destinationShown: destination && host !== '' && ctaLine.includes(host),
    disclosure: 'Ad',
  }
}

function stubCard(width: number, creative: AdCreative): AdCardLayout {
  const label = creative.title === '' ? 'Ad' : `Ad ${creative.title}`
  const lines = [pad(label, width), pad('', width), pad('', width), pad('', width)]
  return {
    lines,
    height: INLINE_HEIGHT,
    width,
    destinationShown: false,
    disclosure: 'Ad',
  }
}

function formatCtaLine(cta: string, host: string, width: number, showHost: boolean): string {
  if (!showHost || host === '') return cta
  const gap = '  '
  if (displayWidth(cta) + displayWidth(gap) + displayWidth(host) <= width) return `${cta}${gap}${host}`
  const remaining = width - displayWidth(cta) - displayWidth(gap)
  if (remaining <= 0) return cta
  return `${cta}${gap}${sliceCells(host, remaining)}`
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function wrapLines(text: string, width: number, max: number): string[] {
  const lines: string[] = []
  if (width <= 0 || max <= 0) return Array.from({ length: Math.max(0, max) }, () => '')
  const words = text.split(/\s+/).filter((word) => word.length > 0)
  let current = ''
  for (const word of words) {
    if (lines.length >= max) break
    const next = current === '' ? word : `${current} ${word}`
    if (displayWidth(next) <= width) {
      current = next
      continue
    }
    if (current !== '') {
      lines.push(current)
      current = ''
    }
    if (lines.length >= max) break
    if (displayWidth(word) > width) {
      lines.push(sliceCells(word, width))
    } else {
      current = word
    }
  }
  if (current !== '' && lines.length < max) lines.push(current)
  while (lines.length < max) lines.push('')
  return lines
}

function pad(text: string, width: number): string {
  if (width <= 0) return ''
  const sliced = sliceCells(text, width)
  const extra = width - displayWidth(sliced)
  return extra > 0 ? sliced + ' '.repeat(extra) : sliced
}

function sliceCells(text: string, width: number): string {
  if (width <= 0) return ''
  let used = 0
  let out = ''
  for (const ch of text) {
    const w = charWidth(ch)
    if (used + w > width) break
    out += ch
    used += w
  }
  return out
}

function displayWidth(text: string): number {
  let n = 0
  for (const ch of text) n += charWidth(ch)
  return n
}

function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  if (code === 0) return 0
  if (code < 32 || (code >= 0x7f && code <= 0x9f)) return 0
  if (code >= 0x1100 && isWide(code)) return 2
  return 1
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  )
}

function normalizeWidth(width: number): number {
  if (!Number.isFinite(width)) return 0
  return Math.max(0, Math.floor(width))
}

function fits(termHeight: number, reserved: number, height: number): boolean {
  return termHeight >= reserved + height
}
