import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { PROTOCOL_VERSION, type AcpEngine } from '@ravenclaw/acp'
import { runAcpStdio } from './acp-stdio'

function fakeEngine(opts: {
  events?: unknown[]
  end?: unknown
  onSubmit?: (text: string) => void
}): AcpEngine {
  return {
    async *submitMessage(text: string) {
      opts.onSubmit?.(text)
      for (const event of opts.events ?? []) yield event
      return opts.end ?? { reason: 'completed' }
    },
    abort() {},
  }
}

function jsonLines(output: PassThrough) {
  let buf = ''
  const messages: unknown[] = []
  const waiters: Array<() => void> = []
  output.setEncoding('utf8')
  output.on('data', (chunk: string) => {
    buf += chunk
    let idx = buf.indexOf('\n')
    while (idx >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.trim() !== '') messages.push(JSON.parse(line) as unknown)
      idx = buf.indexOf('\n')
    }
    for (const waiter of waiters.splice(0)) waiter()
  })
  return {
    messages,
    async waitFor(count: number): Promise<unknown[]> {
      const deadline = Date.now() + 2000
      while (messages.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`timeout waiting for ${count} messages, got ${messages.length}`)
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve)
          setTimeout(resolve, 25)
        })
      }
      return messages
    },
  }
}

function writeJson(input: PassThrough, value: unknown): void {
  input.write(`${JSON.stringify(value)}\n`)
}

describe('runAcpStdio', () => {
  test('initialize request writes protocolVersion', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const { waitFor } = jsonLines(output)

    const running = runAcpStdio({
      input,
      output,
      boot: async () => ({ engine: fakeEngine({}) }),
    })

    writeJson(input, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION },
    })
    input.end()
    await running

    const messages = await waitFor(1)
    const text = JSON.stringify(messages)
    expect(text).toContain('protocolVersion')
    expect(messages[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 0,
      result: { protocolVersion: PROTOCOL_VERSION },
    })
  })

  test('session/prompt with fake engine yields text update', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const { messages, waitFor } = jsonLines(output)
    let submitted: string | undefined
    let boots = 0

    const running = runAcpStdio({
      input,
      output,
      boot: async () => {
        boots += 1
        return {
          engine: fakeEngine({
            events: [{ type: 'text_delta', text: 'Hello' }],
            onSubmit: (text) => {
              submitted = text
            },
          }),
        }
      },
    })

    writeJson(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd: '/tmp' },
    })
    const afterNew = await waitFor(1)
    const created = afterNew[0] as { result?: { sessionId?: string } }
    const sessionId = created.result?.sessionId
    expect(typeof sessionId).toBe('string')
    expect(boots).toBe(1)

    writeJson(input, {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: {
        sessionId,
        prompt: [{ type: 'text', text: 'Say hello' }],
      },
    })
    await waitFor(4)
    input.end()
    await running

    expect(submitted).toBe('Say hello')
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Hello' },
            },
          },
        }),
        expect.objectContaining({
          id: 2,
          result: { stopReason: 'end_turn' },
        }),
      ]),
    )
  })

  test('session/load uses boot.load and then accepts prompt', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const { waitFor } = jsonLines(output)
    const loaded: string[] = []

    const running = runAcpStdio({
      input,
      output,
      boot: async () => ({
        engine: fakeEngine({}),
        load: async (sessionId) => {
          loaded.push(sessionId)
          return fakeEngine({
            events: [{ type: 'text_delta', text: 'from load' }],
          })
        },
      }),
    })

    writeJson(input, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION },
    })
    const init = (await waitFor(1))[0] as {
      result?: { agentCapabilities?: { loadSession?: boolean } }
    }
    expect(init.result?.agentCapabilities?.loadSession).toBe(true)

    writeJson(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/load',
      params: { sessionId: 'sess_saved' },
    })
    await waitFor(2)
    writeJson(input, {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'sess_saved', prompt: 'hi' },
    })
    const messages = await waitFor(5)
    input.end()
    await running

    expect(loaded).toEqual(['sess_saved'])
    expect(JSON.stringify(messages)).toContain('from load')
  })
})
