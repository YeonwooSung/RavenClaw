import type { CommitLine, CommitTx } from './commit.ts'
import { evolveTask } from './scheduler.ts'
import {
  ROOT_CONVERSATION_ID,
  type DurableEntryRow,
  type DurableHooks,
  type DurableMessage,
  type DurableModel,
  type DurableSubmissionRow,
  type DurableTaskRow,
  type DurableTool,
  type InboxItem,
  type JsonObject,
  type JsonValue,
} from '../storage/types.ts'

export type PhaseHost = {
  line: CommitLine
  model: DurableModel
  tools: readonly DurableTool[]
  modelId: string
  systemPrompt?: string
  signal: AbortSignal
  stopped(): boolean
  now(): number
  hooks?: DurableHooks
}

type LiveSlot = { taskId: number; status: 'running' | 'done'; entryId?: number }
type LiveRun = { submissionId: number; generationTaskId: number; inputs?: number[] }
type LiveDoc = { run?: LiveRun; tools?: LiveSlot[] }

const COMPACT_SYSTEM =
  'Summarize the conversation so a later turn can continue. Keep decisions, errors, and file paths. Omit chatter.'
const COMPACT_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
const COMPACT_SUFFIX = '\n</summary>'

export function createPhases(host: PhaseHost): {
  runGeneration(taskId: number): Promise<void>
  runTool(taskId: number): Promise<void>
  runCompaction(taskId: number): Promise<void>
} {
  return {
    async runGeneration(taskId) {
      const task = await readTask(host, taskId)
      if (!task || task.parked || task.status === 'terminal' || host.stopped()) return
      if (task.checkpoint?.phase === 'sleep') {
        await sleepPhase(host, task.id)
        return
      }
      if (task.checkpoint?.phase === 'tools' || task.status === 'waiting') {
        await followUp(host, task.id)
        return
      }
      if (task.checkpoint?.phase === 'prepare' || task.checkpoint === undefined) {
        await prepare(host, task.id)
        if (host.stopped()) return
      }
      const ready = await readTask(host, taskId)
      if (!ready || host.stopped()) return
      if (ready.checkpoint?.phase === 'request') await request(host, ready.id)
    },
    async runTool(taskId) {
      const task = await readTask(host, taskId)
      if (!task || task.parked || task.status === 'terminal' || host.stopped()) return
      if (task.checkpoint?.phase === 'execute') {
        await recoverExecute(host, task.id)
        return
      }
      await callPhase(host, task.id)
    },
    async runCompaction(taskId) {
      const planned = await host.line.run((tx) => planCompaction(tx, taskId))
      if (!planned || host.stopped()) return
      if (planned.kind === 'empty') return
      if (host.hooks?.beforeCompact) {
        try {
          const decision = await host.hooks.beforeCompact({
            conversationId: planned.conversationId,
            taskId,
            messages: planned.source,
            ...(planned.instructions !== undefined ? { instructions: planned.instructions } : {}),
          })
          if (decision && 'decline' in decision && decision.decline) {
            await host.line.run((tx) => finishCompaction(tx, taskId, { failed: false, answer: '' }))
            return
          }
          if (decision && 'summary' in decision && typeof decision.summary === 'string') {
            const text = `${COMPACT_PREFIX}${decision.summary}${COMPACT_SUFFIX}`
            await host.line.run((tx) =>
              finishCompaction(tx, taskId, { failed: false, answer: text, boundaryId: planned.boundaryId }),
            )
            return
          }
        } catch {
          // A thrown beforeCompact leaves the model to summarize.
        }
      }
      let result: Awaited<ReturnType<DurableModel['complete']>>
      try {
        result = await host.model.complete({
          messages: planned.messages,
          modelId: host.modelId,
          signal: host.signal,
        })
      } catch (error) {
        if (host.stopped()) return
        const message = error instanceof Error ? error.message : String(error)
        await host.line.run((tx) => finishCompaction(tx, taskId, { failed: true, error: message }))
        return
      }
      if (host.stopped()) return
      if (result.stopReason === 'stop' && result.content.length > 0) {
        const text = `${COMPACT_PREFIX}${result.content}${COMPACT_SUFFIX}`
        await host.line.run((tx) =>
          finishCompaction(tx, taskId, { failed: false, answer: text, boundaryId: planned.boundaryId }),
        )
        return
      }
      await host.line.run((tx) => finishCompaction(tx, taskId, { failed: true, error: 'model_error' }))
    },
  }
}

