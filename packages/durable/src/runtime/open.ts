import { DurableBusy, DurableClosed, DurableFault } from '../errors.ts'
import {
  ROOT_CONVERSATION_ID,
  type DurableBatch,
  type DurableConversationRow,
  type DurableEntryRow,
  type DurableHooks,
  type DurableModel,
  type DurableStorage,
  type DurableSubmissionRow,
  type DurableTaskRow,
  type DurableTool,
  type InboxItem,
  type JsonObject,
  type JsonValue,
} from '../storage/types.ts'
import { createCommitLine, type CommitLine, type CommitTx } from './commit.ts'
import { DEFAULT_RESTART_LIMIT, evolveTask, holdPending, reconcileTask } from './scheduler.ts'
import {
  agentKey,
  createPhases,
  inboxDocument,
  inboxKey,
  liveKey,
  placeFirstFollowUp,
  readInbox,
} from './turn.ts'

export type DurableRuntime = {
  resume(): Promise<void>
  root(): Promise<DurableConversation>
  conversation(id: number): Promise<DurableConversation>
  submission(id: number): DurableSubmission
  close(): Promise<void>
  abandon(): void
  retryTask(taskId: number): Promise<void>
  wake(): { active: boolean; at?: number }
  partial(conversationId: number): string | undefined
  readonly closed: boolean
}

type SubmitInput = {
  content: string
  requestId?: string
  whenBusy?: 'reject' | 'followUp' | 'steer'
}

export type DurableConversation = {
  readonly id: number
  submit(input: SubmitInput): Promise<DurableSubmission>
  fork(atEntryId: number): Promise<DurableConversation>
  compact(instructions?: string): Promise<DurableSubmission>
}

export type DurableSubmission = {
  readonly id: number
  readonly requestId?: string
  wait(signal?: AbortSignal): Promise<
    | { status: 'done'; text: string }
    | { status: 'unanswered'; reason: string }
  >
}

type WaitResult = { status: 'done'; text: string } | { status: 'unanswered'; reason: string }

