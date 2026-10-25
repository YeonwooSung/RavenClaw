import { describe, expect, test } from 'bun:test'
import { DurableBusy } from '../errors.ts'
import { openMemoryStorage } from '../storage/memory.ts'
import type { DurableMessage, DurableModel, DurableStorage, DurableTool, JsonObject } from '../storage/types.ts'
import { openDurable, type DurableRuntime } from './open.ts'

function toolUseThenStop(): DurableModel {
  return {
    async complete(input) {
      if (input.messages.some((message) => message.role === 'tool')) {
        return { content: 'done', stopReason: 'stop' }
      }
      return {
        content: '',
        stopReason: 'toolUse',
        toolCalls: [{ id: 'c1', name: 'echo', arguments: { k: 'v' } }],
      }
    },
  }
}

function toolMessage(storage: DurableStorage, content: string): DurableMessage | undefined {
  return storage
    .readEntries(1)
    .map((entry) => entry.message)
    .find((message) => message.role === 'tool' && message.content === content)
}

describe('durable turns', () => {
  test('an unsafe tool is not executed again and the result is interrupted', async () => {
    const storage = openMemoryStorage()
    let execs = 0
    let rt!: DurableRuntime
    const execute: DurableTool['execute'] = async () => {
      execs += 1
      rt.abandon()
      return { content: 'nope' }
    }
    const options = {
      model: toolUseThenStop(),
      tools: [{ name: 'echo', execute }],
      modelId: 'm',
    }
    rt = await openDurable(storage, options)
    const submission = await (await rt.root()).submit({ content: 'go', requestId: 'u' })
    await rt.resume()
    expect(rt.closed).toBe(true)
    expect(execs).toBe(1)

    const second = await openDurable(storage, options)
    await second.resume()
    expect(execs).toBe(1)
    expect(toolMessage(storage, 'interrupted')?.role).toBe('tool')
    expect(await second.submission(submission.id).wait()).toEqual({ status: 'done', text: 'done' })
  })

  test('a safe tool runs again with the stored arguments', async () => {
    const storage = openMemoryStorage()
    let execs = 0
    const seen: JsonObject[] = []
    let crash = true
    let rt!: DurableRuntime
    const execute: DurableTool['execute'] = async (args) => {
      execs += 1
      seen.push(JSON.parse(JSON.stringify(args)) as JsonObject)
      if (crash) {
        crash = false
        rt.abandon()
        return { content: 'nope' }
      }
      return { content: 'ok' }
    }
    const options = {
      model: toolUseThenStop(),
      tools: [{ name: 'echo', replay: 'safe' as const, execute }],
      modelId: 'm',
    }
    rt = await openDurable(storage, options)
    await (await rt.root()).submit({ content: 'go', requestId: 's' })
    await rt.resume()
    rt = await openDurable(storage, options)
    await rt.resume()
    expect(execs).toBe(2)
    expect(seen[0]).toEqual(seen[1])
    expect(seen[0]).toEqual({ k: 'v' })
  })

  test('a committed tool result is not executed again', async () => {
    const storage = openMemoryStorage()
    let execs = 0
    const options = {
      model: toolUseThenStop(),
      tools: [
        {
          name: 'echo',
          execute: async () => {
            execs += 1
            return { content: 'ok' }
          },
        },
      ],
      modelId: 'm',
    }
    const rt = await openDurable(storage, options)
    expect(await (await (await rt.root()).submit({ content: 'go' })).wait()).toEqual({
      status: 'done',
      text: 'done',
    })
    expect(execs).toBe(1)
    await rt.close()
    const second = await openDurable(storage, options)
    await second.resume()
    expect(execs).toBe(1)
  })

  test('a model crash before the assistant entry resends the same messages', async () => {
    const inner = openMemoryStorage()
    let arm = false
    const storage: DurableStorage = {
      mintId: () => inner.mintId(),
      commit(batch) {
        if (arm) {
          arm = false
          throw new Error('disk dead')
        }
        inner.commit(batch)
      },
      readConversation: (id) => inner.readConversation(id),
      readEntries: (id) => inner.readEntries(id),
      readTask: (id) => inner.readTask(id),
      readTasks: () => inner.readTasks(),
      readSubmission: (id) => inner.readSubmission(id),
      readSubmissionByRequest: (conversationId, requestId) =>
        inner.readSubmissionByRequest(conversationId, requestId),
      readDocument: (key) => inner.readDocument(key),
      close: () => inner.close(),
    }
    const seen: DurableMessage[][] = []
    let calls = 0
    const model: DurableModel = {
      async complete(input) {
        calls += 1
        seen.push(input.messages.map((message) => JSON.parse(JSON.stringify(message)) as DurableMessage))
        if (calls === 1) arm = true
        return { content: 'Paris', stopReason: 'stop' }
      },
    }
    const rt = await openDurable(storage, { model, modelId: 'm', systemPrompt: 'be brief' })
    const submission = await (await rt.root()).submit({ content: 'capital?' })
    await rt.resume()
    expect(rt.closed).toBe(true)
    expect(calls).toBe(1)

    const second = await openDurable(storage, { model, modelId: 'm', systemPrompt: 'be brief' })
    await second.resume()
    expect(calls).toBe(2)
    expect(seen[1]).toEqual(seen[0])
    expect(seen[0]).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'capital?' },
    ])
    expect(await second.submission(submission.id).wait()).toEqual({ status: 'done', text: 'Paris' })
  })

  test('abandoning after toolUse does not call the model again before execute', async () => {
    const inner = openMemoryStorage()
    let once = true
    let rt!: DurableRuntime
    const storage: DurableStorage = {
      mintId: () => inner.mintId(),
      commit(batch) {
        inner.commit(batch)
        if (once && batch.tasks?.some((task) => task.name === 'tool' && task.checkpoint?.phase === 'call')) {
          once = false
          queueMicrotask(() => rt.abandon())
        }
      },
      readConversation: (id) => inner.readConversation(id),
      readEntries: (id) => inner.readEntries(id),
      readTask: (id) => inner.readTask(id),
      readTasks: () => inner.readTasks(),
      readSubmission: (id) => inner.readSubmission(id),
      readSubmissionByRequest: (conversationId, requestId) =>
        inner.readSubmissionByRequest(conversationId, requestId),
      readDocument: (key) => inner.readDocument(key),
      close: () => inner.close(),
    }
    let calls = 0
    let callsAtExecute = -1
    let execs = 0
    const model: DurableModel = {
      async complete(input) {
        calls += 1
        if (input.messages.some((message) => message.role === 'tool')) {
          return { content: 'done', stopReason: 'stop' }
        }
        return {
          content: '',
          stopReason: 'toolUse',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { k: 1 } }],
        }
      },
    }
    const tools: DurableTool[] = [
      {
        name: 'echo',
        async execute() {
          callsAtExecute = calls
          execs += 1
          return { content: 'ok' }
        },
      },
    ]
    rt = await openDurable(storage, { model, tools, modelId: 'm' })
    const submission = await (await rt.root()).submit({ content: 'go', requestId: 't' })
    await rt.resume()
    expect(execs).toBe(0)
    expect(rt.closed).toBe(true)

    const second = await openDurable(storage, { model, tools, modelId: 'm' })
    await second.resume()
    expect(execs).toBe(1)
    expect(callsAtExecute).toBe(1)
    expect(await second.submission(submission.id).wait()).toEqual({ status: 'done', text: 'done' })
  })

  test('the same requestId returns the same submission and one user entry', async () => {
    const storage = openMemoryStorage()
    const rt = await openDurable(storage, {
      model: { async complete() { return { content: 'ok', stopReason: 'stop' } } },
      modelId: 'm',
    })
    const conversation = await rt.root()
    const first = await conversation.submit({ content: 'hi', requestId: 'g' })
    await first.wait()
    const second = await conversation.submit({ content: 'other', requestId: 'g' })
    expect(second.id).toBe(first.id)
    expect(storage.readEntries(1).filter((entry) => entry.kind === 'user')).toHaveLength(1)
    expect(storage.readEntries(1).find((entry) => entry.kind === 'user')?.message).toEqual({
      role: 'user',
      content: 'hi',
    })
  })

  test('a second submit while a run is active throws DurableBusy', async () => {
    const storage = openMemoryStorage()
    const rt = await openDurable(storage, {
      model: {
        complete(input) {
          return new Promise((_resolve, reject) => {
            input.signal.addEventListener('abort', () => reject(new Error('aborted')))
          })
        },
      },
      modelId: 'm',
    })
    const conversation = await rt.root()
    const first = await conversation.submit({ content: 'a', requestId: 'same' })
    const same = await conversation.submit({ content: 'b', requestId: 'same' })
    expect(same.id).toBe(first.id)
    await expect(conversation.submit({ content: 'c' })).rejects.toBeInstanceOf(DurableBusy)
    expect(storage.readEntries(1).filter((entry) => entry.kind === 'user')).toHaveLength(1)
    rt.abandon()
  })

  test('the sixth observed cutoff parks a safe tool without executing it', async () => {
    const storage = openMemoryStorage()
    let execs = 0
    let rt!: DurableRuntime
    const options = {
      model: toolUseThenStop(),
      tools: [
        {
          name: 'echo',
          replay: 'safe' as const,
          execute: async () => {
            execs += 1
            rt.abandon()
            return { content: 'x' }
          },
        },
      ],
      modelId: 'm',
      restartLimit: 5,
    }
    rt = await openDurable(storage, options)
    const submission = await (await rt.root()).submit({ content: 'go', requestId: 'p' })
    await rt.resume()
    expect(execs).toBe(1)

    while (execs < 5) {
      rt = await openDurable(storage, options)
      expect(storage.readSubmission(submission.id)?.reason).toBeUndefined()
      await rt.resume()
    }
    expect(execs).toBe(5)
    rt = await openDurable(storage, options)
    expect(execs).toBe(5)
    expect(storage.readSubmission(submission.id)).toMatchObject({
      status: 'unanswered',
      reason: 'task_parked',
    })
    const tool = storage.readTasks().find((task) => task.name === 'tool')
    expect(tool?.parked).toBe(true)
    expect(tool?.restarts).toBe(5)
    await rt.retryTask(tool!.id)
    await rt.resume()
    expect(execs).toBe(6)
    expect(storage.readSubmission(submission.id)?.reason).toBe('task_parked')
  })

  test('a non-string tool result becomes incomplete: tool did not finish', async () => {
    const storage = openMemoryStorage()
    const seen: string[] = []
    const rt = await openDurable(storage, {
      model: {
        async complete(input) {
          const tool = input.messages.find((message) => message.role === 'tool')
          if (tool && tool.role === 'tool') {
            seen.push(tool.content)
            return { content: 'done', stopReason: 'stop' }
          }
          return {
            content: '',
            stopReason: 'toolUse',
            toolCalls: [{ id: 'c1', name: 'echo', arguments: { k: true } }],
          }
        },
      },
      tools: [
        {
          name: 'echo',
          async execute() {
            return { content: 1 as unknown as string }
          },
        },
      ],
      modelId: 'm',
    })
    expect(await (await (await rt.root()).submit({ content: 'go' })).wait()).toEqual({
      status: 'done',
      text: 'done',
    })
    expect(seen).toEqual(['incomplete: tool did not finish'])
  })

  test('close leaves a running tool pending without incrementing restarts', async () => {
    const storage = openMemoryStorage()
    let saw: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      saw = resolve
    })
    const rt = await openDurable(storage, {
      model: toolUseThenStop(),
      tools: [
        {
          name: 'echo',
          async execute(_args, ctx) {
            saw?.()
            await new Promise<void>((_resolve, reject) => {
              ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))
            })
            return { content: 'ok' }
          },
        },
      ],
      modelId: 'm',
    })
    await (await rt.root()).submit({ content: 'go' })
    await entered
    const running = storage.readTasks().find((task) => task.name === 'tool')
    expect(running?.status).toBe('running')
    expect(running?.restarts).toBe(0)
    await rt.close()
    const pending = storage.readTask(running!.id)
    expect(pending?.status).toBe('pending')
    expect(pending?.restarts).toBe(0)
    const second = await openDurable(storage, {
      model: toolUseThenStop(),
      tools: [{ name: 'echo', async execute() { return { content: 'ok' } } }],
      modelId: 'm',
    })
    const afterOpen = storage.readTask(running!.id)
    expect(afterOpen?.status).toBe('pending')
    expect(afterOpen?.restarts).toBe(0)
    await second.close()
  })

  test('a future sleepUntil parks the parent until the clock reaches it', async () => {
    const storage = openMemoryStorage()
    let now = 0
    let execs = 0
    let calls = 0
    const until = 50
    const rt = await openDurable(storage, {
      now: () => now,
      model: {
        async complete(input) {
          calls += 1
          if (input.messages.some((message) => message.role === 'tool')) {
            return { content: 'done', stopReason: 'stop' }
          }
          return {
            content: '',
            stopReason: 'toolUse',
            toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }],
          }
        },
      },
      tools: [
        {
          name: 'echo',
          async execute() {
            execs += 1
            return { content: 'ok', sleepUntil: until }
          },
        },
      ],
      modelId: 'm',
    })
    const submission = await (await rt.root()).submit({ content: 'go' })
    await rt.resume()
    expect(execs).toBe(1)
    expect(calls).toBe(1)
    const generation = storage.readTasks().find((task) => task.name === 'generation')
    expect(generation?.status).toBe('sleeping')
    expect(generation?.checkpoint).toEqual({ phase: 'sleep', until, resume: 'tools' })
    expect(storage.readTasks().filter((task) => task.name === 'generation')).toHaveLength(1)
    expect(storage.readSubmission(submission.id)?.status).toBe('queued')
    expect(toolMessage(storage, 'ok')?.role).toBe('tool')

    now = until
    await rt.resume()
    expect(calls).toBe(2)
    expect(execs).toBe(1)
    expect(await submission.wait()).toEqual({ status: 'done', text: 'done' })
  })

  test('a sleepUntil at or before now follows up without sleeping', async () => {
    const storage = openMemoryStorage()
    let now = 10
    let execs = 0
    let calls = 0
    const rt = await openDurable(storage, {
      now: () => now,
      model: {
        async complete(input) {
          calls += 1
          if (input.messages.some((message) => message.role === 'tool')) {
            return { content: 'done', stopReason: 'stop' }
          }
          return {
            content: '',
            stopReason: 'toolUse',
            toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }],
          }
        },
      },
      tools: [
        {
          name: 'echo',
          async execute() {
            execs += 1
            return { content: 'ok', sleepUntil: now }
          },
        },
      ],
      modelId: 'm',
    })
    expect(await (await (await rt.root()).submit({ content: 'go' })).wait()).toEqual({
      status: 'done',
      text: 'done',
    })
    expect(execs).toBe(1)
    expect(calls).toBe(2)
    expect(storage.readTasks().some((task) => task.status === 'sleeping')).toBe(false)
  })

  test('a NaN sleepUntil is ignored and follow-up runs immediately', async () => {
    const storage = openMemoryStorage()
    let now = 0
    let execs = 0
    let calls = 0
    const rt = await openDurable(storage, {
      now: () => now,
      model: {
        async complete(input) {
          calls += 1
          if (input.messages.some((message) => message.role === 'tool')) {
            return { content: 'done', stopReason: 'stop' }
          }
          return {
            content: '',
            stopReason: 'toolUse',
            toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }],
          }
        },
      },
      tools: [
        {
          name: 'echo',
          async execute() {
            execs += 1
            return { content: 'ok', sleepUntil: Number.NaN }
          },
        },
      ],
      modelId: 'm',
    })
    expect(await (await (await rt.root()).submit({ content: 'go' })).wait()).toEqual({
      status: 'done',
      text: 'done',
    })
    expect(execs).toBe(1)
    expect(calls).toBe(2)
    expect(storage.readTasks().some((task) => task.status === 'sleeping')).toBe(false)
  })
})