export function projectMessages(entries: readonly DurableEntryRow[], cutoff: number): DurableMessage[] {
  const scoped = compactWindow(entries, cutoff)
  const callIds = new Set<string>()
  for (const entry of scoped) {
    if (entry.message.role !== 'assistant') continue
    if (entry.message.stopReason === 'aborted' || entry.message.stopReason === 'error') continue
    for (const call of entry.message.toolCalls ?? []) callIds.add(call.id)
  }
  const messages: DurableMessage[] = []
  for (const entry of scoped) {
    const message = entry.message
    if (message.role === 'assistant' && (message.stopReason === 'aborted' || message.stopReason === 'error')) continue
    if (message.role === 'tool' && !callIds.has(message.toolCallId)) continue
    messages.push(message)
  }
  const systemIndex = messages.findIndex((message) => message.role === 'system')
  const system = systemIndex > 0 ? messages[systemIndex] : undefined
  if (system) {
    messages.splice(systemIndex, 1)
    messages.unshift(system)
  }
  return messages
}

function compactWindow(entries: readonly DurableEntryRow[], cutoff: number): DurableEntryRow[] {
  const inCutoff = entries.filter((entry) => entry.id <= cutoff)
  let head: DurableEntryRow | undefined
  for (const entry of inCutoff) {
    if (entry.kind === 'compact' && (!head || entry.id > head.id)) head = entry
  }
  const start = head ? (head.boundaryId ?? head.id) : undefined
  const window = start === undefined ? inCutoff : inCutoff.filter((entry) => entry.id >= start)
  const lateTools = entries.filter(
    (entry) => entry.kind === 'tool' && entry.id > cutoff && !window.some((kept) => kept.id === entry.id),
  )
  const ordered = [...window, ...lateTools].sort((a, b) => a.id - b.id)
  if (!head) return ordered
  return [head, ...ordered.filter((entry) => entry.id !== head.id)]
}

function activeEntries(entries: readonly DurableEntryRow[]): DurableEntryRow[] {
  const ordered = [...entries].sort((a, b) => a.id - b.id)
  let head: DurableEntryRow | undefined
  for (const entry of ordered) {
    if (entry.kind === 'compact' && (!head || entry.id > head.id)) head = entry
  }
  if (!head) return ordered
  const start = head.boundaryId ?? head.id
  return ordered.filter((entry) => entry.id >= start)
}

type CompactionPlan =
  | { kind: 'empty' }
  | {
      kind: 'summarize'
      messages: DurableMessage[]
      source: DurableMessage[]
      boundaryId: number
      conversationId: number
      instructions?: string
    }

function planCompaction(tx: CommitTx, taskId: number): CompactionPlan | undefined {
  const task = tx.readTask(taskId)
  if (!task || task.status === 'terminal') return undefined
  const active = activeEntries(tx.readEntries(task.conversationId))
  const countable = active.filter(
    (entry) => entry.message.role === 'user' || entry.message.role === 'assistant',
  )
  if (countable.length <= 4) {
    finishCompaction(tx, taskId, { failed: false, answer: '' })
    return { kind: 'empty' }
  }
  const firstTail = countable[countable.length - 2]
  if (!firstTail) return undefined
  let startAt = active.findIndex((entry) => entry.id === firstTail.id)
  while (startAt > 0 && active[startAt]?.kind === 'tool') startAt -= 1
  const boundary = active[startAt]
  if (!boundary) return undefined
  const source = active.filter((entry) => entry.id < boundary.id)
  const lines = source.flatMap((entry) => {
    const message = entry.message
    if (message.role === 'system') return []
    const prefix = message.role === 'user' ? '[User] ' : message.role === 'assistant' ? '[Assistant] ' : '[Tool] '
    return [`${prefix}${message.content.slice(0, 2000)}`]
  })
  const instructions = task.checkpoint?.instructions
  const focus = typeof instructions === 'string' && instructions.length > 0 ? instructions : undefined
  let user = lines.join('\n')
  if (focus !== undefined) user += `\nAdditional focus: ${focus}`
  return {
    kind: 'summarize',
    boundaryId: boundary.id,
    conversationId: task.conversationId,
    source: source.flatMap((entry) => (entry.message.role === 'system' ? [] : [entry.message])),
    ...(focus !== undefined ? { instructions: focus } : {}),
    messages: [
      { role: 'system', content: COMPACT_SYSTEM },
      { role: 'user', content: user },
    ],
  }
}

function finishCompaction(
  tx: CommitTx,
  taskId: number,
  result: { failed: false; answer: string; boundaryId?: number } | { failed: true; error: string },
): void {
  const task = tx.readTask(taskId)
  if (!task) return
  const submission = tx.readSubmissionByRequest(task.conversationId, `compaction:${task.id}`)
  const entries: DurableEntryRow[] = []
  if (!result.failed && result.boundaryId !== undefined) {
    entries.push({
      id: tx.mintId(),
      conversationId: task.conversationId,
      kind: 'compact',
      boundaryId: result.boundaryId,
      message: { role: 'user', content: result.answer },
    })
  }
  const submissions: DurableSubmissionRow[] = []
  if (submission) {
    const next: DurableSubmissionRow = {
      id: submission.id,
      conversationId: submission.conversationId,
      status: result.failed ? 'unanswered' : 'done',
    }
    if (submission.requestId !== undefined) next.requestId = submission.requestId
    if (result.failed) next.reason = 'model_error'
    else next.answer = result.answer
    submissions.push(next)
  }
  tx.stage({
    ...(entries.length > 0 ? { entries } : {}),
    tasks: [evolveTask(task, { status: 'terminal', outcome: result.failed ? 'failed' : 'completed' })],
    ...(submissions.length > 0 ? { submissions } : {}),
  })
}

