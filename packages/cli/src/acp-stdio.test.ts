import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import type { UserSubmitInput } from '@ravenclaw/core'
import { PROTOCOL_VERSION, type AcpEngine, type AcpEngineFactoryOpts } from '@ravenclaw/acp'
import { applyAcpSessionNew, overlayMcpServers, parseAcpMcpServers, runAcpStdio } from './acp-stdio'
import type { CliRuntimeBase } from './engine'

function fakeEngine(opts: {
  events?: unknown[]
  end?: unknown
  onSubmit?: (input: UserSubmitInput) => void
}): AcpEngine {
  return {
    async *submitMessage(input: UserSubmitInput) {
      opts.onSubmit?.(input)
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

  test('session/new uses boot.create with the advertised session id', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const { waitFor } = jsonLines(output)
    const created: string[] = []

    const running = runAcpStdio({
      input,
      output,
      boot: async () => ({
        create: async (sessionId) => {
          created.push(sessionId)
          return fakeEngine({})
        },
      }),
    })

    writeJson(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd: '/tmp' },
    })
    const afterNew = await waitFor(1)
    input.end()
    await running

    const sessionId = (afterNew[0] as { result?: { sessionId?: string } }).result?.sessionId
    expect(created).toEqual([sessionId])
  })

  test('session/new forwards cwd, model, and mcpServers to boot.create', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const { waitFor } = jsonLines(output)
    const received: AcpEngineFactoryOpts[] = []
    const mcpServers = [
      {
        type: 'stdio',
        name: 'workspace-tools',
        command: '/bin/mcp',
        args: ['--stdio'],
        env: [{ name: 'TOKEN', value: 'x' }],
      },
    ]

    const running = runAcpStdio({
      input,
      output,
      boot: async () => ({
        create: async (_sessionId, opts) => {
          if (opts) received.push(opts)
          return fakeEngine({})
        },
      }),
    })

    writeJson(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd: '/tmp/project', model: 'ollama/qwen', mcpServers },
    })
    await waitFor(1)
    input.end()
    await running

    expect(received).toHaveLength(1)
    expect(received[0]?.cwd).toBe('/tmp/project')
    expect(received[0]?.model).toBe('ollama/qwen')
    expect(received[0]?.mcpServers).toEqual(mcpServers)
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

  test('permission_ask writes session/request_permission and waits for the editor', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const { messages, waitFor } = jsonLines(output)
    let decided: string | undefined

    const running = runAcpStdio({
      input,
      output,
      boot: async () => ({
        create: async (_sessionId, opts) => ({
          async *submitMessage() {
            decided = await opts?.requestPermission?.({
              id: 'c1',
              tool: 'Bash',
              input: { command: 'ls' },
              message: 'run ls',
            })
            return { reason: 'completed' }
          },
          abort() {},
        }),
      }),
    })

    writeJson(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd: '/tmp' },
    })
    const afterNew = await waitFor(1)
    const sessionId = (afterNew[0] as { result?: { sessionId?: string } }).result?.sessionId

    writeJson(input, {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: 'ls' },
    })
    const afterAsk = await waitFor(2)
    const perm = afterAsk.find(
      (msg) =>
        typeof msg === 'object' &&
        msg !== null &&
        (msg as { method?: string }).method === 'session/request_permission',
    ) as { id?: string | number } | undefined
    expect(perm?.id).toBeDefined()

    writeJson(input, {
      jsonrpc: '2.0',
      id: perm?.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    })
    await waitFor(4)
    input.end()
    await running

    expect(decided).toBe('allow')
    expect(JSON.stringify(messages)).toContain('end_turn')
  })

  test('applyAcpSessionNew overlays cwd, model, and ACP MCP servers', () => {
    const runtime = {
      cwd: '/old',
      config: {
        model: 'old-model',
        mcp: {
          servers: [{ name: 'keep', command: '/bin/keep' }],
        },
      },
    } as unknown as CliRuntimeBase
    const next = applyAcpSessionNew(runtime, {
      cwd: '/tmp/project',
      model: 'new-model',
      mcpServers: [
        {
          type: 'stdio',
          name: 'workspace-tools',
          command: '/bin/mcp',
          args: ['--stdio'],
          env: [{ name: 'K', value: 'v' }],
        },
        { type: 'http', name: 'keep', url: 'https://mcp.example' },
      ],
    })
    expect(next.cwd).toBe('/tmp/project')
    expect(next.config.model).toBe('new-model')
    expect(next.config.mcp.servers).toEqual([
      { name: 'keep', type: 'http', url: 'https://mcp.example' },
      {
        name: 'workspace-tools',
        command: '/bin/mcp',
        args: ['--stdio'],
        env: { K: 'v' },
      },
    ])
    expect(parseAcpMcpServers(undefined)).toEqual([])
    expect(overlayMcpServers([{ name: 'a', command: 'a' }], [])).toEqual([
      { name: 'a', command: 'a' },
    ])
  })
})
