export function encodeFrame(message: unknown): string {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
}

export function consumeFrames(buf: Buffer): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = []
  let offset = 0
  while (offset < buf.length) {
    const sep = findHeaderSeparator(buf, offset)
    if (!sep) break
    const header = buf.subarray(offset, sep.index).toString('utf8')
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    if (!match?.[1]) {
      offset = sep.index + sep.length
      continue
    }
    const length = Number(match[1])
    const bodyStart = sep.index + sep.length
    if (buf.length < bodyStart + length) break
    const body = buf.subarray(bodyStart, bodyStart + length).toString('utf8')
    messages.push(JSON.parse(body))
    offset = bodyStart + length
  }
  return { messages, rest: buf.subarray(offset) }
}

function findHeaderSeparator(
  buf: Buffer,
  offset: number,
): { index: number; length: number } | undefined {
  const crlf = buf.indexOf('\r\n\r\n', offset)
  const lf = buf.indexOf('\n\n', offset)
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, length: 4 }
  if (lf >= 0) return { index: lf, length: 2 }
  return undefined
}

export function reply(id: string | number, result: unknown): void {
  process.stdout.write(encodeFrame({ jsonrpc: '2.0', id, result }))
}

export function replyError(id: string | number, message: string, code = -32601): void {
  process.stdout.write(encodeFrame({ jsonrpc: '2.0', id, error: { code, message } }))
}

export async function serveStdio(handleMessage: (message: unknown) => void): Promise<void> {
  let buffer = Buffer.alloc(0)
  for await (const chunk of process.stdin) {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    buffer = Buffer.concat([buffer, incoming])
    const parsed = consumeFrames(buffer)
    buffer = parsed.rest
    for (const message of parsed.messages) handleMessage(message)
  }
}