async function prepare(host: PhaseHost, taskId: number): Promise<void> {
  await host.line.run((tx) => {
    const task = tx.readTask(taskId)
    if (!task) return
    const conversationId = task.conversationId
    const entries = tx.readEntries(conversationId)
    const staged: DurableEntryRow[] = []
    const prompt = host.systemPrompt
    if (prompt && prompt.length > 0 && !entries.some((entry) => entry.kind === 'system')) {
      const id = tx.mintId()
      staged.push({
        id,
        conversationId,
        kind: 'system',
        message: { role: 'system', content: prompt },
      })
    }
    const cutoff = [...entries, ...staged].reduce((max, entry) => Math.max(max, entry.id), 0)
    const checkpoint: JsonObject = { phase: 'request', modelId: host.modelId, cutoff }
    tx.stage({
      entries: staged,
      tasks: [evolveTask(task, { status: 'pending', checkpoint })],
    })
  })
}

async function request(host: PhaseHost, taskId: number): Promise<void> {
  const pinned = await host.line.run((tx) => {
    const task = tx.readTask(taskId)
    if (!task?.checkpoint || task.checkpoint.phase !== 'request') return undefined
    tx.stage({ tasks: [evolveTask(task, { status: 'running', checkpoint: task.checkpoint })] })
    return {
      conversationId: task.conversationId,
      modelId: typeof task.checkpoint.modelId === 'string' ? task.checkpoint.modelId : host.modelId,
      cutoff: typeof task.checkpoint.cutoff === 'number' ? task.checkpoint.cutoff : 0,
    }
  })
  if (!pinned || host.stopped()) return
  await repairMissing(host, pinned.conversationId, pinned.cutoff)
  if (host.stopped()) return
  let messages = await host.line.run((tx) =>
    projectMessages(tx.readEntries(pinned.conversationId), pinned.cutoff),
  )
  if (host.hooks?.beforeRequest) {
    try {
      const replaced = await host.hooks.beforeRequest({
        conversationId: pinned.conversationId,
        taskId,
        messages,
      })
      if (replaced && Array.isArray(replaced.messages)) messages = [...replaced.messages]
    } catch {
      // A thrown beforeRequest keeps the original messages.
    }
  }
  let result: Awaited<ReturnType<DurableModel['complete']>>
  const pending: Promise<void>[] = []
  try {
    const stream = host.model.stream
    if (typeof stream === 'function') {
      result = await stream({
        messages,
        modelId: pinned.modelId,
        signal: host.signal,
        onPartial(text) {
          const write = writePartial(host, taskId, text)
          pending.push(write)
          return write
        },
      })
      await Promise.all(pending)
    } else {
      result = await host.model.complete({ messages, modelId: pinned.modelId, signal: host.signal })
    }
  } catch (error) {
    if (host.stopped()) return
    const message = error instanceof Error ? error.message : String(error)
    await settleModelError(host, taskId, message)
    return
  }
  if (host.stopped()) return
  if (host.hooks?.afterResponse) {
    try {
      await host.hooks.afterResponse({
        conversationId: pinned.conversationId,
        taskId,
        content: result.content,
        stopReason: result.stopReason,
      })
    } catch {
      // An observer throw does not change classification.
    }
  }
  if (result.stopReason === 'toolUse' && result.toolCalls && result.toolCalls.length > 0) {
    await settleToolUse(host, taskId, result.content, result.toolCalls)
    return
  }
  if (result.stopReason === 'error' || result.stopReason === 'toolUse') {
    await settleModelError(host, taskId, result.content.length > 0 ? result.content : 'model_error')
    return
  }
  await settleStop(host, taskId, result.content)
}

async function writePartial(host: PhaseHost, taskId: number, text: string): Promise<void> {
  if (host.stopped()) return
  await host.line.run((tx) => {
    const task = tx.readTask(taskId)
    if (!task) return
    const key = liveKey(task.conversationId)
    const live = tx.readDocument(key)
    const base: JsonObject = live && typeof live === 'object' && !Array.isArray(live) ? { ...live } : {}
    base.partial = { taskId, content: text }
    tx.stage({ documents: [{ key, value: base }] })
  })
}