type Waiter = {
  resolve: (value: WaitResult) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export async function openDurable(
  storage: DurableStorage,
  options: {
    model: DurableModel
    tools?: readonly DurableTool[]
    modelId: string
    systemPrompt?: string
    now?: () => number
    restartLimit?: number
    hooks?: DurableHooks
  },
): Promise<DurableRuntime> {
  const now = options.now ?? (() => 0)
  const limit = options.restartLimit ?? DEFAULT_RESTART_LIMIT
  const controller = new AbortController()
  let abandoned = false
  let closing = false
  let closedFlag = false
  let enabled = false
  let pumping = false
  let loop = Promise.resolve()
  let inflight = 0
  let idleResolve: (() => void) | undefined
  let idleWait = Promise.resolve()
  const waiters = new Map<number, Waiter>()

  const line: CommitLine = createCommitLine(storage, {
    onCommit: () => flush(),
    onFatal: () => {
      closedFlag = true
      enabled = false
      controller.abort()
      rejectWaiters(new DurableClosed('storage failed'))
    },
  })

  const phases = createPhases({
    line,
    model: options.model,
    tools: options.tools ?? [],
    modelId: options.modelId,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    signal: controller.signal,
    stopped: () => abandoned || closing || closedFlag,
    now,
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
  })

  await reconcile()

  function isDead(): boolean {
    return abandoned || closing || closedFlag
  }

  function flush(): void {
    for (const [id, waiter] of waiters) {
      const row = storage.readSubmission(id)
      if (!row || row.status === 'queued') continue
      detach(waiter)
      waiters.delete(id)
      waiter.resolve(resultOf(row))
    }
  }

  function rejectWaiters(error: Error): void {
    for (const waiter of waiters.values()) {
      detach(waiter)
      waiter.reject(error)
    }
    waiters.clear()
  }

  function trackStart(): void {
    if (inflight === 0) idleWait = new Promise<void>((resolve) => {
      idleResolve = resolve
    })
    inflight += 1
  }

  function trackEnd(): void {
    inflight -= 1
    if (inflight === 0) {
      idleResolve?.()
      idleResolve = undefined
    }
  }

  async function reconcile(): Promise<void> {
    await line.run((tx) => {
      const staged: DurableTaskRow[] = []
      let park = false
      for (const task of tx.readTasks()) {
        if (task.status !== 'running') continue
        const next = reconcileTask(task, limit)
        staged.push(next.task)
        if (!next.invoke) park = true
      }
      const batch: DurableBatch = {}
      if (staged.length > 0) batch.tasks = staged
      if (park) {
        const parkedIds = new Set(
          staged.filter((task) => task.parked).map((task) => task.conversationId),
        )
        const submissions: DurableSubmissionRow[] = []
        const documents: { key: string; value: JsonValue }[] = []
        for (const conversationId of parkedIds) {
          const run = liveRun(tx.readDocument(liveKey(conversationId)))
          if (!run) continue
          const row = tx.readSubmission(run.submissionId)
          if (row && row.status === 'queued') submissions.push(unanswered(row, 'task_parked'))
          documents.push({ key: liveKey(conversationId), value: {} })
        }
        if (submissions.length > 0) batch.submissions = submissions
        if (documents.length > 0) batch.documents = documents
      }
      if (batch.tasks || batch.submissions || batch.documents) tx.stage(batch)
    })
  }

  async function promoteDue(): Promise<void> {
    await line.run((tx) => {
      const sleeping = tx.readTasks().filter((task) => task.status === 'sleeping')
      if (sleeping.length === 0) return
      const clock = now()
      const due = sleeping.filter((task) => {
        const until = task.checkpoint?.until
        return typeof until === 'number' && until <= clock
      })
      if (due.length === 0) return
      tx.stage({
        tasks: due.map((task) => {
          if (task.checkpoint === undefined) return evolveTask(task, { status: 'pending' })
          return evolveTask(task, { status: 'pending', checkpoint: task.checkpoint })
        }),
      })
    })
  }

  async function drive(): Promise<void> {
    try {
      while (enabled && !isDead()) {
        trackStart()
        try {
          await promoteDue()
          if (isDead()) return
          const selected = await line.run((tx) => select(tx.readTasks()))
          if (isDead() || selected.length === 0) return
          const first = selected[0]
          if (!first) return
          if (first.name === 'tool') await Promise.all(selected.map((task) => phases.runTool(task.id)))
          else if (first.name === 'compaction') await phases.runCompaction(first.id)
          else await phases.runGeneration(first.id)
        } finally {
          trackEnd()
        }
      }
    } catch (error) {
      if (error instanceof DurableClosed) return
      throw error
    }
  }

  function kick(): Promise<void> {
    if (isDead()) throw new DurableClosed('closed')
    enabled = true
    if (!pumping) {
      pumping = true
      loop = drive().finally(() => {
        pumping = false
      })
    }
    return loop
  }

  function handleFor(row: DurableSubmissionRow): DurableSubmission {
    const wait = (signal?: AbortSignal) => waitFor(row.id, signal)
    if (row.requestId !== undefined) return { id: row.id, requestId: row.requestId, wait }
    return { id: row.id, wait }
  }

  function waitFor(id: number, signal?: AbortSignal): Promise<WaitResult> {
    const row = storage.readSubmission(id)
    if (!row) return Promise.reject(new DurableFault(`unknown submission ${id}`))
    if (row.status !== 'queued') return Promise.resolve(resultOf(row))
    if (isDead()) return Promise.reject(new DurableClosed('closed'))
    if (signal?.aborted) return Promise.reject(abortError(signal))
    return new Promise<WaitResult>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject }
      if (signal) {
        const onAbort = () => {
          waiters.delete(id)
          reject(abortError(signal))
        }
        waiter.signal = signal
        waiter.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
      waiters.set(id, waiter)
    })
  }

  function conversationHandle(id: number): DurableConversation {
    return {
      id,
      submit: (input) => submit(id, input),
      fork: (atEntryId) => forkAt(id, atEntryId),
      compact: (instructions) => compactAt(id, instructions),
    }
  }

  async function root(): Promise<DurableConversation> {
    if (isDead()) throw new DurableClosed('closed')
    await line.run((tx) => {
      if (tx.readConversation(ROOT_CONVERSATION_ID)) return
      const agent: JsonObject = { modelId: options.modelId }
      if (options.systemPrompt !== undefined) agent.systemPrompt = options.systemPrompt
      tx.stage({
        conversations: [{ id: ROOT_CONVERSATION_ID }],
        documents: [
          { key: agentKey(ROOT_CONVERSATION_ID), value: agent },
          { key: liveKey(ROOT_CONVERSATION_ID), value: {} },
        ],
      })
    })
    return conversationHandle(ROOT_CONVERSATION_ID)
  }

  async function conversation(id: number): Promise<DurableConversation> {
    if (isDead()) throw new DurableClosed('closed')
    const row = await line.run((tx) => tx.readConversation(id))
    if (!row) throw new DurableFault(`unknown conversation ${id}`)
    return conversationHandle(id)
  }

  async function compactAt(conversationId: number, instructions?: string): Promise<DurableSubmission> {
    if (isDead()) throw new DurableClosed('closed')
    const row = await line.run((tx) => {
      if (!tx.readConversation(conversationId)) throw new DurableFault(`unknown conversation ${conversationId}`)
      if (liveRun(tx.readDocument(liveKey(conversationId)))) throw new DurableBusy()
      if (readInbox(tx.readDocument(inboxKey(conversationId))).length > 0) throw new DurableBusy()
      const taskId = tx.mintId()
      const submissionId = tx.mintId()
      const checkpoint: JsonObject = { phase: 'select' }
      if (instructions !== undefined && instructions.length > 0) checkpoint.instructions = instructions
      const task: DurableTaskRow = {
        id: taskId,
        name: 'compaction',
        conversationId,
        status: 'pending',
        checkpoint,
        restarts: 0,
        parked: false,
      }
      const submission: DurableSubmissionRow = {
        id: submissionId,
        conversationId,
        status: 'queued',
        requestId: `compaction:${taskId}`,
      }
      tx.stage({ tasks: [task], submissions: [submission] })
      return submission
    })
    if (!isDead()) {
      const pending = kick()
      pending.catch((error: unknown) => {
        if (!(error instanceof DurableClosed)) throw error
      })
    }
    return handleFor(row)
  }

  async function forkAt(conversationId: number, atEntryId: number): Promise<DurableConversation> {
    if (isDead()) throw new DurableClosed('closed')
    const childId = await line.run((tx) => {
      const parent = tx.readConversation(conversationId)
      if (!parent) throw new DurableFault(`unknown conversation ${conversationId}`)
      const entries = tx.readEntries(conversationId)
      if (!entries.some((entry) => entry.id === atEntryId)) {
        throw new DurableFault('entry is not on this conversation')
      }
      const childId = tx.mintId()
      const copied = entries
        .filter((entry) => entry.id <= atEntryId)
        .sort((a, b) => a.id - b.id)
        .map((entry) => copyEntry(tx, entry, childId))
      const row: DurableConversationRow = {
        id: childId,
        parentConversationId: conversationId,
        atEntryId,
      }
      const documents: { key: string; value: JsonValue }[] = []
      const agent = tx.readDocument(agentKey(conversationId))
      if (agent !== undefined) documents.push({ key: agentKey(childId), value: agent })
      tx.stage({
        conversations: [row],
        ...(copied.length > 0 ? { entries: copied } : {}),
        ...(documents.length > 0 ? { documents } : {}),
      })
      return childId
    })
    return conversationHandle(childId)
  }

  async function submit(conversationId: number, input: SubmitInput): Promise<DurableSubmission> {
    if (isDead()) throw new DurableClosed('closed')
    const row = await line.run((tx) => admit(tx, conversationId, input))
    if (!isDead()) {
      const pending = kick()
      pending.catch((error: unknown) => {
        if (!(error instanceof DurableClosed)) throw error
      })
    }
    return handleFor(row)
  }

  const runtime: DurableRuntime = {
    resume() {
      if (pumping) return loop
      return kick()
    },
    root,
    conversation,
    submission(id) {
      const row = storage.readSubmission(id)
      if (!row) throw new DurableFault(`unknown submission ${id}`)
      return handleFor(row)
    },
    async close() {
      if (abandoned || closedFlag) throw new DurableClosed('closed')
      if (closing) return
      closing = true
      enabled = false
      controller.abort()
      if (inflight > 0) await idleWait
      await line.run((tx) => {
        const running = tx.readTasks().filter((task) => task.status === 'running').map(holdPending)
        if (running.length > 0) tx.stage({ tasks: running })
      })
      closedFlag = true
      rejectWaiters(new DurableClosed('closed'))
    },
    abandon() {
      if (isDead()) return
      abandoned = true
      enabled = false
      controller.abort()
      rejectWaiters(new DurableClosed('abandoned'))
    },
    async retryTask(taskId: number) {
      if (isDead()) throw new DurableClosed('closed')
      await line.run((tx) => {
        const task = tx.readTask(taskId)
        if (!task) throw new DurableFault(`unknown task ${taskId}`)
        if (task.status === 'terminal') throw new DurableFault(`task ${taskId} is terminal`)
        const next: DurableTaskRow = {
          id: task.id,
          name: task.name,
          conversationId: task.conversationId,
          status: 'pending',
          restarts: 0,
          parked: false,
        }
        if (task.parentTaskId !== undefined) next.parentTaskId = task.parentTaskId
        if (task.checkpoint !== undefined) next.checkpoint = task.checkpoint
        tx.stage({ tasks: [next] })
      })
      const pending = kick()
      pending.catch((error: unknown) => {
        if (!(error instanceof DurableClosed)) throw error
      })
    },
    wake() {
      return reportWake(storage.readTasks(), now())
    },
    partial(conversationId) {
      if (isDead()) throw new DurableClosed('closed')
      if (!storage.readConversation(conversationId)) {
        throw new DurableFault(`unknown conversation ${conversationId}`)
      }
      const live = storage.readDocument(liveKey(conversationId))
      if (!live || typeof live !== 'object' || Array.isArray(live)) return undefined
      const partial = live.partial
      if (!partial || typeof partial !== 'object' || Array.isArray(partial)) return undefined
      return typeof partial.content === 'string' ? partial.content : undefined
    },
    get closed() {
      return abandoned || closing || closedFlag
    },
  }
  return runtime
}

