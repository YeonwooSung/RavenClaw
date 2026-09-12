import type { RoundEnd, SessionEngine, StreamEvent } from '@ravenclaw/core'

export interface RunExecOpts {
  prompt: string
  json?: boolean
  engine: SessionEngine
  write?: (chunk: string) => void
  /** When false, leave the engine open (serve reuses it). Default true. */
  closeEngine?: boolean
}

export async function runExec(opts: RunExecOpts): Promise<{
  text: string
  events: StreamEvent[]
  end: RoundEnd
}> {
  const write = opts.write ?? ((chunk: string) => process.stdout.write(chunk))
  const events: StreamEvent[] = []
  let text = ''
  const gen = opts.engine.submitMessage(opts.prompt)

  try {
    while (true) {
      const next = await gen.next()
      if (next.done) {
        const end = next.value
        const event: StreamEvent = { type: 'round_end', end }
        events.push(event)
        if (opts.json) write(`${JSON.stringify(event)}\n`)
        else if (text.length > 0 && !text.endsWith('\n')) write('\n')
        return { text, events, end }
      }
      const event = next.value
      events.push(event)
      if (event.type === 'text_delta') {
        text += event.text
        if (!opts.json) write(event.text)
      }
      if (opts.json) write(`${JSON.stringify(event)}\n`)
    }
  } finally {
    if (opts.closeEngine !== false) await opts.engine.close()
  }
}
