import { createReadStream } from 'node:fs'

export const READ_CHAR_CAP = 100_000
export const TRUNCATION_NOTE = '\n... [truncated: output exceeds 100000 characters]'

export function sliceUtf8Lines(text: string, offset?: number, limit?: number): string {
  const lines = text.split(/\r?\n/)
  const start = Math.max(0, (offset ?? 1) - 1)
  const sliced = limit === undefined ? lines.slice(start) : lines.slice(start, start + limit)
  return capReadText(sliced.join('\n'))
}

export function capReadText(text: string, cap = READ_CHAR_CAP): string {
  if (text.length > cap) return text.slice(0, cap) + TRUNCATION_NOTE
  return text
}

export async function streamUtf8LineWindow(
  path: string,
  offset?: number,
  limit?: number,
): Promise<string> {
  const start = Math.max(0, (offset ?? 1) - 1)
  const kept: string[] = []
  let index = 0
  let chars = 0
  let stop = false

  const take = (line: string) => {
    if (stop) return
    if (index < start) {
      index += 1
      return
    }
    if (limit !== undefined && kept.length >= limit) {
      stop = true
      return
    }
    kept.push(line)
    chars += line.length + (kept.length > 1 ? 1 : 0)
    if (chars >= READ_CHAR_CAP) stop = true
    index += 1
  }

  await readUtf8Lines(path, take, () => stop)
  return capReadText(kept.join('\n'))
}

function readUtf8Lines(
  path: string,
  onLine: (line: string) => void,
  done: () => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { encoding: 'utf8' })
    let buf = ''
    stream.on('data', (chunk) => {
      if (done()) {
        stream.destroy()
        return
      }
      buf += chunk
      let idx = 0
      while (idx < buf.length) {
        const n = buf.indexOf('\n', idx)
        if (n === -1) break
        let line = buf.slice(idx, n)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        onLine(line)
        idx = n + 1
        if (done()) {
          stream.destroy()
          buf = ''
          return
        }
      }
      buf = buf.slice(idx)
    })
    stream.on('error', reject)
    stream.on('close', () => {
      if (!done()) onLine(buf)
      resolve()
    })
  })
}