async function repairMissing(host: PhaseHost, conversationId: number, cutoff: number): Promise<void> {
  await host.line.run((tx) => {
    const entries = tx.readEntries(conversationId)
    const missing = missingCalls(entries, cutoff)
    if (missing.length === 0) return
    const staged: DurableEntryRow[] = missing.map((call) => ({
      id: tx.mintId(),
      conversationId,
      kind: 'tool' as const,
      message: {
        role: 'tool' as const,
        toolCallId: call.id,
        name: call.name,
        content: 'incomplete: tool did not finish',
        isError: true,
      },
    }))
    tx.stage({ entries: staged })
  })
}

function missingCalls(entries: readonly DurableEntryRow[], cutoff: number): { id: string; name: string }[] {
  const calls: { id: string; name: string }[] = []
  for (const entry of entries) {
    if (entry.id > cutoff || entry.message.role !== 'assistant') continue
    if (entry.message.stopReason === 'aborted' || entry.message.stopReason === 'error') continue
    for (const call of entry.message.toolCalls ?? []) calls.push({ id: call.id, name: call.name })
  }
  const answered = new Set(
    entries.flatMap((entry) => (entry.message.role === 'tool' ? [entry.message.toolCallId] : [])),
  )
  return calls.filter((call) => !answered.has(call.id))
}

async function settleStop(host: PhaseHost, taskId: number, content: string): Promise<void> {
  await host.line.run((tx) => {
    const task = tx.readTask(taskId)
    if (!task) return
    const conversationId = task.conversationId
    const entryId = tx.mintId()
    const items = readInbox(tx.readDocument(inboxKey(conversationId)))
    const submissions = doneSubmissions(tx, conversationId, content)
    const hasSteer = items.some((item) => item.mode === 'steer')
    const documents: { key: string; value: JsonValue }[] = []
    if (!hasSteer && !items.some((item) => item.mode === 'followUp')) {
      documents.push({ key: liveKey(conversationId), value: {} })
    }
    tx.stage({
      entries: [
        {
          id: entryId,
          conversationId,
          kind: 'assistant',
          message: { role: 'assistant', content, stopReason: 'stop' },
        },
      ],
      tasks: [evolveTask(task, { status: 'terminal', outcome: 'completed' })],
      submissions,
      ...(documents.length > 0 ? { documents } : {}),
    })
    if (hasSteer) placeFirstInboxRun(tx, conversationId, items, 'steer')
    else placeFirstFollowUp(tx, conversationId, items)
  })
}

async function settleModelError(host: PhaseHost, taskId: number, content: string): Promise<void> {
  await host.line.run((tx) => {
    const task = tx.readTask(taskId)
    if (!task) return
    const conversationId = task.conversationId
    tx.stage({
      entries: [
        {
          id: tx.mintId(),
          conversationId,
          kind: 'assistant',
          message: { role: 'assistant', content, stopReason: 'error' },
        },
      ],
      tasks: [evolveTask(task, { status: 'terminal', outcome: 'failed' })],
      submissions: unansweredSubmissions(tx, conversationId, 'model_error'),
      documents: [{ key: liveKey(conversationId), value: {} }],
    })
  })
}

async function settleToolUse(
  host: PhaseHost,
  taskId: number,
  content: string,
  calls: { id: string; name: string; arguments: JsonObject }[],
): Promise<void> {
  await host.line.run((tx) => {
    const task = tx.readTask(taskId)
    if (!task) return
    const planned = calls.map((call) => {
      const childId = tx.mintId()
      const callId = call.id.trim().length > 0 ? call.id : `call_${childId}`
      const argumentsAreObject = isJsonObject(call.arguments)
      const checkpoint: JsonObject = argumentsAreObject
        ? { phase: 'call', callId, name: call.name, arguments: call.arguments }
        : { phase: 'call', callId, name: call.name, invalid: true }
      const child: DurableTaskRow = {
        id: childId,
        name: 'tool',
        conversationId: task.conversationId,
        parentTaskId: task.id,
        status: 'pending',
        checkpoint,
        restarts: 0,
        parked: false,
      }
      return { child, callId, name: call.name, arguments: argumentsAreObject ? call.arguments : undefined }
    })
    const assistantCalls = planned.map((item) => ({
      id: item.callId,
      name: item.name,
      arguments: item.arguments ?? {},
    }))
    const live = tx.readDocument(liveKey(task.conversationId))
    const documents: { key: string; value: JsonValue }[] = []
    if (live && typeof live === 'object' && !Array.isArray(live) && Object.hasOwn(live, 'partial')) {
      const next = { ...live }
      delete next.partial
      documents.push({ key: liveKey(task.conversationId), value: next })
    }
    tx.stage({
      entries: [
        {
          id: tx.mintId(),
          conversationId: task.conversationId,
          kind: 'assistant',
          message: {
            role: 'assistant',
            content,
            stopReason: 'toolUse',
            toolCalls: assistantCalls,
          },
        },
      ],
      tasks: [
        evolveTask(task, { status: 'waiting', checkpoint: { phase: 'tools' } }),
        ...planned.map((item) => item.child),
      ],
      ...(documents.length > 0 ? { documents } : {}),
    })
  })
}

