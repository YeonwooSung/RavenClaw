const OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g
const C1_CSI_RE = /\u009b[0-?]*[ -/]*[@-~]/g
const ESC_FE_RE = /\u001b[@-Z\\-_]/g
const BIDI_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

export function sanitizeAdText(text: string): string {
  return text
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(C1_CSI_RE, '')
    .replace(ESC_FE_RE, '')
    .replace(BIDI_RE, '')
}

export function sanitizeAdUrl(url: string): string | null {
  const trimmed = url.trim()
  if (trimmed === '') return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.hostname === '') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  return parsed.href
}
