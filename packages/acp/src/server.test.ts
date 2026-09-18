import { describe, expect, test } from 'bun:test'
import {
  createMemoryStore,
  createSessionEngine,
  type CompactPolicy,
  type ModelProfile,
  type Provider,
  type ProviderChunk,
  type ProviderRequest,
  type Tool,
  type ToolContext,
  type UserSubmitInput,
} from '@ravenclaw/core'
import {
  ACP_METHODS,
  AGENT_INFO,
  JSON_RPC_METHOD_NOT_FOUND,
  PERMISSION_OPTIONS,
  PROTOCOL_VERSION,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from './protocol'
import {
  createAcpServer,
  type AcpEngine,
  type AcpEngineFactoryOpts,
} from './server'

function resultOf(response: { result?: unknown; error?: unknown }): Record<string, unknown> {
  expect(response.error).toBeUndefined()
  expect(response.result).toBeDefined()
  return response.result as Record<string, unknown>
}

function fakeEngine(opts: {
  events?: unknown[]
  end?: unknown
  onSubmit?: (input: UserSubmitInput) => void
  onAbort?: (kind?: 'cancel' | 'interrupt') => void
}): AcpEngine {
  return {
    async *submitMessage(input: UserSubmitInput) {
      opts.onSubmit?.(input)
      for (const event of opts.events ?? []) yield event
      return opts.end ?? { reason: 'completed' }
    },
    abort(kind?: 'cancel' | 'interrupt') {
      opts.onAbort?.(kind)
    },
  }
}

function defaultModel(id = 'dummy'): ModelProfile {
  return {
    id,
    contextWindow: 32_000,
    reserveOutputTokens: 3_200,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
  }
}

function defaultCompact(): CompactPolicy {
  return {
    enabled: true,
    autoCompactBuffer: 13_000,
    blockingBufferWhenManual: 3_000,
    protectLastMessages: 20,
    keepRecentFiles: 5,
    maxCharsPerRestoredFile: 5_000,
    maxCharsRestoredFilesTotal: 50_000,
    maxCharsPerRestoredSkill: 5_000,
    maxCharsRestoredSkillsTotal: 25_000,
    maxConsecutiveFailures: 3,
    llmSummarize: false,
  }
}

function createFakeProvider(scripts: ProviderChunk[][]): Provider {
  const queue = [...scripts]
  return {
    id: 'fake',
    apiMode: 'openai_compat',
    profile(model: string) {
      return defaultModel(model)
    },
    async *stream(_req: ProviderRequest, signal: AbortSignal) {
      const script = queue.shift() ?? [{ type: 'stop' as const, reason: null }]
      for (const chunk of script) {
        if (signal.aborted) return
        yield chunk
      }
    },
  }
}

function textThenStop(text: string): ProviderChunk[] {
  return [
    { type: 'text_delta', text },
    { type: 'stop', reason: 'end' },
  ]
}

function toolThenStop(id: string, name: string, input: unknown): ProviderChunk[] {
  return [
    { type: 'tool_call', id, name, input },
    { type: 'stop', reason: 'tool_use' },
  ]
}

function createAskEcho(): Tool<{ text: string }, string> {
  return {
    name: 'Echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    parse(input: unknown) {
      if (
        !input ||
        typeof input !== 'object' ||
        typeof (input as { text?: unknown }).text !== 'string'
      ) {
        return { ok: false as const, message: 'expected { text: string }' }
      }
      return { ok: true as const, value: { text: (input as { text: string }).text } }
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async checkPermissions() {
      return { behavior: 'ask' as const, message: 'Echo?' }
    },
    async execute(input: { text: string }, _ctx: ToolContext) {
      return input.text
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
      version: AGENT_INFO.version,
    })
    expect(result.agentCapabilities).toEqual({
      loadSession: false,
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
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
    const aborted: Array<{ id: string; kind?: 'cancel' | 'interrupt' }> = []
    const engines = new Map<string, AcpEngine>()
    const server = createAcpServer({
      engineFactory: (sessionId) => {
        const engine = fakeEngine({
          onAbort: (kind) => {
            aborted.push({ id: sessionId, kind })
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
    expect(aborted).toEqual([{ id: sessionId, kind: 'cancel' }])
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

  test('session/load drains replayPendingAsks', async () => {
    let replayed = 0
    const server = createAcpServer({
      engineFactory: () => fakeEngine({}),
      loadEngine: () => ({
        ...fakeEngine({}),
        async *replayPendingAsks() {
          replayed += 1
          yield {
            type: 'permission_ask',
            id: 'c1',
            tool: 'Bash',
            input: {},
            message: 'Bash?',
          }
        },
      }),
    })
    const load = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: ACP_METHODS.sessionLoad,
      params: { sessionId: 'sess_parked' },
    })
    expect(resultOf(load)).toEqual({ sessionId: 'sess_parked' })
    expect(replayed).toBe(1)
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

  test('session/new forwards cwd, model, and mcpServers to the factory', async () => {
    const received: Array<{ sessionId: string; opts?: AcpEngineFactoryOpts }> = []
    const mcpServers = [
      { type: 'stdio', name: 'workspace-tools', command: '/bin/mcp', args: ['--stdio'] },
    ]
    const server = createAcpServer({
      engineFactory: (sessionId, opts) => {
        received.push({ sessionId, opts })
        return fakeEngine({})
      },
    })
    const created = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: { cwd: '/tmp/project', model: 'anthropic/claude-sonnet-4', mcpServers },
      }),
    )
    expect(received).toHaveLength(1)
    expect(received[0]?.sessionId).toBe(created.sessionId)
    expect(received[0]?.opts?.cwd).toBe('/tmp/project')
    expect(received[0]?.opts?.model).toBe('anthropic/claude-sonnet-4')
    expect(received[0]?.opts?.mcpServers).toEqual(mcpServers)
    expect(typeof received[0]?.opts?.requestPermission).toBe('function')
  })

  test('session/prompt attaches inline ACP image blocks to submitMessage', async () => {
    let submitted: UserSubmitInput | undefined
    const server = createAcpServer({
      engineFactory: () =>
        fakeEngine({
          onSubmit: (input) => {
            submitted = input
          },
        }),
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
      params: {
        sessionId,
        prompt: [
          { type: 'text', text: 'look' },
          { type: 'image', mimeType: 'image/png', data: 'aaa' },
        ],
      },
    })
    expect(submitted).toEqual({
      text: 'look',
      images: [{ mediaType: 'image/png', data: 'aaa' }],
    })
  })

  test('permission_ask requests allow / deny / allow_always from the editor', async () => {
    const answers = ['allow', 'deny', 'allow_always'] as const
    for (const optionId of answers) {
      const requests: JsonRpcRequest[] = []
      let decided: string | undefined
      const server = createAcpServer({
        engineFactory: (_sessionId, opts) => ({
          async *submitMessage() {
            const answer = await opts?.requestPermission?.({
              id: `call_${optionId}`,
              tool: 'Bash',
              input: { command: 'ls' },
              message: 'run ls',
            })
            decided = answer
            yield {
              type: 'tool_result',
              id: `call_${optionId}`,
              result: {
                toolUseId: `call_${optionId}`,
                ok: answer !== 'deny',
                content: answer === 'deny' ? 'denied' : 'ran',
              },
            }
            return { reason: 'completed' }
          },
          abort() {},
        }),
        request: async (req) => {
          requests.push(req)
          return { outcome: { outcome: 'selected', optionId } }
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
        params: { sessionId, prompt: 'ls' },
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.method).toBe(ACP_METHODS.sessionRequestPermission)
      expect(requests[0]?.params).toMatchObject({
        sessionId,
        title: 'Allow Bash?',
        description: 'run ls',
        toolCall: { toolCallId: `call_${optionId}`, title: 'Bash', rawInput: { command: 'ls' } },
        options: PERMISSION_OPTIONS,
      })
      expect(decided).toBe(optionId)
    }
  })

  test('permission_ask stream event also emits session/request_permission', async () => {
    const requests: JsonRpcRequest[] = []
    const server = createAcpServer({
      engineFactory: () =>
        fakeEngine({
          events: [
            {
              type: 'permission_ask',
              id: 'c1',
              tool: 'Bash',
              input: { command: 'pwd' },
              message: 'ask',
            },
          ],
        }),
      request: async (req) => {
        requests.push(req)
        return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
      },
    })
    const sessionId = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: {},
      }),
    ).sessionId
    await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId, prompt: 'pwd' },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('session/request_permission')
  })

  test('Edit permission_ask includes path, oldText, and newText', async () => {
    const requests: JsonRpcRequest[] = []
    const server = createAcpServer({
      engineFactory: (_sessionId, opts) => ({
        async *submitMessage() {
          await opts?.requestPermission?.({
            id: 'e1',
            tool: 'Edit',
            input: { path: 'src/a.ts', old_string: 'foo', new_string: 'bar' },
            message: 'edit a.ts',
          })
          return { reason: 'completed' }
        },
        abort() {},
      }),
      request: async (req) => {
        requests.push(req)
        return { outcome: { outcome: 'selected', optionId: 'allow' } }
      },
    })
    const sessionId = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: {},
      }),
    ).sessionId
    await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId, prompt: 'edit' },
    })
    expect(requests[0]?.params).toMatchObject({
      path: 'src/a.ts',
      oldText: 'foo',
      newText: 'bar',
      toolCall: {
        title: 'Edit',
        rawInput: { path: 'src/a.ts', old_string: 'foo', new_string: 'bar' },
      },
    })
  })

  test('Write and ApplyPatch permission_ask include path and newText', async () => {
    const requests: JsonRpcRequest[] = []
    const server = createAcpServer({
      engineFactory: (_sessionId, opts) => ({
        async *submitMessage() {
          await opts?.requestPermission?.({
            id: 'w1',
            tool: 'Write',
            input: { path: 'note.md', content: 'hi' },
            message: 'write',
          })
          await opts?.requestPermission?.({
            id: 'p1',
            tool: 'ApplyPatch',
            input: { operations: [{ type: 'update_file', path: 'c.ts', diff: '+y' }] },
            message: 'patch',
          })
          return { reason: 'completed' }
        },
        abort() {},
      }),
      request: async (req) => {
        requests.push(req)
        return { outcome: { outcome: 'selected', optionId: 'allow' } }
      },
    })
    const sessionId = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: {},
      }),
    ).sessionId
    await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId, prompt: 'write' },
    })
    expect(requests[0]?.params).toMatchObject({ path: 'note.md', newText: 'hi' })
    expect((requests[0]?.params as { oldText?: unknown }).oldText).toBeUndefined()
    expect(requests[1]?.params).toMatchObject({ path: 'c.ts', newText: '+y' })
  })

  test('sensitive .env / id_rsa never auto-approve', async () => {
    const requests: JsonRpcRequest[] = []
    let decided: string | undefined
    const server = createAcpServer({
      engineFactory: (_sessionId, opts) => ({
        async *submitMessage() {
          decided = await opts?.requestPermission?.({
            id: 's1',
            tool: 'Write',
            input: { path: '.env', content: 'SECRET=1' },
            message: 'write env',
          })
          return { reason: 'completed' }
        },
        abort() {},
      }),
      request: async (req) => {
        requests.push(req)
        return { outcome: { outcome: 'selected', optionId: 'allow_always' } }
      },
    })
    const sessionId = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: {},
      }),
    ).sessionId
    await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId, prompt: 'env' },
    })
    const options = (requests[0]?.params as { options?: Array<{ optionId: string }> }).options
    expect(options?.some((option) => option.optionId === 'allow_always')).toBe(false)
    expect(decided).toBe('allow')
  })

  test('ApplyPatch with a later .env op never auto-approves', async () => {
    const requests: JsonRpcRequest[] = []
    let decided: string | undefined
    const server = createAcpServer({
      engineFactory: (_sessionId, opts) => ({
        async *submitMessage() {
          decided = await opts?.requestPermission?.({
            id: 'p2',
            tool: 'ApplyPatch',
            input: {
              operations: [
                { type: 'update_file', path: 'a.ts', diff: '+a' },
                { type: 'create_file', path: '.env', diff: 'SECRET=1' },
              ],
            },
            message: 'patch',
          })
          return { reason: 'completed' }
        },
        abort() {},
      }),
      request: async (req) => {
        requests.push(req)
        return { outcome: { outcome: 'selected', optionId: 'allow_always' } }
      },
    })
    const sessionId = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: {},
      }),
    ).sessionId
    await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId, prompt: 'patch' },
    })
    const params = requests[0]?.params as {
      path?: string
      newText?: string
      options?: Array<{ optionId: string }>
    }
    expect(params.path).toBe('a.ts')
    expect(params.newText).toContain('.env')
    expect(params.options?.some((option) => option.optionId === 'allow_always')).toBe(false)
    expect(decided).toBe('allow')
  })

  test('Bash permission_ask stays name+input without an edit proposal', async () => {
    const requests: JsonRpcRequest[] = []
    const server = createAcpServer({
      engineFactory: (_sessionId, opts) => ({
        async *submitMessage() {
          await opts?.requestPermission?.({
            id: 'b1',
            tool: 'Bash',
            input: { command: 'ls', path: 'ignored.ts' },
            message: 'run',
          })
          return { reason: 'completed' }
        },
        abort() {},
      }),
      request: async (req) => {
        requests.push(req)
        return { outcome: { outcome: 'selected', optionId: 'allow' } }
      },
    })
    const sessionId = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: {},
      }),
    ).sessionId
    await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId, prompt: 'ls' },
    })
    const params = requests[0]?.params as Record<string, unknown>
    expect(params.path).toBeUndefined()
    expect(params.oldText).toBeUndefined()
    expect(params.newText).toBeUndefined()
    expect(params.toolCall).toMatchObject({
      title: 'Bash',
      rawInput: { command: 'ls', path: 'ignored.ts' },
    })
  })

  test('timeout with no editor answer does not deny', async () => {
    let decided: string | undefined
    let threw: string | undefined
    const server = createAcpServer({
      engineFactory: (_sessionId, opts) => ({
        async *submitMessage() {
          try {
            decided = await opts?.requestPermission?.({
              id: 'c-timeout',
              tool: 'Bash',
              input: { command: 'rm -rf /' },
              message: 'dangerous',
            })
          } catch (error) {
            threw = error instanceof Error ? error.name : String(error)
          }
          return { reason: 'completed' }
        },
        abort() {},
      }),
      request: () => new Promise(() => {}),
      permissionTimeoutMs: 120_000,
      wait: async () => {},
    })
    const sessionId = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: { cwd: '/tmp' },
      }),
    ).sessionId
    const prompt = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId, prompt: 'rm' },
    })
    expect(resultOf(prompt)).toEqual({ stopReason: 'cancelled' })
    expect(decided).toBeUndefined()
    expect(threw).toBe('AskWaiterExpired')
  })

  test('timeout leaves pending_asks and does not persist a deny tool row', async () => {
    const store = createMemoryStore()
    const session = {
      id: 'sess_eval_pending_ask',
      createdAt: 1,
      updatedAt: 1,
      cwd: '/tmp',
      model: 'dummy',
      permissionMode: 'default' as const,
      compactGeneration: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      funding: 'byok' as const,
    }
    await store.createSession(session)
    let engine: ReturnType<typeof createSessionEngine> | undefined
    const server = createAcpServer({
      engineFactory: (_sessionId, opts) => {
        engine = createSessionEngine({
          session,
          provider: createFakeProvider([
            toolThenStop('call_eval', 'Echo', { text: 'hi' }),
            textThenStop('done'),
          ]),
          store,
          tools: [createAskEcho()],
          compact: defaultCompact(),
          model: defaultModel(),
          maxRounds: 8,
          bare: true,
          askUser: (event, signal) => {
            if (!opts?.requestPermission) return Promise.resolve('deny')
            return opts.requestPermission(event, signal)
          },
        })
        return engine
      },
      request: () => new Promise(() => {}),
      permissionTimeoutMs: 120_000,
      wait: async () => {},
    })
    const sessionId = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: { cwd: '/tmp' },
      }),
    ).sessionId
    const prompt = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId, prompt: 'rm' },
    })
    expect(resultOf(prompt)).toEqual({ stopReason: 'cancelled' })
    const pending = await store.listPendingAsks(session.id)
    expect(pending.map((row) => row.callId)).toEqual(['call_eval'])
    const loaded = await store.loadSession(session.id)
    expect(loaded.messages.filter((msg) => msg.role === 'tool')).toEqual([])
    expect(
      loaded.messages.some(
        (msg) =>
          msg.role === 'tool' &&
          msg.blocks.some(
            (block) => block.type === 'text' && block.text.includes('permission_denied'),
          ),
      ),
    ).toBe(false)
    expect(engine?.liveTurnId()).toBeNull()
  })

  test('session/load still drains replayPendingAsks when the session is already live', async () => {
    let replayed = 0
    const server = createAcpServer({
      engineFactory: () => ({
        ...fakeEngine({}),
        async *replayPendingAsks() {
          replayed += 1
        },
      }),
    })
    const sessionId = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: { cwd: '/tmp' },
      }),
    ).sessionId
    const load = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionLoad,
      params: { sessionId },
    })
    expect(resultOf(load)).toEqual({ sessionId })
    expect(replayed).toBeGreaterThanOrEqual(1)
  })

  test('session/prompt drains replayPendingAsks before submitMessage', async () => {
    const order: string[] = []
    const server = createAcpServer({
      engineFactory: () => ({
        async *submitMessage() {
          order.push('submit')
          return { reason: 'completed' }
        },
        abort() {},
        async *replayPendingAsks() {
          order.push('replay')
        },
      }),
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
      params: { sessionId, prompt: 'hi' },
    })
    expect(order).toEqual(['replay', 'submit'])
  })

  test('session/prompt replay timeout returns cancelled and does not submitMessage', async () => {
    let submitted = 0
    const server = createAcpServer({
      engineFactory: () => ({
        async *submitMessage() {
          submitted += 1
          return { reason: 'completed' }
        },
        abort() {},
        async *replayPendingAsks() {
          throw Object.assign(new Error('permission waiter expired'), { name: 'AskWaiterExpired' })
        },
      }),
    })
    const sessionId = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: { cwd: '/tmp' },
      }),
    ).sessionId
    const prompt = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId, prompt: 'hi' },
    })
    expect(resultOf(prompt)).toEqual({ stopReason: 'cancelled' })
    expect(submitted).toBe(0)
  })

  test('session/load after timeout re-asks leftover-ask on the live map entry', async () => {
    const store = createMemoryStore()
    const session = {
      id: 'sess_replay_load',
      createdAt: 1,
      updatedAt: 1,
      cwd: '/tmp',
      model: 'dummy',
      permissionMode: 'default' as const,
      compactGeneration: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      funding: 'byok' as const,
    }
    await store.createSession(session)
    let engine: ReturnType<typeof createSessionEngine> | undefined
    const requests: JsonRpcRequest[] = []
    let expireNextWait = true
    const server = createAcpServer({
      engineFactory: (_sessionId, opts) => {
        engine = createSessionEngine({
          session,
          provider: createFakeProvider([
            toolThenStop('call_eval', 'Echo', { text: 'hi' }),
            textThenStop('done'),
          ]),
          store,
          tools: [createAskEcho()],
          compact: defaultCompact(),
          model: defaultModel(),
          maxRounds: 8,
          bare: true,
          askUser: (event, signal) => {
            if (!opts?.requestPermission) return Promise.resolve('deny')
            return opts.requestPermission(event, signal)
          },
        })
        return engine
      },
      request: async (req) => {
        requests.push(req)
        if (requests.length === 1) return new Promise(() => {})
        return { outcome: { outcome: 'selected', optionId: 'allow' } }
      },
      permissionTimeoutMs: 120_000,
      wait: async () => {
        if (expireNextWait) {
          expireNextWait = false
          return
        }
        await new Promise(() => {})
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
    const prompt = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId, prompt: 'rm' },
    })
    expect(resultOf(prompt)).toEqual({ stopReason: 'cancelled' })
    expect((await store.listPendingAsks(session.id)).map((row) => row.callId)).toEqual(['call_eval'])
    expect(engine?.liveTurnId()).toBeNull()

    const load = await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: ACP_METHODS.sessionLoad,
      params: { sessionId },
    })
    expect(resultOf(load)).toEqual({ sessionId })
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests[1]?.method).toBe(ACP_METHODS.sessionRequestPermission)
    expect(await store.listPendingAsks(session.id)).toHaveLength(0)
  })

  test('session/prompt after timeout settles leftover-ask via replay then submits the new prompt', async () => {
    const store = createMemoryStore()
    const session = {
      id: 'sess_replay_prompt',
      createdAt: 1,
      updatedAt: 1,
      cwd: '/tmp',
      model: 'dummy',
      permissionMode: 'default' as const,
      compactGeneration: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      funding: 'byok' as const,
    }
    await store.createSession(session)
    let engine: ReturnType<typeof createSessionEngine> | undefined
    const requests: JsonRpcRequest[] = []
    let expireNextWait = true
    const submitted: UserSubmitInput[] = []
    const server = createAcpServer({
      engineFactory: (_sessionId, opts) => {
        engine = createSessionEngine({
          session,
          provider: createFakeProvider([
            toolThenStop('call_eval', 'Echo', { text: 'hi' }),
            textThenStop('done'),
          ]),
          store,
          tools: [createAskEcho()],
          compact: defaultCompact(),
          model: defaultModel(),
          maxRounds: 8,
          bare: true,
          askUser: (event, signal) => {
            if (!opts?.requestPermission) return Promise.resolve('deny')
            return opts.requestPermission(event, signal)
          },
        })
        const inner = engine
        return {
          submitMessage(input: UserSubmitInput) {
            submitted.push(input)
            return inner.submitMessage(input)
          },
          abort() {
            inner.abort()
          },
          replayPendingAsks() {
            return inner.replayPendingAsks()
          },
        }
      },
      request: async (req) => {
        requests.push(req)
        if (requests.length === 1) return new Promise(() => {})
        return { outcome: { outcome: 'selected', optionId: 'allow' } }
      },
      permissionTimeoutMs: 120_000,
      wait: async () => {
        if (expireNextWait) {
          expireNextWait = false
          return
        }
        await new Promise(() => {})
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
    const first = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId, prompt: 'rm' },
    })
    expect(resultOf(first)).toEqual({ stopReason: 'cancelled' })
    expect((await store.listPendingAsks(session.id)).map((row) => row.callId)).toEqual(['call_eval'])
    expect(submitted).toHaveLength(1)
    expect(engine?.liveTurnId()).toBeNull()

    const second = await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId, prompt: 'continue' },
    })
    expect(resultOf(second)).toEqual({ stopReason: 'end_turn' })
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests[1]?.method).toBe(ACP_METHODS.sessionRequestPermission)
    expect(await store.listPendingAsks(session.id)).toHaveLength(0)
    expect(submitted).toHaveLength(2)
    expect(submitted[1]).toBe('continue')
    const loaded = await store.loadSession(session.id)
    expect(
      loaded.messages.some(
        (msg) =>
          msg.role === 'user' &&
          msg.blocks.some((block) => block.type === 'text' && block.text === 'continue'),
      ),
    ).toBe(true)
    expect(loaded.messages.some((msg) => msg.role === 'tool')).toBe(true)
  })

  test('session/load still attaches an existing engine after factory opts change', async () => {
    const loaded: string[] = []
    const server = createAcpServer({
      engineFactory: () => fakeEngine({}),
      loadEngine: (sessionId) => {
        loaded.push(sessionId)
        return fakeEngine({
          events: [{ type: 'text_delta', text: 'still loaded' }],
          end: { reason: 'completed' },
        })
      },
    })
    const load = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionLoad,
        params: { sessionId: 'sess_keep' },
      }),
    )
    expect(load).toEqual({ sessionId: 'sess_keep' })
    expect(loaded).toEqual(['sess_keep'])
    const prompt = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId: 'sess_keep', prompt: 'go' },
    })
    expect(resultOf(prompt)).toEqual({ stopReason: 'end_turn' })
  })
})