function reportWake(
  tasks: readonly DurableTaskRow[],
  clock: number,
): { active: boolean; at?: number } {
  let active = false
  let at: number | undefined
  for (const task of tasks) {
    if (task.status === 'sleeping') {
      const until = task.checkpoint?.until
      if (typeof until !== 'number' || !Number.isFinite(until)) continue
      if (until <= clock) active = true
      else if (at === undefined || until < at) at = until
      continue
    }
    if (task.parked) continue
    if (task.status === 'pending' || task.status === 'running') {
      active = true
      continue
    }
    if (task.status === 'waiting' && terminalChildren(task, tasks)) active = true
  }
  if (at === undefined) return { active }
  return { active, at }
}

function terminalChildren(task: DurableTaskRow, tasks: readonly DurableTaskRow[]): boolean {
  const kids = tasks.filter((child) => child.parentTaskId === task.id)
  return kids.length > 0 && kids.every((child) => child.status === 'terminal')
}

function select(tasks: readonly DurableTaskRow[]): DurableTaskRow[] {
  const tools = tasks
    .filter((task) => task.name === 'tool' && task.status === 'pending' && !task.parked)
    .sort((a, b) => a.id - b.id)
  if (tools.length > 0) return tools
  const waiting = tasks
    .filter((task) => task.name === 'generation' && task.status === 'waiting' && !task.parked)
    .sort((a, b) => a.id - b.id)
  for (const generation of waiting) {
    const kids = tasks.filter((task) => task.parentTaskId === generation.id)
    if (kids.length > 0 && kids.every((task) => task.status === 'terminal')) return [generation]
  }
  const compaction = tasks
    .filter((task) => task.name === 'compaction' && task.status === 'pending' && !task.parked)
    .sort((a, b) => a.id - b.id)[0]
  if (compaction) return [compaction]
  const generation = tasks
    .filter((task) => task.name === 'generation' && task.status === 'pending' && !task.parked)
    .sort((a, b) => a.id - b.id)[0]
  return generation ? [generation] : []
}

