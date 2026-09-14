export const CHAT_STUB_TEXT = '…'
export const CHAT_UPDATE_THROTTLE_MS = 1_000

export interface ChatTurnTransport {
  post(text: string): Promise<{ ok: boolean; id?: string }>
  edit(id: string, text: string): Promise<{ ok: boolean }>
}

export interface ChatBoundSubmit {
  submitMessage: (text: string) => AsyncGenerator<unknown, unknown>
}

export async function streamChatTurn(opts: {
  session: ChatBoundSubmit
  text: string
  transport: ChatTurnTransport
  clip: (text: string) => string
  now?: () => number
  throttleMs?: number
  stubText?: string
  formatError?: (error: unknown) => string
}): Promise<void> {
  const stubText = opts.stubText ?? CHAT_STUB_TEXT
  const now = opts.now ?? Date.now
  const throttleMs = opts.throttleMs ?? CHAT_UPDATE_THROTTLE_MS
  const formatError =
    opts.formatError ?? ((error: unknown) => (error instanceof Error ? error.message : String(error)))

  const stub = await opts.transport.post(stubText)
  let messageId = stub.ok ? stub.id : undefined
  let acc = ''
  let lastUpdate = 0

  const publish = async (final: boolean) => {
    const body = opts.clip(acc === '' ? (final ? '(no output)' : stubText) : acc)
    if (messageId !== undefined) {
      const updated = await opts.transport.edit(messageId, body)
      if (updated.ok) return
    }
    const posted = await opts.transport.post(body)
    if (posted.ok && posted.id !== undefined) messageId = posted.id
  }

  try {
    await consumeSubmitDeltas(opts.session, opts.text, async (delta) => {
      acc += delta
      const t = now()
      if (t - lastUpdate >= throttleMs) {
        lastUpdate = t
        await publish(false)
      }
    })
    await publish(true)
  } catch (error) {
    acc = formatError(error)
    await publish(true)
  }
}

export async function consumeSubmitDeltas(
  session: ChatBoundSubmit,
  text: string,
  onDelta: (text: string) => Promise<void>,
): Promise<void> {
  const gen = session.submitMessage(text)
  while (true) {
    const next = await gen.next()
    if (next.done) return
    const event = next.value
    if (!isRecord(event) || event.type !== 'text_delta') continue
    if (typeof event.text !== 'string' || event.text === '') continue
    await onDelta(event.text)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
