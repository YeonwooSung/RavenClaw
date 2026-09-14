import { describe, expect, test } from 'bun:test'
import { consumeSubmitDeltas, streamChatTurn } from './stream-turn'

function clip(text: string): string {
  return text.length <= 20 ? text : `${text.slice(0, 19)}…`
}

function recordingTransport() {
  const posts: string[] = []
  const edits: Array<{ id: string; text: string }> = []
  let nextId = 1
  let failNextEdit = false
  return {
    posts,
    edits,
    failNextEdit() {
      failNextEdit = true
    },
    async post(text: string) {
      posts.push(text)
      const id = `m${nextId}`
      nextId += 1
      return { ok: true, id }
    },
    async edit(id: string, text: string) {
      if (failNextEdit) {
        failNextEdit = false
        return { ok: false }
      }
      edits.push({ id, text })
      return { ok: true }
    },
  }
}

async function* deltas(...parts: string[]) {
  for (const part of parts) yield { type: 'text_delta', text: part }
  return { reason: 'completed' }
}

describe('streamChatTurn', () => {
  test('posts stub, throttles mid-turn edits, then publishes the final body', async () => {
    const transport = recordingTransport()
    let t = 0
    await streamChatTurn({
      session: { submitMessage: () => deltas('hel', 'lo') },
      text: 'hi',
      transport,
      clip,
      now: () => {
        t += 1_000
        return t
      },
    })
    expect(transport.posts[0]).toBe('…')
    expect(transport.edits.map((row) => row.text)).toEqual(['hel', 'hello', 'hello'])
  })

  test('failed edit posts a new message', async () => {
    const transport = recordingTransport()
    transport.failNextEdit()
    await streamChatTurn({
      session: { submitMessage: () => deltas('ok') },
      text: 'hi',
      transport,
      clip,
      now: () => 2_000,
    })
    expect(transport.posts).toEqual(['…', 'ok'])
  })

  test('submit errors publish formatError and skip the exception text by default', async () => {
    const transport = recordingTransport()
    await streamChatTurn({
      session: {
        async *submitMessage() {
          throw new Error('boom')
        },
      },
      text: 'hi',
      transport,
      clip,
      formatError: () => 'turn failed',
    })
    expect(transport.edits.at(-1)?.text).toBe('turn failed')
  })

  test('ignores non-text_delta events', async () => {
    const transport = recordingTransport()
    await streamChatTurn({
      session: {
        async *submitMessage() {
          yield { type: 'status', message: 'x' }
          yield { type: 'text_delta', text: '' }
          yield { type: 'text_delta', text: 'hi' }
          return { reason: 'completed' }
        },
      },
      text: 'q',
      transport,
      clip,
    })
    expect(transport.edits.at(-1)?.text).toBe('hi')
  })
})

describe('consumeSubmitDeltas', () => {
  test('forwards only non-empty text_delta', async () => {
    const seen: string[] = []
    await consumeSubmitDeltas(
      { submitMessage: () => deltas('a', '') },
      'q',
      async (text) => {
        seen.push(text)
      },
    )
    // second delta is empty string — skipped
    expect(seen).toEqual(['a'])
  })
})