function admit(tx: CommitTx, conversationId: number, input: SubmitInput): DurableSubmissionRow {
  if (input.requestId !== undefined) {
    const existing = tx.readSubmissionByRequest(conversationId, input.requestId)
    if (existing) return existing
  }
  const items = readInbox(tx.readDocument(inboxKey(conversationId)))
  const running = liveRun(tx.readDocument(liveKey(conversationId)))
  if (!running && items.length === 0) return placeNow(tx, conversationId, input)
  const mode = input.whenBusy ?? 'reject'
  if (mode !== 'followUp' && mode !== 'steer') throw new DurableBusy()
  if (!running) return enqueueAndPlace(tx, conversationId, input, items, mode)
  return enqueue(tx, conversationId, input, items, mode)
}

function enqueueAndPlace(
  tx: CommitTx,
  conversationId: number,
  input: SubmitInput,
  items: readonly InboxItem[],
  mode: 'followUp' | 'steer',
): DurableSubmissionRow {
  const submissionId = tx.mintId()
  const submission: DurableSubmissionRow = {
    id: submissionId,
    conversationId,
    status: 'queued',
  }
  if (input.requestId !== undefined) submission.requestId = input.requestId
  const item: InboxItem = { id: submissionId, mode, content: input.content }
  if (input.requestId !== undefined) item.requestId = input.requestId
  const next = [...items, item]
  tx.stage({
    submissions: [submission],
    documents: [{ key: inboxKey(conversationId), value: inboxDocument(next) }],
  })
  const placed = placeFirstFollowUp(tx, conversationId, next)
  if (placed?.id === submission.id) return placed
  return submission
}