async function followUp(host: PhaseHost, taskId: number): Promise<void> {
  await host.line.run((tx) => {
    const task = tx.readTask(taskId)
    if (!task) return
    const kids = tx.readTasks().filter((item) => item.parentTaskId === task.id)
    if (kids.length === 0 || kids.some((item) => item.status !== 'terminal')) return
    const conversationId = task.conversationId
    const live = parseLive(tx.readDocument(liveKey(conversationId)))
    const done = evolveTask(task, { status: 'terminal', outcome: 'completed' })
    if (!live.run || live.run.generationTaskId !== task.id) {
      tx.stage({ tasks: [done] })
      return
    }
    const steerId = placeFirstSteer(tx, conversationId)
    const nextId = tx.mintId()
    const next: DurableTaskRow = {
      id: nextId,
      name: 'generation',
      conversationId,
      status: 'pending',
      checkpoint: { phase: 'prepare' },
      restarts: 0,
      parked: false,
    }
    const inputs = [...(live.run.inputs ?? [])]
    if (steerId !== undefined && !inputs.includes(steerId)) inputs.push(steerId)
    tx.stage({
      tasks: [done, next],
      documents: [
        {
          key: liveKey(conversationId),
          value: {
            run: runDocument({
              submissionId: live.run.submissionId,
              generationTaskId: nextId,
              inputs,
            }),
          },
        },
      ],
    })
  })
}

async function callPhase(host: PhaseHost, taskId: number): Promise<void> {
  const intent = await host.line.run((tx) => beginCall(host, tx, taskId))
  if (!intent || host.stopped()) return
  await executeBody(host, taskId, intent)
}

function beginCall(host: PhaseHost, tx: CommitTx, taskId: number): ExecuteIntent | undefined {
  const task = tx.readTask(taskId)
  if (!task?.checkpoint || task.checkpoint.phase === 'execute') return undefined
  const callId = typeof task.checkpoint.callId === 'string' ? task.checkpoint.callId : `call_${task.id}`
  const name = typeof task.checkpoint.name === 'string' ? task.checkpoint.name : ''
  if (name.length === 0 || !host.tools.some((tool) => tool.name === name)) {
    writeToolTerminal(tx, task, { callId, name, content: 'tool_unavailable', outcome: 'failed' })
    return undefined
  }
  if (task.checkpoint.invalid === true || !isJsonObject(task.checkpoint.arguments)) {
    writeToolTerminal(tx, task, { callId, name, content: 'invalid_arguments', outcome: 'failed' })
    return undefined
  }
  const tool = host.tools.find((item) => item.name === name)
  const replay = tool?.replay ?? 'unsafe'
  const args = task.checkpoint.arguments
  const checkpoint: JsonObject = { phase: 'execute', callId, name, arguments: args, replay }
  const live = parseLive(tx.readDocument(liveKey(task.conversationId)))
  tx.stage({
    tasks: [evolveTask(task, { status: 'running', checkpoint })],
    documents: [{ key: liveKey(task.conversationId), value: withSlot(live, { taskId: task.id, status: 'running' }) }],
  })
  return { callId, name, arguments: args, replay }
}

async function recoverExecute(host: PhaseHost, taskId: number): Promise<void> {
  const decision = await host.line.run((tx) => {
    const task = tx.readTask(taskId)
    if (!task?.checkpoint) return undefined
    const callId = typeof task.checkpoint.callId === 'string' ? task.checkpoint.callId : `call_${task.id}`
    const name = typeof task.checkpoint.name === 'string' ? task.checkpoint.name : ''
    const replay = task.checkpoint.replay === 'safe' ? 'safe' : 'unsafe'
    const args = isJsonObject(task.checkpoint.arguments) ? task.checkpoint.arguments : undefined
    const tool = host.tools.find((item) => item.name === name)
    const current = tool?.replay ?? 'unsafe'
    if (tool && args && replay === 'safe' && current === 'safe') {
      tx.stage({ tasks: [evolveTask(task, { status: 'running', checkpoint: task.checkpoint })] })
      return { callId, name, arguments: args, replay: 'safe' as const }
    }
    writeToolTerminal(tx, task, { callId, name, content: 'interrupted', outcome: 'failed' })
    return undefined
  })
  if (!decision || host.stopped()) return
  await executeBody(host, taskId, decision)
}

type ExecuteIntent = { callId: string; name: string; arguments: JsonObject; replay: 'safe' | 'unsafe' }

