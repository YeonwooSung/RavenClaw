export const SMOKE_PROMPT = 'Reply with the single word pong and nothing else.'

export function smokePasses(text: string): boolean {
  return /\bpong\b/i.test(text)
}

export function evaluateSmoke(text: string): { code: number; detail: string } {
  if (smokePasses(text)) return { code: 0, detail: 'ok: model replied pong' }
  const clip = text.trim().replace(/\s+/g, ' ').slice(0, 80)
  return { code: 1, detail: clip === '' ? 'fail: empty assistant text' : `fail: ${clip}` }
}