function placeNow(tx: CommitTx, conversationId: number, input: SubmitInput): DurableSubmissionRow {
  const entryId = tx.mintId()
  const submissionId = tx.mintId()
  const taskId = tx.mintId()
  const submission: DurableSubmissionRow = {
    id: submissionId,
    conversationId,
    status: 'queued',
    entryId,
  }
  if (input.requestId !== undefined) submission.requestId = input.requestId
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
        message: { role: 'user', content: input.content },
      },
    ],
    submissions: [submission],
    tasks: [task],
    documents: [{ key: liveKey(conversationId), value: { run: { submissionId, generationTaskId: taskId } } }],
  })
  return submission
}

function enqueue(
  tx: CommitTx,
  conversationId: number,
  input: SubmitInput,
  items: readonly InboxItem[],
  mode: 'followUp' | 'steer',
): DurableSubmissionRow {
  const submissionId = tx.mintId()
  const submission: DurableSubmissionRow = {
    id: submissionId,
    conversationId,
    status: 'queued',
  }
  if (input.requestId !== undefined) submission.requestId = input.requestId
  const item: InboxItem = { id: submissionId, mode, content: input.content }
  if (input.requestId !== undefined) item.requestId = input.requestId
  tx.stage({
    submissions: [submission],
    documents: [{ key: inboxKey(conversationId), value: inboxDocument([...items, item]) }],
  })
  return submission
}

function copyEntry(tx: CommitTx, entry: DurableEntryRow, conversationId: number): DurableEntryRow {
  const next: DurableEntryRow = {
    id: tx.mintId(),
    conversationId,
    kind: entry.kind,
    message: entry.message,
  }
  if (entry.boundaryId !== undefined) next.boundaryId = entry.boundaryId
  return next
}

function liveRun(value: JsonValue | undefined): { submissionId: number; generationTaskId: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const run = value.run
  if (!run || typeof run !== 'object' || Array.isArray(run)) return undefined
  if (typeof run.submissionId !== 'number' || typeof run.generationTaskId !== 'number') return undefined
  return { submissionId: run.submissionId, generationTaskId: run.generationTaskId }
}

function unanswered(row: DurableSubmissionRow, reason: string): DurableSubmissionRow {
  const next: DurableSubmissionRow = {
    id: row.id,
    conversationId: row.conversationId,
    status: 'unanswered',
    reason,
  }
  if (row.requestId !== undefined) next.requestId = row.requestId
  if (row.entryId !== undefined) next.entryId = row.entryId
  return next
}

function resultOf(row: DurableSubmissionRow): WaitResult {
  if (row.status === 'done') return { status: 'done', text: row.answer ?? '' }
  return { status: 'unanswered', reason: row.reason ?? '' }
}

function detach(waiter: Waiter): void {
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted')
}