async function callNested(
  host: PhaseHost,
  parentTaskId: number,
  name: string,
  args: JsonObject,
): Promise<{ content: string; isError: boolean }> {
  const tool = host.tools.find((item) => item.name === name)
  if (!tool) return { content: 'tool_unavailable', isError: true }
  const parent = await host.line.run((tx) => tx.readTask(parentTaskId))
  if (!parent || parent.nested === true) return { content: 'nested tool depth', isError: true }
  const childId = await host.line.run((tx) => {
    const id = tx.mintId()
    const task: DurableTaskRow = {
      id,
      name: 'tool',
      conversationId: parent.conversationId,
      parentTaskId,
      nested: true,
      status: 'running',
      checkpoint: { phase: 'execute', name, arguments: args, replay: tool.replay ?? 'unsafe' },
      restarts: 0,
      parked: false,
    }
    tx.stage({ tasks: [task] })
    return id
  })
  await executeBody(host, childId, {
    callId: `nested:${childId}`,
    name,
    arguments: args,
    replay: tool.replay === 'safe' ? 'safe' : 'unsafe',
  })
  const entry = await host.line.run((tx) =>
    tx
      .readEntries(parent.conversationId)
      .find((row) => row.message.role === 'tool' && row.message.toolCallId === `nested:${childId}`),
  )
  if (!entry || entry.message.role !== 'tool') return { content: 'tool_error: nested', isError: true }
  return { content: entry.message.content, isError: entry.message.isError }
}

async function executeBody(host: PhaseHost, taskId: number, intent: ExecuteIntent): Promise<void> {
  const tool = host.tools.find((item) => item.name === intent.name)
  if (!tool) {
    await host.line.run((tx) => {
      const task = tx.readTask(taskId)
      if (!task) return
      writeToolTerminal(tx, task, {
        callId: intent.callId,
        name: intent.name,
        content: 'interrupted',
        outcome: 'failed',
      })
    })
    return
  }
  const current = await host.line.run((tx) => tx.readTask(taskId))
  let args = intent.arguments
  if (host.hooks?.beforeTool && current) {
    try {
      const decision = await host.hooks.beforeTool({
        conversationId: current.conversationId,
        taskId,
        name: intent.name,
        arguments: args,
      })
      if (decision && typeof decision.block === 'string') {
        await host.line.run((tx) => {
          const task = tx.readTask(taskId)
          if (!task) return
          writeToolTerminal(tx, task, {
            callId: intent.callId,
            name: intent.name,
            content: decision.block ?? '',
            isError: true,
            outcome: 'failed',
          })
        })
        return
      }
      if (decision?.arguments) args = decision.arguments
    } catch {
      await host.line.run((tx) => {
        const task = tx.readTask(taskId)
        if (!task) return
        writeToolTerminal(tx, task, {
          callId: intent.callId,
          name: intent.name,
          content: 'hook_error',
          isError: true,
          outcome: 'failed',
        })
      })
      return
    }
  }
  let value: { content: string; isError?: boolean; sleepUntil?: number }
  try {
    value = await tool.execute(copyArgs(args), {
      signal: host.signal,
      taskId,
      call: (name, callArgs) => callNested(host, taskId, name, callArgs),
      spawn: () => Promise.resolve({ status: 'unanswered', reason: 'subagent depth' }),
    })
  } catch (error) {
    if (host.stopped()) return
    const message = error instanceof Error ? error.message : String(error)
    await host.line.run((tx) => {
      const task = tx.readTask(taskId)
      if (!task || host.stopped()) return
      writeToolTerminal(tx, task, {
        callId: intent.callId,
        name: intent.name,
        content: `tool_error: ${message}`,
        outcome: 'failed',
      })
    })
    return
  }
  if (host.stopped()) return
  if (host.hooks?.afterTool && current && value && typeof value.content === 'string') {
    try {
      const replaced = await host.hooks.afterTool({
        conversationId: current.conversationId,
        taskId,
        name: intent.name,
        content: value.content,
        isError: value.isError === true,
      })
      if (replaced && typeof replaced.content === 'string') {
        value = {
          content: replaced.content,
          ...(replaced.isError !== undefined ? { isError: replaced.isError } : value.isError !== undefined ? { isError: value.isError } : {}),
          ...(value.sleepUntil !== undefined ? { sleepUntil: value.sleepUntil } : {}),
        }
      }
    } catch {
      // A thrown afterTool keeps the executed result.
    }
  }
  if (!value || typeof value.content !== 'string') {
    await host.line.run((tx) => {
      const task = tx.readTask(taskId)
      if (!task || host.stopped()) return
      tx.stage({ tasks: [evolveTask(task, { status: 'terminal', outcome: 'faulted' })] })
    })
    return
  }
  await host.line.run((tx) => {
    const task = tx.readTask(taskId)
    if (!task || host.stopped()) return
    writeToolTerminal(tx, task, {
      callId: intent.callId,
      name: intent.name,
      content: value.content,
      isError: value.isError === true,
      outcome: 'completed',
    })
    const until = value.sleepUntil
    if (task.parentTaskId === undefined) return
    if (typeof until !== 'number' || !Number.isFinite(until) || until < 0) return
    if (!(host.now() < until)) return
    const parent = tx.readTask(task.parentTaskId)
    if (!parent || parent.status === 'terminal') return
    tx.stage({
      tasks: [
        evolveTask(parent, {
          status: 'sleeping',
          checkpoint: { phase: 'sleep', until, resume: 'tools' },
        }),
      ],
    })
  })
}

