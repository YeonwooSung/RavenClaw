import type { CommitLine, CommitTx } from './commit.ts'
import { evolveTask } from './scheduler.ts'
import {
  ROOT_CONVERSATION_ID,
  type DurableEntryRow,
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
}

type LiveSlot = { taskId: number; status: 'running' | 'done'; entryId?: number }
type LiveRun = { submissionId: number; generationTaskId: number; inputs?: number[] }
type LiveDoc = { run?: LiveRun; tools?: LiveSlot[] }

export function createPhases(host: PhaseHost): {
  runGeneration(taskId: number): Promise<void>
  runTool(taskId: number): Promise<void>
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
  }
}

export function projectMessages(entries: readonly DurableEntryRow[], cutoff: number): DurableMessage[] {
  const scoped = [...entries]
    .filter((entry) => entry.id <= cutoff || entry.kind === 'tool')
    .sort((a, b) => a.id - b.id)
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

async function prepare(host: PhaseHost, taskId: number): Promise<void> {
  await host.line.run((tx) => {
    const task = tx.readTask(taskId)
    if (!task) return
    const entries = tx.readEntries(ROOT_CONVERSATION_ID)
    const staged: DurableEntryRow[] = []
    const prompt = host.systemPrompt
    if (prompt && prompt.length > 0 && !entries.some((entry) => entry.kind === 'system')) {
      const id = tx.mintId()
      staged.push({
        id,
        conversationId: ROOT_CONVERSATION_ID,
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
      modelId: typeof task.checkpoint.modelId === 'string' ? task.checkpoint.modelId : host.modelId,
      cutoff: typeof task.checkpoint.cutoff === 'number' ? task.checkpoint.cutoff : 0,
    }
  })
  if (!pinned || host.stopped()) return
  await repairMissing(host, pinned.cutoff)
  if (host.stopped()) return
  const messages = await host.line.run((tx) => projectMessages(tx.readEntries(ROOT_CONVERSATION_ID), pinned.cutoff))
  let result: Awaited<ReturnType<DurableModel['complete']>>
  try {
    result = await host.model.complete({ messages, modelId: pinned.modelId, signal: host.signal })
  } catch (error) {
    if (host.stopped()) return
    const message = error instanceof Error ? error.message : String(error)
    await settleModelError(host, taskId, message)
    return
  }
  if (host.stopped()) return
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

async function repairMissing(host: PhaseHost, cutoff: number): Promise<void> {
  await host.line.run((tx) => {
    const entries = tx.readEntries(ROOT_CONVERSATION_ID)
    const missing = missingCalls(entries, cutoff)
    if (missing.length === 0) return
    const staged: DurableEntryRow[] = missing.map((call) => ({
      id: tx.mintId(),
      conversationId: ROOT_CONVERSATION_ID,
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
    const entryId = tx.mintId()
    const items = readInbox(tx.readDocument(inboxKey(ROOT_CONVERSATION_ID)))
    const submissions = doneSubmissions(tx, content)
    const hasSteer = items.some((item) => item.mode === 'steer')
    const documents: { key: string; value: JsonValue }[] = []
    if (!hasSteer && !items.some((item) => item.mode === 'followUp')) {
      documents.push({ key: 'live', value: {} })
    }
    tx.stage({
      entries: [
        {
          id: entryId,
          conversationId: ROOT_CONVERSATION_ID,
          kind: 'assistant',
          message: { role: 'assistant', content, stopReason: 'stop' },
        },
      ],
      tasks: [evolveTask(task, { status: 'terminal', outcome: 'completed' })],
      submissions,
      ...(documents.length > 0 ? { documents } : {}),
    })
    if (hasSteer) placeFirstInboxRun(tx, items, 'steer')
    else placeFirstFollowUp(tx, items)
  })
}

async function settleModelError(host: PhaseHost, taskId: number, content: string): Promise<void> {
  await host.line.run((tx) => {
    const task = tx.readTask(taskId)
    if (!task) return
    tx.stage({
      entries: [
        {
          id: tx.mintId(),
          conversationId: ROOT_CONVERSATION_ID,
          kind: 'assistant',
          message: { role: 'assistant', content, stopReason: 'error' },
        },
      ],
      tasks: [evolveTask(task, { status: 'terminal', outcome: 'failed' })],
      submissions: unansweredSubmissions(tx, 'model_error'),
      documents: [{ key: 'live', value: {} }],
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
        conversationId: ROOT_CONVERSATION_ID,
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
    tx.stage({
      entries: [
        {
          id: tx.mintId(),
          conversationId: ROOT_CONVERSATION_ID,
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
    })
  })
}

async function followUp(host: PhaseHost, taskId: number): Promise<void> {
  await host.line.run((tx) => {
    const task = tx.readTask(taskId)
    if (!task) return
    const kids = tx.readTasks().filter((item) => item.parentTaskId === task.id)
    if (kids.length === 0 || kids.some((item) => item.status !== 'terminal')) return
    const live = parseLive(tx.readDocument('live'))
    const done = evolveTask(task, { status: 'terminal', outcome: 'completed' })
    if (!live.run || live.run.generationTaskId !== task.id) {
      tx.stage({ tasks: [done] })
      return
    }
    const steerId = placeFirstSteer(tx)
    const nextId = tx.mintId()
    const next: DurableTaskRow = {
      id: nextId,
      name: 'generation',
      conversationId: ROOT_CONVERSATION_ID,
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
          key: 'live',
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
  const live = parseLive(tx.readDocument('live'))
  tx.stage({
    tasks: [evolveTask(task, { status: 'running', checkpoint })],
    documents: [{ key: 'live', value: withSlot(live, { taskId: task.id, status: 'running' }) }],
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
  let value: { content: string; isError?: boolean; sleepUntil?: number }
  try {
    value = await tool.execute(copyArgs(intent.arguments), { signal: host.signal, taskId })
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
  const live = parseLive(tx.readDocument('live'))
  tx.stage({
    entries: [
      {
        id: entryId,
        conversationId: ROOT_CONVERSATION_ID,
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
    documents: [{ key: 'live', value: withSlot(live, { taskId: task.id, status: 'done', entryId }) }],
  })
}

function doneSubmissions(tx: CommitTx, text: string) {
  return settleSubmissions(tx, { status: 'done' as const, answer: text })
}

function unansweredSubmissions(tx: CommitTx, reason: string) {
  return settleSubmissions(tx, { status: 'unanswered' as const, reason })
}

function settleSubmissions(
  tx: CommitTx,
  patch: { status: 'done'; answer: string } | { status: 'unanswered'; reason: string },
): DurableSubmissionRow[] {
  const live = parseLive(tx.readDocument('live'))
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

export function placeFirstFollowUp(tx: CommitTx, items: readonly InboxItem[]): DurableSubmissionRow | undefined {
  return placeFirstInboxRun(tx, items, 'followUp')
}

function placeFirstInboxRun(
  tx: CommitTx,
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
    conversationId: row?.conversationId ?? ROOT_CONVERSATION_ID,
    status: 'queued',
    entryId,
  }
  const requestId = row?.requestId ?? item.requestId
  if (requestId !== undefined) submission.requestId = requestId
  const task: DurableTaskRow = {
    id: taskId,
    name: 'generation',
    conversationId: ROOT_CONVERSATION_ID,
    status: 'pending',
    checkpoint: { phase: 'prepare' },
    restarts: 0,
    parked: false,
  }
  tx.stage({
    entries: [
      {
        id: entryId,
        conversationId: ROOT_CONVERSATION_ID,
        kind: 'user',
        message: { role: 'user', content: item.content },
      },
    ],
    submissions: [submission],
    tasks: [task],
    documents: [
      { key: 'live', value: { run: { submissionId: item.id, generationTaskId: taskId } } },
      { key: inboxKey(ROOT_CONVERSATION_ID), value: inboxDocument(rest) },
    ],
  })
  return submission
}

export function placeFirstSteer(tx: CommitTx): number | undefined {
  const items = readInbox(tx.readDocument(inboxKey(ROOT_CONVERSATION_ID)))
  const index = items.findIndex((item) => item.mode === 'steer')
  if (index < 0) return undefined
  const item = items[index]
  if (!item) return undefined
  const rest = items.filter((_, at) => at !== index)
  const entryId = tx.mintId()
  const row = tx.readSubmission(item.id)
  const submission: DurableSubmissionRow = {
    id: item.id,
    conversationId: row?.conversationId ?? ROOT_CONVERSATION_ID,
    status: 'queued',
    entryId,
  }
  const requestId = row?.requestId ?? item.requestId
  if (requestId !== undefined) submission.requestId = requestId
  tx.stage({
    entries: [
      {
        id: entryId,
        conversationId: ROOT_CONVERSATION_ID,
        kind: 'user',
        message: { role: 'user', content: item.content },
      },
    ],
    submissions: [submission],
    documents: [{ key: inboxKey(ROOT_CONVERSATION_ID), value: inboxDocument(rest) }],
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
