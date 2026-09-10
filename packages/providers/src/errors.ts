import type { ProviderErrorLike } from '@ravenclaw/core'

export class ProviderError extends Error implements ProviderErrorLike {
  readonly retryable: boolean
  readonly status?: number
  readonly bytes?: number

  constructor(message: string, init: { retryable: boolean; status?: number; bytes?: number }) {
    super(message)
    this.name = 'ProviderError'
    this.retryable = init.retryable
    if (init.status !== undefined) this.status = init.status
    if (init.bytes !== undefined) this.bytes = init.bytes
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = 'name' in error ? String((error as { name: unknown }).name) : ''
  return name === 'AbortError' || name === 'DOMException'
}

export function retryableForStatus(status: number): boolean {
  return status === 429 || status === 529 || (status >= 500 && status <= 599)
}

export function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '')
  return path.startsWith('/') ? `${trimmed}${path}` : `${trimmed}/${path}`
}

export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

export function streamDroppedError(bytes: number): ProviderError {
  if (bytes > 0) return new ProviderError('stream dropped', { retryable: true, bytes })
  return new ProviderError('stream dropped', { retryable: true })
}

export async function throwForHttpError(res: Response): Promise<never> {
  let detail = res.statusText || 'request failed'
  try {
    const text = await res.text()
    if (text.trim() !== '') detail = text.slice(0, 800)
  } catch {
    // keep statusText
  }
  throw new ProviderError(`provider HTTP ${res.status}: ${detail}`, {
    retryable: retryableForStatus(res.status),
    status: res.status,
  })
}

export async function fetchWithSingleRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (error) {
    if (isAbortError(error) || signal.aborted) throw error
    try {
      return await fetch(url, init)
    } catch (retryError) {
      if (isAbortError(retryError) || signal.aborted) throw retryError
      const message = retryError instanceof Error ? retryError.message : String(retryError)
      throw new ProviderError(message, { retryable: true })
    }
  }
}

export async function* iterateSse(
  stream: ReadableStream<Uint8Array>,
  onBytes?: (n: number) => void,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let dataLines: string[] = []

  const dispatch = (): { event: string; data: string } | undefined => {
    if (dataLines.length === 0) {
      event = ''
      return undefined
    }
    const data = dataLines.join('\n')
    const ev = event
    event = ''
    dataLines = []
    return { event: ev, data }
  }

  const takeField = (line: string): void => {
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (value) {
        onBytes?.(value.byteLength)
        buffer += decoder.decode(value, { stream: !done })
      }
      if (done) buffer += decoder.decode()

      while (true) {
        const nl = buffer.indexOf('\n')
        if (nl < 0) break
        let line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') {
          const next = dispatch()
          if (next) yield next
          continue
        }
        takeField(line)
      }

      if (!done) continue

      if (buffer.length > 0) {
        let line = buffer
        buffer = ''
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line !== '') takeField(line)
      }
      const last = dispatch()
      if (last) yield last
      return
    }
  } finally {
    reader.releaseLock()
  }
}