async function sleepPhase(host: PhaseHost, taskId: number): Promise<void> {
  const due = await host.line.run((tx) => {
    const task = tx.readTask(taskId)
    if (!task || task.parked || task.status === 'terminal' || task.checkpoint?.phase !== 'sleep') return false
    const until = task.checkpoint.until
    if (typeof until === 'number' && host.now() < until) {
      tx.stage({
        tasks: [evolveTask(task, { status: 'sleeping', checkpoint: task.checkpoint })],
      })
      return false
    }
    tx.stage({
      tasks: [evolveTask(task, { status: 'pending', checkpoint: { phase: 'tools' } })],
    })
    return true
  })
  if (!due || host.stopped()) return
  await followUp(host, taskId)
}

function writeToolTerminal(
  tx: CommitTx,
  task: DurableTaskRow,
  result: { callId: string; name: string; content: string; isError?: boolean; outcome: 'failed' | 'completed' },
): void {
  const entryId = tx.mintId()
  const live = parseLive(tx.readDocument(liveKey(task.conversationId)))
  tx.stage({
    entries: [
      {
        id: entryId,
        conversationId: task.conversationId,
        kind: 'tool',
        message: {
          role: 'tool',
          toolCallId: result.callId,
          name: result.name,
          content: result.content,
          isError: result.outcome === 'failed' || result.isError === true,
        },
      },
    ],
    tasks: [evolveTask(task, { status: 'terminal', outcome: result.outcome })],
    documents: [
      { key: liveKey(task.conversationId), value: withSlot(live, { taskId: task.id, status: 'done', entryId }) },
    ],
  })
}

function doneSubmissions(tx: CommitTx, conversationId: number, text: string) {
  return settleSubmissions(tx, conversationId, { status: 'done' as const, answer: text })
}

function unansweredSubmissions(tx: CommitTx, conversationId: number, reason: string) {
  return settleSubmissions(tx, conversationId, { status: 'unanswered' as const, reason })
}

function settleSubmissions(
  tx: CommitTx,
  conversationId: number,
  patch: { status: 'done'; answer: string } | { status: 'unanswered'; reason: string },
): DurableSubmissionRow[] {
  const live = parseLive(tx.readDocument(liveKey(conversationId)))
  if (!live.run) return []
  const seen = new Set<number>()
  const rows: DurableSubmissionRow[] = []
  for (const id of [live.run.submissionId, ...(live.run.inputs ?? [])]) {
    if (seen.has(id)) continue
    seen.add(id)
    const row = tx.readSubmission(id)
    if (!row) continue
    const next: DurableSubmissionRow = {
      id: row.id,
      conversationId: row.conversationId,
      status: patch.status,
    }
    if (row.requestId !== undefined) next.requestId = row.requestId
    if (row.entryId !== undefined) next.entryId = row.entryId
    if (patch.status === 'done') next.answer = patch.answer
    else next.reason = patch.reason
    rows.push(next)
  }
  return rows
}

function withSlot(live: LiveDoc, slot: LiveSlot): JsonObject {
  const tools = (live.tools ?? []).filter((item) => item.taskId !== slot.taskId)
  const stored: JsonObject = slot.entryId !== undefined
    ? { taskId: slot.taskId, status: slot.status, entryId: slot.entryId }
    : { taskId: slot.taskId, status: slot.status }
  const doc: JsonObject = { tools: [...tools.map(slotJson), stored] }
  if (live.run) doc.run = runDocument(live.run)
  return doc
}

function runDocument(run: LiveRun): JsonObject {
  const value: JsonObject = {
    submissionId: run.submissionId,
    generationTaskId: run.generationTaskId,
  }
  if (run.inputs && run.inputs.length > 0) value.inputs = [...run.inputs]
  return value
}

function runInputs(value: JsonValue | undefined): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const inputs: number[] = []
  for (const item of value) {
    if (typeof item === 'number') inputs.push(item)
  }
  return inputs.length > 0 ? inputs : undefined
}

function slotJson(slot: LiveSlot): JsonObject {
  return slot.entryId !== undefined
    ? { taskId: slot.taskId, status: slot.status, entryId: slot.entryId }
    : { taskId: slot.taskId, status: slot.status }
}

