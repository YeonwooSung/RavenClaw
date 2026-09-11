export type SecretKeyResult =
  | { kind: 'char'; echo: string }
  | { kind: 'backspace'; echo: string }
  | { kind: 'ignore' }
  | { kind: 'submit' }
  | { kind: 'cancel' }

/** One keypress against a hidden secret buffer. Echo is '*' or backspace erase. */
export function applySecretKey(buf: string, key: string): { buf: string; result: SecretKeyResult } {
  if (key === '\n' || key === '\r') return { buf, result: { kind: 'submit' } }
  if (key === '\u0003') return { buf: '', result: { kind: 'cancel' } }
  if (key === '\u007f' || key === '\b') {
    if (buf.length === 0) return { buf, result: { kind: 'ignore' } }
    return { buf: buf.slice(0, -1), result: { kind: 'backspace', echo: '\b \b' } }
  }
  if (key < ' ' || key === '\u001b') return { buf, result: { kind: 'ignore' } }
  return { buf: buf + key, result: { kind: 'char', echo: '*' } }
}

export async function readSecretLine(opts: {
  input: NodeJS.ReadStream
  write: (chunk: string) => void
}): Promise<string | undefined> {
  if (typeof opts.input.setRawMode !== 'function' || !opts.input.isTTY) {
    return readPlainLine(opts.input)
  }

  return new Promise((resolve) => {
    const stdin = opts.input
    const previousRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    let buf = ''

    const finish = (value: string | undefined) => {
      stdin.off('data', onData)
      stdin.setRawMode(Boolean(previousRaw))
      opts.write('\n')
      resolve(value)
    }

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const key of text) {
        const next = applySecretKey(buf, key)
        buf = next.buf
        if (next.result.kind === 'submit') {
          finish(buf)
          return
        }
        if (next.result.kind === 'cancel') {
          finish(undefined)
          return
        }
        if (next.result.kind === 'char' || next.result.kind === 'backspace') {
          opts.write(next.result.echo)
        }
      }
    }

    stdin.on('data', onData)
  })
}

function readPlainLine(input: AsyncIterable<string | Buffer>): Promise<string | undefined> {
  return (async () => {
    for await (const chunk of input) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      return text.replace(/\r?\n$/, '')
    }
    return undefined
  })()
}
