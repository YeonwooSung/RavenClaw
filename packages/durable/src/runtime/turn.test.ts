import { describe, expect, test } from 'bun:test'
import { DurableBusy } from '../errors.ts'
import { openMemoryStorage } from '../storage/memory.ts'
import type {
  DurableMessage,
  DurableModel,
  DurableStorage,
  DurableTaskRow,
  DurableTool,
  JsonObject,
} from '../storage/types.ts'
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

function lastUserContent(messages: readonly DurableMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') return message.content
  }
  return undefined
}

function toolUntilSteer(steerText: string): DurableModel {
  return {
    async complete(input) {
      const sawSteer = input.messages.some(
        (message) => message.role === 'user' && message.content === steerText,
      )
      if (!sawSteer) {
        return {
          content: '',
          stopReason: 'toolUse',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }],
        }
      }
      const last = lastUserContent(input.messages)
      if (last !== steerText) return { content: 'after-follow', stopReason: 'stop' }
      return { content: 'after-steer', stopReason: 'stop' }
    },
  }
}

function toolMessage(storage: DurableStorage, content: string): DurableMessage | undefined {
  return storage
    .readEntries(1)
    .map((entry) => entry.message)
    .find((message) => message.role === 'tool' && message.content === content)
}

function holdModel(): { model: DurableModel; entered: Promise<void>; release(): void } {
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  let mark!: () => void
  const entered = new Promise<void>((resolve) => {
    mark = resolve
  })
  return {
    model: {
      async complete(input) {
        mark()
        await gate
        if (input.signal.aborted) throw new Error('aborted')
        return { content: 'one', stopReason: 'stop' }
      },
    },
    entered,
    release() {
      open()
    },
  }
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

  test('an omitted or reject whenBusy while a run is active throws DurableBusy and writes nothing', async () => {
    const storage = openMemoryStorage()
    const held = holdModel()
    const rt = await openDurable(storage, { model: held.model, modelId: 'm' })
    const conversation = await rt.root()
    const first = await conversation.submit({ content: 'a' })
    await held.entered
    const entries = storage.readEntries(conversation.id)
    const tasks = storage.readTasks()
    const live = storage.readDocument('live')
    await expect(conversation.submit({ content: 'c' })).rejects.toBeInstanceOf(DurableBusy)
    await expect(conversation.submit({ content: 'd', whenBusy: 'reject' })).rejects.toBeInstanceOf(DurableBusy)
    expect(storage.readEntries(conversation.id)).toEqual(entries)
    expect(storage.readTasks()).toEqual(tasks)
    expect(storage.readDocument('live')).toEqual(live)
    expect(storage.readDocument(`inbox:${conversation.id}`)).toBeUndefined()
    held.release()
    expect(await first.wait()).toEqual({ status: 'done', text: 'one' })
  })

  test('a followUp while a run is active queues one inbox item and does not start it', async () => {
    const storage = openMemoryStorage()
    const held = holdModel()
    const rt = await openDurable(storage, { model: held.model, modelId: 'm' })
    const conversation = await rt.root()
    const first = await conversation.submit({ content: 'first' })
    await held.entered
    const live = storage.readDocument('live')
    const second = await conversation.submit({ content: 'second', whenBusy: 'followUp' })
    expect(second.id).not.toBe(first.id)
    expect(storage.readSubmission(second.id)).toEqual({
      id: second.id,
      conversationId: conversation.id,
      status: 'queued',
    })
    expect(storage.readDocument(`inbox:${conversation.id}`)).toEqual({
      items: [{ id: second.id, mode: 'followUp', content: 'second' }],
    })
    const steered = await conversation.submit({ content: 'nudge', whenBusy: 'steer' })
    expect(storage.readSubmission(steered.id)).toEqual({
      id: steered.id,
      conversationId: conversation.id,
      status: 'queued',
    })
    expect(storage.readDocument(`inbox:${conversation.id}`)).toEqual({
      items: [
        { id: second.id, mode: 'followUp', content: 'second' },
        { id: steered.id, mode: 'steer', content: 'nudge' },
      ],
    })
    expect(storage.readDocument('live')).toEqual(live)
    expect(storage.readEntries(conversation.id).filter((entry) => entry.kind === 'user')).toHaveLength(1)
    expect(storage.readTasks().filter((task) => task.name === 'generation')).toHaveLength(1)
    held.release()
    expect(await first.wait()).toEqual({ status: 'done', text: 'one' })
  })

  test('the same followUp requestId returns the queued submission and one inbox item', async () => {
    const storage = openMemoryStorage()
    const held = holdModel()
    const rt = await openDurable(storage, { model: held.model, modelId: 'm' })
    const conversation = await rt.root()
    const first = await conversation.submit({ content: 'first', requestId: 'live' })
    await held.entered
    const sameLive = await conversation.submit({ content: 'nope', requestId: 'live', whenBusy: 'followUp' })
    expect(sameLive.id).toBe(first.id)
    expect(storage.readDocument(`inbox:${conversation.id}`)).toBeUndefined()
    const queued = await conversation.submit({ content: 'later', requestId: 'r', whenBusy: 'followUp' })
    const again = await conversation.submit({ content: 'other', requestId: 'r', whenBusy: 'followUp' })
    expect(again.id).toBe(queued.id)
    expect(storage.readSubmission(queued.id)).toEqual({
      id: queued.id,
      conversationId: conversation.id,
      requestId: 'r',
      status: 'queued',
    })
    expect(storage.readDocument(`inbox:${conversation.id}`)).toEqual({
      items: [{ id: queued.id, mode: 'followUp', content: 'later', requestId: 'r' }],
    })
    expect(storage.readEntries(conversation.id).filter((entry) => entry.kind === 'user')).toHaveLength(1)
    expect(storage.readTasks().filter((task) => task.name === 'generation')).toHaveLength(1)
    held.release()
    expect(await first.wait()).toEqual({ status: 'done', text: 'one' })
  })

  test('an idle followUp or steer submits immediately and leaves no inbox item', async () => {
    const storage = openMemoryStorage()
    const rt = await openDurable(storage, {
      model: {
        async complete() {
          return { content: 'ok', stopReason: 'stop' }
        },
      },
      modelId: 'm',
    })
    const conversation = await rt.root()
    const follow = await conversation.submit({ content: 'a', whenBusy: 'followUp' })
    expect(await follow.wait()).toEqual({ status: 'done', text: 'ok' })
    expect(storage.readDocument(`inbox:${conversation.id}`)).toBeUndefined()
    const steer = await conversation.submit({ content: 'b', whenBusy: 'steer' })
    expect(await steer.wait()).toEqual({ status: 'done', text: 'ok' })
    expect(storage.readDocument(`inbox:${conversation.id}`)).toBeUndefined()
    expect(storage.readEntries(conversation.id).filter((entry) => entry.kind === 'user')).toHaveLength(2)
  })

  test('two queued followUps run in order after the blocked answer', async () => {
    const storage = openMemoryStorage()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let mark!: () => void
    const entered = new Promise<void>((resolve) => {
      mark = resolve
    })
    let blocked = true
    const model: DurableModel = {
      async complete(input) {
        const lastUser = [...input.messages].reverse().find((message) => message.role === 'user')
        const text = lastUser?.role === 'user' ? lastUser.content : ''
        if (blocked) {
          blocked = false
          mark()
          await gate
          if (input.signal.aborted) throw new Error('aborted')
        }
        return { content: 'answer:' + text, stopReason: 'stop' }
      },
    }
    const rt = await openDurable(storage, { model, modelId: 'm' })
    const conversation = await rt.root()
    const first = await conversation.submit({ content: 'first' })
    await entered
    const second = await conversation.submit({ content: 'second', whenBusy: 'followUp' })
    const third = await conversation.submit({ content: 'third', whenBusy: 'followUp' })
    const order: number[] = []
    const secondDone = second.wait().then((result) => {
      order.push(second.id)
      return result
    })
    const thirdDone = third.wait().then((result) => {
      order.push(third.id)
      return result
    })
    release()
    const firstResult = await first.wait()
    expect(firstResult).toEqual({ status: 'done', text: 'answer:first' })
    expect(firstResult.text).not.toBe('answer:second')
    const secondResult = await secondDone
    const thirdResult = await thirdDone
    expect(order).toEqual([second.id, third.id])
    expect(secondResult).toEqual({ status: 'done', text: 'answer:second' })
    expect(thirdResult).toEqual({ status: 'done', text: 'answer:third' })
    expect(secondResult.text).not.toBe(thirdResult.text)
    expect(storage.readDocument(`inbox:${conversation.id}`)).toEqual({ items: [] })
  })

  test('a model error leaves the queued followUp in inbox:1', async () => {
    const storage = openMemoryStorage()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let mark!: () => void
    const entered = new Promise<void>((resolve) => {
      mark = resolve
    })
    const model: DurableModel = {
      async complete(input) {
        mark()
        await gate
        if (input.signal.aborted) throw new Error('aborted')
        return { content: 'boom', stopReason: 'error' }
      },
    }
    const rt = await openDurable(storage, { model, modelId: 'm' })
    const conversation = await rt.root()
    expect(conversation.id).toBe(1)
    const first = await conversation.submit({ content: 'q' })
    await entered
    const queued = await conversation.submit({ content: 'later', whenBusy: 'followUp' })
    release()
    expect(await first.wait()).toEqual({ status: 'unanswered', reason: 'model_error' })
    expect(storage.readSubmission(queued.id)).toEqual({
      id: queued.id,
      conversationId: conversation.id,
      status: 'queued',
    })
    expect(storage.readDocument('inbox:1')).toEqual({
      items: [{ id: queued.id, mode: 'followUp', content: 'later' }],
    })
  })

  test('submit without whenBusy throws DurableBusy while the inbox is non-empty', async () => {
    const storage = openMemoryStorage()
    const held = holdModel()
    const rt = await openDurable(storage, { model: held.model, modelId: 'm' })
    const conversation = await rt.root()
    const first = await conversation.submit({ content: 'a' })
    await held.entered
    await conversation.submit({ content: 'old', whenBusy: 'followUp' })
    const inbox = storage.readDocument(`inbox:${conversation.id}`)
    const count =
      inbox && typeof inbox === 'object' && !Array.isArray(inbox) && Array.isArray(inbox.items)
        ? inbox.items.length
        : 0
    expect(count).toBeGreaterThan(0)
    await expect(conversation.submit({ content: 'c' })).rejects.toBeInstanceOf(DurableBusy)
    expect(storage.readDocument(`inbox:${conversation.id}`)).toEqual(inbox)
    held.release()
    expect(await first.wait()).toEqual({ status: 'done', text: 'one' })
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

  test('abandon after a committed sleep keeps the task sleeping across open', async () => {
    const storage = openMemoryStorage()
    let now = 0
    let execs = 0
    let calls = 0
    const until = 50
    const options = {
      now: () => now,
      model: {
        async complete(input: { messages: readonly DurableMessage[] }) {
          calls += 1
          if (input.messages.some((message) => message.role === 'tool')) {
            return { content: 'done', stopReason: 'stop' as const }
          }
          return {
            content: '',
            stopReason: 'toolUse' as const,
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
    }
    const rt = await openDurable(storage, options)
    const submission = await (await rt.root()).submit({ content: 'go' })
    await rt.resume()
    const generation = storage.readTasks().find((task) => task.name === 'generation')
    expect(generation?.status).toBe('sleeping')
    expect(generation?.restarts).toBe(0)
    expect(calls).toBe(1)
    expect(execs).toBe(1)
    rt.abandon()

    const second = await openDurable(storage, options)
    const reopened = storage.readTask(generation!.id)
    expect(reopened?.status).toBe('sleeping')
    expect(reopened?.checkpoint).toEqual({ phase: 'sleep', until, resume: 'tools' })
    expect(reopened?.restarts).toBe(0)
    expect(storage.readTasks().filter((task) => task.name === 'generation')).toHaveLength(1)
    expect(execs).toBe(1)
    expect(calls).toBe(1)

    now = until
    await second.resume()
    expect(calls).toBe(2)
    expect(execs).toBe(1)
    expect(await second.submission(submission.id).wait()).toEqual({ status: 'done', text: 'done' })
  })

  test('wake reports the next sleep deadline and active work', async () => {
    const storage = openMemoryStorage()
    let now = 0
    const until = 50
    const rt = await openDurable(storage, {
      now: () => now,
      model: {
        async complete(input) {
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
            return { content: 'ok', sleepUntil: until }
          },
        },
      ],
      modelId: 'm',
    })
    await (await rt.root()).submit({ content: 'go' })
    await rt.resume()
    expect(rt.wake()).toEqual({ active: false, at: until })
    const parked = JSON.stringify(storage.readTasks())
    now = until
    const due = rt.wake()
    expect(due.active).toBe(true)
    expect(Object.hasOwn(due, 'at')).toBe(false)
    expect(JSON.stringify(storage.readTasks())).toBe(parked)
    expect(storage.readTasks().find((task) => task.name === 'generation')?.status).toBe('sleeping')

    const idle = openMemoryStorage()
    let clock = 100
    const view = await openDurable(idle, { now: () => clock, model: toolUseThenStop(), modelId: 'm' })
    const row = (
      id: number,
      status: DurableTaskRow['status'],
      extra: Partial<DurableTaskRow> = {},
    ): DurableTaskRow => ({
      id,
      name: extra.name ?? 'generation',
      conversationId: 1,
      status,
      restarts: extra.restarts ?? 0,
      parked: extra.parked ?? false,
      ...(extra.parentTaskId !== undefined ? { parentTaskId: extra.parentTaskId } : {}),
      ...(extra.checkpoint !== undefined ? { checkpoint: extra.checkpoint } : {}),
      ...(extra.outcome !== undefined ? { outcome: extra.outcome } : {}),
    })
    const asleep = (id: number, at: number) =>
      row(id, 'sleeping', { checkpoint: { phase: 'sleep', until: at, resume: 'tools' } })
    idle.commit({ tasks: [asleep(idle.mintId(), 150), asleep(idle.mintId(), 180)] })
    expect(view.wake()).toEqual({ active: false, at: 150 })
    idle.commit({ tasks: [asleep(idle.mintId(), 120)] })
    expect(view.wake()).toEqual({ active: false, at: 120 })

    const parkedPending = idle.mintId()
    idle.commit({
      tasks: [row(parkedPending, 'pending', { name: 'tool', restarts: 5, parked: true })],
    })
    expect(view.wake()).toEqual({ active: false, at: 120 })

    const pending = idle.mintId()
    idle.commit({ tasks: [row(pending, 'pending', { name: 'tool' })] })
    expect(view.wake()).toEqual({ active: true, at: 120 })
    idle.commit({
      tasks: [row(pending, 'terminal', { name: 'tool', outcome: 'completed' })],
    })
    expect(view.wake()).toEqual({ active: false, at: 120 })

    const running = idle.mintId()
    idle.commit({ tasks: [row(running, 'running', { name: 'tool' })] })
    expect(view.wake()).toEqual({ active: true, at: 120 })
    idle.commit({ tasks: [row(running, 'running', { name: 'tool', restarts: 1, parked: true })] })
    expect(view.wake()).toEqual({ active: false, at: 120 })

    const parent = idle.mintId()
    const child = idle.mintId()
    idle.commit({
      tasks: [
        row(parent, 'waiting', { checkpoint: { phase: 'tools' } }),
        row(child, 'sleeping', {
          name: 'tool',
          parentTaskId: parent,
          checkpoint: { phase: 'sleep', until: 130, resume: 'tools' },
        }),
      ],
    })
    expect(view.wake()).toEqual({ active: false, at: 120 })
    idle.commit({
      tasks: [row(child, 'terminal', { name: 'tool', parentTaskId: parent, outcome: 'completed' })],
    })
    expect(view.wake()).toEqual({ active: true, at: 120 })
    idle.commit({
      tasks: [row(parent, 'waiting', { checkpoint: { phase: 'tools' }, parked: true })],
    })
    expect(view.wake()).toEqual({ active: false, at: 120 })

    const beforeDue = idle.readTasks()
    clock = 120
    expect(view.wake()).toEqual({ active: true, at: 150 })
    expect(idle.readTasks()).toEqual(beforeDue)
    clock = 1000
    expect(view.wake()).toEqual({ active: true })
    expect(idle.readTasks()).toEqual(beforeDue)
  })

  test('a steer during a tool is the next user message and shares the follow-up answer', async () => {
    const storage = openMemoryStorage()
    const seen: DurableMessage[][] = []
    let steerId = 0
    let conversation!: Awaited<ReturnType<DurableRuntime['root']>>
    const inner = toolUntilSteer('steer-text')
    const rt = await openDurable(storage, {
      model: {
        async complete(input) {
          seen.push(input.messages.map((message) => JSON.parse(JSON.stringify(message)) as DurableMessage))
          return inner.complete(input)
        },
      },
      tools: [
        {
          name: 'echo',
          async execute() {
            steerId = (await conversation.submit({ content: 'steer-text', whenBusy: 'steer' })).id
            return { content: 'ok' }
          },
        },
      ],
      modelId: 'm',
    })
    conversation = await rt.root()
    const original = await conversation.submit({ content: 'go' })
    const originalResult = await original.wait()
    const steerResult = await rt.submission(steerId).wait()
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(lastUserContent(seen[0] ?? [])).toBe('go')
    expect(lastUserContent(seen[1] ?? [])).toBe('steer-text')
    expect(originalResult).toEqual({ status: 'done', text: 'after-steer' })
    expect(steerResult).toEqual(originalResult)
  })

  test('a second steer becomes the next run after the model stops', async () => {
    const storage = openMemoryStorage()
    const seen: DurableMessage[][] = []
    let inboxAtFollow: unknown
    let firstId = 0
    let secondId = 0
    let conversation!: Awaited<ReturnType<DurableRuntime['root']>>
    const inner = toolUntilSteer('steer-a')
    const rt = await openDurable(storage, {
      model: {
        async complete(input) {
          seen.push(input.messages.map((message) => JSON.parse(JSON.stringify(message)) as DurableMessage))
          if (lastUserContent(input.messages) === 'steer-a' && inboxAtFollow === undefined) {
            inboxAtFollow = storage.readDocument('inbox:1')
          }
          return inner.complete(input)
        },
      },
      tools: [
        {
          name: 'echo',
          async execute() {
            firstId = (await conversation.submit({ content: 'steer-a', whenBusy: 'steer' })).id
            secondId = (await conversation.submit({ content: 'steer-b', whenBusy: 'steer' })).id
            return { content: 'ok' }
          },
        },
      ],
      modelId: 'm',
    })
    conversation = await rt.root()
    const original = await conversation.submit({ content: 'go' })
    expect(await original.wait()).toEqual({ status: 'done', text: 'after-steer' })
    expect(await rt.submission(firstId).wait()).toEqual({ status: 'done', text: 'after-steer' })
    const follow = seen.find((messages) => lastUserContent(messages) === 'steer-a')
    expect(follow?.some((message) => message.role === 'user' && message.content === 'steer-a')).toBe(true)
    expect(follow?.some((message) => message.role === 'user' && message.content === 'steer-b')).toBe(false)
    expect(inboxAtFollow).toEqual({
      items: [{ id: secondId, mode: 'steer', content: 'steer-b' }],
    })
    expect(await rt.submission(secondId).wait()).toEqual({ status: 'done', text: 'after-follow' })
    const next = seen.find((messages) => lastUserContent(messages) === 'steer-b')
    expect(next?.some((message) => message.role === 'user' && message.content === 'steer-b')).toBe(true)
    expect(storage.readSubmission(firstId)?.answer).toBe('after-steer')
    expect(storage.readSubmission(secondId)?.answer).toBe('after-follow')
  })

  test('a queued followUp stays in the inbox while a steer is placed on the tool follow-up', async () => {
    const storage = openMemoryStorage()
    const seen: DurableMessage[][] = []
    let inboxAtSteer: unknown
    let followId = 0
    let steerId = 0
    let conversation!: Awaited<ReturnType<DurableRuntime['root']>>
    const inner = toolUntilSteer('steer-text')
    const rt = await openDurable(storage, {
      model: {
        async complete(input) {
          seen.push(input.messages.map((message) => JSON.parse(JSON.stringify(message)) as DurableMessage))
          if (lastUserContent(input.messages) === 'steer-text' && inboxAtSteer === undefined) {
            inboxAtSteer = storage.readDocument('inbox:1')
          }
          return inner.complete(input)
        },
      },
      tools: [
        {
          name: 'echo',
          async execute() {
            followId = (await conversation.submit({ content: 'later-text', whenBusy: 'followUp' })).id
            steerId = (await conversation.submit({ content: 'steer-text', whenBusy: 'steer' })).id
            return { content: 'ok' }
          },
        },
      ],
      modelId: 'm',
    })
    conversation = await rt.root()
    const original = await conversation.submit({ content: 'go' })
    const originalResult = await original.wait()
    const steerResult = await rt.submission(steerId).wait()
    const followResult = await rt.submission(followId).wait()
    const steered = seen.find((messages) => lastUserContent(messages) === 'steer-text')
    expect(steered?.some((message) => message.role === 'user' && message.content === 'steer-text')).toBe(true)
    expect(steered?.some((message) => message.role === 'user' && message.content === 'later-text')).toBe(false)
    expect(inboxAtSteer).toEqual({
      items: [{ id: followId, mode: 'followUp', content: 'later-text' }],
    })
    expect(originalResult).toEqual({ status: 'done', text: 'after-steer' })
    expect(steerResult).toEqual(originalResult)
    expect(followResult).toEqual({ status: 'done', text: 'after-follow' })
    expect(followResult.text).not.toBe(steerResult.text)
    expect(storage.readSubmission(steerId)?.answer).toBe('after-steer')
  })

  test('a tool-less stop starts the next run from a queued steer', async () => {
    const storage = openMemoryStorage()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let mark!: () => void
    const entered = new Promise<void>((resolve) => {
      mark = resolve
    })
    const seen: string[] = []
    const model: DurableModel = {
      async complete(input) {
        const last = lastUserContent(input.messages) ?? ''
        seen.push(last)
        if (seen.length === 1) {
          mark()
          await gate
          if (input.signal.aborted) throw new Error('aborted')
          return { content: 'first-answer', stopReason: 'stop' }
        }
        return { content: 'second-answer', stopReason: 'stop' }
      },
    }
    const rt = await openDurable(storage, { model, modelId: 'm' })
    const conversation = await rt.root()
    const original = await conversation.submit({ content: 'ask' })
    await entered
    const steer = await conversation.submit({ content: 'later', whenBusy: 'steer' })
    release()
    expect(await original.wait()).toEqual({ status: 'done', text: 'first-answer' })
    expect(await steer.wait()).toEqual({ status: 'done', text: 'second-answer' })
    expect(seen[1]).toBe('later')
  })

  test('a tool-less stop places the steer and leaves the followUp queued', async () => {
    const storage = openMemoryStorage()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let mark!: () => void
    const entered = new Promise<void>((resolve) => {
      mark = resolve
    })
    const seen: DurableMessage[][] = []
    let inboxAtSteer: unknown
    let calls = 0
    const model: DurableModel = {
      async complete(input) {
        calls += 1
        seen.push(input.messages.map((message) => JSON.parse(JSON.stringify(message)) as DurableMessage))
        if (calls === 1) {
          mark()
          await gate
          if (input.signal.aborted) throw new Error('aborted')
          return { content: 'first-answer', stopReason: 'stop' }
        }
        if (calls === 2) {
          inboxAtSteer = storage.readDocument('inbox:1')
          return { content: 'steer-answer', stopReason: 'stop' }
        }
        return { content: 'follow-answer', stopReason: 'stop' }
      },
    }
    const rt = await openDurable(storage, { model, modelId: 'm' })
    const conversation = await rt.root()
    const original = await conversation.submit({ content: 'ask' })
    await entered
    const steer = await conversation.submit({ content: 's', whenBusy: 'steer' })
    const follow = await conversation.submit({ content: 'f', whenBusy: 'followUp' })
    release()
    expect(await original.wait()).toEqual({ status: 'done', text: 'first-answer' })
    const steerResult = await steer.wait()
    const steered = seen[1] ?? []
    expect(steered.some((message) => message.role === 'user' && message.content === 's')).toBe(true)
    expect(steered.some((message) => message.role === 'user' && message.content === 'f')).toBe(false)
    expect(lastUserContent(steered)).toBe('s')
    expect(inboxAtSteer).toEqual({
      items: [{ id: follow.id, mode: 'followUp', content: 'f' }],
    })
    const followResult = await follow.wait()
    expect(steerResult).toEqual({ status: 'done', text: 'steer-answer' })
    expect(followResult).toEqual({ status: 'done', text: 'follow-answer' })
    expect(steerResult.text).not.toBe(followResult.text)
  })

  test('a model error leaves the queued steer in inbox:1', async () => {
    const storage = openMemoryStorage()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let mark!: () => void
    const entered = new Promise<void>((resolve) => {
      mark = resolve
    })
    const model: DurableModel = {
      async complete(input) {
        mark()
        await gate
        if (input.signal.aborted) throw new Error('aborted')
        return { content: 'nope', stopReason: 'error' }
      },
    }
    const rt = await openDurable(storage, { model, modelId: 'm' })
    const conversation = await rt.root()
    expect(conversation.id).toBe(1)
    const first = await conversation.submit({ content: 'q' })
    await entered
    const queued = await conversation.submit({ content: 'later', whenBusy: 'steer' })
    release()
    expect(await first.wait()).toEqual({ status: 'unanswered', reason: 'model_error' })
    expect(storage.readSubmission(queued.id)).toEqual({
      id: queued.id,
      conversationId: conversation.id,
      status: 'queued',
    })
    expect(storage.readDocument('inbox:1')).toEqual({
      items: [{ id: queued.id, mode: 'steer', content: 'later' }],
    })
  })

  test('a stream partial is visible after onPartial and cleared when the turn settles', async () => {
    const storage = openMemoryStorage()
    let rt!: DurableRuntime
    const model: DurableModel = {
      async complete() {
        throw new Error('complete should not run')
      },
      async stream(input) {
        await input.onPartial('Hel')
        expect(rt.partial(1)).toBe('Hel')
        await input.onPartial('Hello')
        expect(rt.partial(1)).toBe('Hello')
        const live = storage.readDocument('live')
        expect(live && typeof live === 'object' && !Array.isArray(live) ? live.run : undefined).toEqual(
          expect.objectContaining({
            submissionId: expect.any(Number),
            generationTaskId: expect.any(Number),
          }),
        )
        return { content: 'Hello', stopReason: 'stop' }
      },
    }
    rt = await openDurable(storage, { model, modelId: 'm' })
    const submission = await (await rt.root()).submit({ content: 'hi' })
    expect(await submission.wait()).toEqual({ status: 'done', text: 'Hello' })
    expect(rt.partial(1)).toBeUndefined()
  })

  test('a stream partial is absent when tools start', async () => {
    const storage = openMemoryStorage()
    const model: DurableModel = {
      async complete() {
        throw new Error('complete should not run')
      },
      async stream(input) {
        if (input.messages.some((message) => message.role === 'tool')) {
          return { content: 'done', stopReason: 'stop' }
        }
        await input.onPartial('toolish')
        return {
          content: '',
          stopReason: 'toolUse',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }],
        }
      },
    }
    const rt = await openDurable(storage, {
      model,
      tools: [
        {
          name: 'echo',
          async execute() {
            const live = storage.readDocument('live')
            expect(
              live && typeof live === 'object' && !Array.isArray(live) && Object.hasOwn(live, 'partial'),
            ).toBe(false)
            return { content: 'ok' }
          },
        },
      ],
      modelId: 'm',
    })
    expect(await (await (await rt.root()).submit({ content: 'go' })).wait()).toEqual({
      status: 'done',
      text: 'done',
    })
  })

  test('a complete-only model leaves partial undefined', async () => {
    const storage = openMemoryStorage()
    const rt = await openDurable(storage, {
      model: {
        async complete() {
          return { content: 'ok', stopReason: 'stop' }
        },
      },
      modelId: 'm',
    })
    expect(await (await (await rt.root()).submit({ content: 'hi' })).wait()).toEqual({
      status: 'done',
      text: 'ok',
    })
    expect(rt.partial(1)).toBeUndefined()
  })

  test('partial throws for an unknown conversation', async () => {
    const storage = openMemoryStorage()
    const rt = await openDurable(storage, {
      model: {
        async complete() {
          return { content: 'ok', stopReason: 'stop' }
        },
      },
      modelId: 'm',
    })
    await rt.root()
    expect(() => rt.partial(99)).toThrow(/unknown conversation 99/)
  })

  test('a stream error leaves the submission unanswered and clears the partial', async () => {
    const storage = openMemoryStorage()
    let rt!: DurableRuntime
    const model: DurableModel = {
      async complete() {
        throw new Error('complete should not run')
      },
      async stream(input) {
        await input.onPartial('HALF')
        expect(rt.partial(1)).toBe('HALF')
        throw new Error('boom')
      },
    }
    rt = await openDurable(storage, { model, modelId: 'm' })
    const submission = await (await rt.root()).submit({ content: 'hi' })
    expect(await submission.wait()).toEqual({ status: 'unanswered', reason: 'model_error' })
    expect(rt.partial(1)).toBeUndefined()
  })

  test('abandon during a stream keeps the partial and resends the same messages', async () => {
    const storage = openMemoryStorage()
    const seen: DurableMessage[][] = []
    let calls = 0
    let rt!: DurableRuntime
    const model: DurableModel = {
      async complete() {
        throw new Error('complete should not run')
      },
      async stream(input) {
        calls += 1
        seen.push(input.messages.map((message) => JSON.parse(JSON.stringify(message)) as DurableMessage))
        if (calls === 1) {
          await input.onPartial('HALF')
          rt.abandon()
          throw new Error('abandoned')
        }
        expect(
          storage.readEntries(1).some((entry) => entry.message.role === 'assistant' && entry.message.content === 'HALF'),
        ).toBe(false)
        return { content: 'done', stopReason: 'stop' }
      },
    }
    rt = await openDurable(storage, { model, modelId: 'm' })
    const submission = await (await rt.root()).submit({ content: 'capital?' })
    await rt.resume()
    expect(rt.closed).toBe(true)
    expect(calls).toBe(1)
    expect(storage.readTasks().find((task) => task.name === 'generation')?.status).toBe('running')
    expect(
      storage.readEntries(1).some((entry) => entry.message.role === 'assistant' && entry.message.content === 'HALF'),
    ).toBe(false)

    const second = await openDurable(storage, { model, modelId: 'm' })
    expect(storage.readTasks().find((task) => task.name === 'generation')?.status).toBe('pending')
    expect(second.partial(1)).toBe('HALF')
    expect(
      storage.readEntries(1).some((entry) => entry.message.role === 'assistant' && entry.message.content === 'HALF'),
    ).toBe(false)
    await second.resume()
    expect(calls).toBe(2)
    expect(seen[1]).toEqual([{ role: 'user', content: 'capital?' }])
    expect(seen[1]?.some((message) => message.role === 'assistant' && message.content === 'HALF')).toBe(false)
    expect(await second.submission(submission.id).wait()).toEqual({ status: 'done', text: 'done' })
    expect(second.partial(1)).toBeUndefined()
  })
})