function parseLive(value: JsonValue | undefined): LiveDoc {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const doc: LiveDoc = {}
  const run = value.run
  if (
    run &&
    typeof run === 'object' &&
    !Array.isArray(run) &&
    typeof run.submissionId === 'number' &&
    typeof run.generationTaskId === 'number'
  ) {
    const parsed: LiveRun = {
      submissionId: run.submissionId,
      generationTaskId: run.generationTaskId,
    }
    const inputs = runInputs(run.inputs)
    if (inputs) parsed.inputs = inputs
    doc.run = parsed
  }
  if (Array.isArray(value.tools)) {
    const tools: LiveSlot[] = []
    for (const item of value.tools) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      if (typeof item.taskId !== 'number') continue
      if (item.status !== 'running' && item.status !== 'done') continue
      const slot: LiveSlot = { taskId: item.taskId, status: item.status }
      if (typeof item.entryId === 'number') slot.entryId = item.entryId
      tools.push(slot)
    }
    doc.tools = tools
  }
  return doc
}

export function liveKey(id: number): string {
  return id === ROOT_CONVERSATION_ID ? 'live' : `live:${id}`
}

export function agentKey(id: number): string {
  return id === ROOT_CONVERSATION_ID ? 'agent' : `agent:${id}`
}

export function inboxKey(conversationId: number): string {
  return `inbox:${conversationId}`
}

export function inboxDocument(items: readonly InboxItem[]): JsonObject {
  const list: JsonValue[] = items.map((item) => {
    const stored: JsonObject = { id: item.id, mode: item.mode, content: item.content }
    if (item.requestId !== undefined) stored.requestId = item.requestId
    return stored
  })
  return { items: list }
}

export function readInbox(value: JsonValue | undefined): InboxItem[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const raw = value.items
  if (!Array.isArray(raw)) return []
  const items: InboxItem[] = []
  for (const entry of raw) {
    const item = inboxItem(entry)
    if (item) items.push(item)
  }
  return items
}

function inboxItem(value: JsonValue): InboxItem | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (typeof value.id !== 'number' || typeof value.content !== 'string') return undefined
  if (value.mode !== 'followUp' && value.mode !== 'steer') return undefined
  const item: InboxItem = { id: value.id, mode: value.mode, content: value.content }
  if (typeof value.requestId === 'string') item.requestId = value.requestId
  return item
}

export function placeFirstFollowUp(
  tx: CommitTx,
  conversationId: number,
  items: readonly InboxItem[],
): DurableSubmissionRow | undefined {
  return placeFirstInboxRun(tx, conversationId, items, 'followUp')
}

function placeFirstInboxRun(
  tx: CommitTx,
  conversationId: number,
  items: readonly InboxItem[],
  mode: 'followUp' | 'steer',
): DurableSubmissionRow | undefined {
  const index = items.findIndex((item) => item.mode === mode)
  if (index < 0) return undefined
  const item = items[index]
  if (!item) return undefined
  const rest = items.filter((_, at) => at !== index)
  const entryId = tx.mintId()
  const taskId = tx.mintId()
  const row = tx.readSubmission(item.id)
  const submission: DurableSubmissionRow = {
    id: item.id,
    conversationId: row?.conversationId ?? conversationId,
    status: 'queued',
    entryId,
  }
  const requestId = row?.requestId ?? item.requestId
  if (requestId !== undefined) submission.requestId = requestId
  const task: DurableTaskRow = {
    id: taskId,
    name: 'generation',
    conversationId,
    status: 'pending',
    checkpoint: { phase: 'prepare' },
    restarts: 0,
    parked: false,
  }
  tx.stage({
    entries: [
      {
        id: entryId,
        conversationId,
        kind: 'user',
        message: { role: 'user', content: item.content },
      },
    ],
    submissions: [submission],
    tasks: [task],
    documents: [
      { key: liveKey(conversationId), value: { run: { submissionId: item.id, generationTaskId: taskId } } },
      { key: inboxKey(conversationId), value: inboxDocument(rest) },
    ],
  })
  return submission
}

export function placeFirstSteer(tx: CommitTx, conversationId: number): number | undefined {
  const items = readInbox(tx.readDocument(inboxKey(conversationId)))
  const index = items.findIndex((item) => item.mode === 'steer')
  if (index < 0) return undefined
  const item = items[index]
  if (!item) return undefined
  const rest = items.filter((_, at) => at !== index)
  const entryId = tx.mintId()
  const row = tx.readSubmission(item.id)
  const submission: DurableSubmissionRow = {
    id: item.id,
    conversationId: row?.conversationId ?? conversationId,
    status: 'queued',
    entryId,
  }
  const requestId = row?.requestId ?? item.requestId
  if (requestId !== undefined) submission.requestId = requestId
  tx.stage({
    entries: [
      {
        id: entryId,
        conversationId,
        kind: 'user',
        message: { role: 'user', content: item.content },
      },
    ],
    submissions: [submission],
    documents: [{ key: inboxKey(conversationId), value: inboxDocument(rest) }],
  })
  return submission.id
}

function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function copyArgs(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

async function readTask(host: PhaseHost, taskId: number): Promise<DurableTaskRow | undefined> {
  return host.line.run((tx) => tx.readTask(taskId))
}
