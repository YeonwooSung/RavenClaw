import { describe, expect, test } from 'bun:test'
import { ACP_METHODS, JSON_RPC_METHOD_NOT_FOUND, PROTOCOL_VERSION, type JsonRpcNotification } from './protocol'
import { createAcpServer, type AcpEngine } from './server'

function resultOf(response: { result?: unknown; error?: unknown }): Record<string, unknown> {
  expect(response.error).toBeUndefined()
  expect(response.result).toBeDefined()
  return response.result as Record<string, unknown>
}

function fakeEngine(opts: {
  events?: unknown[]
  end?: unknown
  onSubmit?: (text: string) => void
  onAbort?: () => void
}): AcpEngine {
  return {
    async *submitMessage(text: string) {
      opts.onSubmit?.(text)
      for (const event of opts.events ?? []) yield event
      return opts.end ?? { reason: 'completed' }
    },
    abort() {
      opts.onAbort?.()
    },
  }
}

describe('createAcpServer', () => {
  test('initialize negotiates v1 and advertises agent info', async () => {
    const server = createAcpServer({
      engineFactory: () => fakeEngine({}),
    })
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 0,
      method: ACP_METHODS.initialize,
      params: { protocolVersion: PROTOCOL_VERSION },
    })
    const result = resultOf(response)
    expect(result.protocolVersion).toBe(1)
    expect(result.agentInfo).toEqual({
      name: 'ravenclaw',
      title: 'RavenClaw',
      version: '0.1.5',
    })
    expect(result.agentCapabilities).toEqual({
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    })
    expect(result.authMethods).toEqual([])
  })

  test('session/prompt forwards text and emits session/update content until RoundEnd', async () => {
    const notifications: JsonRpcNotification[] = []
    let submitted: string | undefined
    const server = createAcpServer({
      engineFactory: () =>
        fakeEngine({
          events: [
            { type: 'text_delta', text: 'Hello' },
            { type: 'text_delta', text: ' world' },
          ],
          end: { reason: 'completed' },
          onSubmit: (text) => {
            submitted = text
          },
        }),
      notify: (notification) => {
        notifications.push(notification)
      },
    })

    const created = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: { cwd: '/tmp' },
      }),
    )
    const sessionId = created.sessionId
    expect(typeof sessionId).toBe('string')
    expect(sessionId.length).toBeGreaterThan(0)

    const response = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: {
        sessionId,
        prompt: [{ type: 'text', text: 'Say hello' }],
      },
    })
    expect(submitted).toBe('Say hello')
    expect(resultOf(response)).toEqual({ stopReason: 'end_turn' })

    const updates = notifications.filter((n) => n.method === ACP_METHODS.sessionUpdate)
    expect(updates.map((n) => n.params)).toEqual([
      {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello' },
        },
      },
      {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' world' },
        },
      },
      {
        sessionId,
        update: { sessionUpdate: 'done', stopReason: 'end_turn' },
      },
    ])
  })

  test('session/prompt maps tool_call and tool_result to session/update', async () => {
    const notifications: JsonRpcNotification[] = []
    const server = createAcpServer({
      engineFactory: () =>
        fakeEngine({
          events: [
            { type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'ls' } },
            {
              type: 'tool_result',
              id: 'c1',
              result: { toolUseId: 'c1', ok: true, content: 'README.md' },
            },
          ],
          end: { reason: 'completed' },
        }),
      notify: (notification) => {
        notifications.push(notification)
      },
    })
    const sessionId = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: { cwd: '/tmp' },
      }),
    ).sessionId
    await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId, prompt: [{ type: 'text', text: 'ls' }] },
    })
    const kinds = notifications.map((n) => {
      const params = n.params as { update?: { sessionUpdate?: string } }
      return params.update?.sessionUpdate
    })
    expect(kinds).toEqual(['tool_call', 'tool_result', 'done'])
  })

  test('session/cancel calls engine.abort', async () => {
    const aborted: string[] = []
    const engines = new Map<string, AcpEngine>()
    const server = createAcpServer({
      engineFactory: (sessionId) => {
        const engine = fakeEngine({
          onAbort: () => {
            aborted.push(sessionId)
          },
        })
        engines.set(sessionId, engine)
        return engine
      },
    })
    const sessionId = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: { cwd: '/tmp' },
      }),
    ).sessionId as string
    const response = await server.handle({
      jsonrpc: '2.0',
      method: ACP_METHODS.sessionCancel,
      params: { sessionId },
    })
    expect(aborted).toEqual([sessionId])
    expect(response.result).toBeNull()
    expect(engines.get(sessionId)).toBeDefined()
  })

  test('session/load attaches an existing engine and then accepts prompt', async () => {
    const loaded: string[] = []
    const server = createAcpServer({
      engineFactory: () => fakeEngine({}),
      loadEngine: (sessionId) => {
        loaded.push(sessionId)
        return fakeEngine({
          events: [{ type: 'text_delta', text: 'resumed' }],
          end: { reason: 'completed' },
        })
      },
    })
    const init = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 0,
        method: ACP_METHODS.initialize,
        params: { protocolVersion: PROTOCOL_VERSION },
      }),
    )
    expect((init.agentCapabilities as { loadSession?: boolean }).loadSession).toBe(true)

    const loadedId = 'sess_existing'
    const load = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionLoad,
        params: { sessionId: loadedId },
      }),
    )
    expect(load).toEqual({ sessionId: loadedId })
    expect(loaded).toEqual([loadedId])

    const prompt = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId: loadedId, prompt: 'continue' },
    })
    expect(resultOf(prompt)).toEqual({ stopReason: 'end_turn' })
  })

  test('session/load without a loader is method-not-found', async () => {
    const server = createAcpServer({ engineFactory: () => fakeEngine({}) })
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: ACP_METHODS.sessionLoad,
      params: { sessionId: 'sess_x' },
    })
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: JSON_RPC_METHOD_NOT_FOUND, message: 'Method not found' },
    })
  })

  test('session/load surfaces loader errors as invalid params', async () => {
    const server = createAcpServer({
      engineFactory: () => fakeEngine({}),
      loadEngine: async () => {
        throw new Error('session not found: missing')
      },
    })
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 4,
      method: ACP_METHODS.sessionLoad,
      params: { sessionId: 'missing' },
    })
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32602, message: 'session not found: missing' },
    })
  })

  test('unknown method returns a JSON-RPC error', async () => {
    const server = createAcpServer({
      engineFactory: () => fakeEngine({}),
    })
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 9,
      method: 'session/explode',
      params: {},
    })
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: JSON_RPC_METHOD_NOT_FOUND, message: 'Method not found' },
    })
  })
})
