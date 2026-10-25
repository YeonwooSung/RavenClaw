import { DurableBusy, DurableClosed, DurableFault } from '../errors.ts'
import {
  ROOT_CONVERSATION_ID,
  type DurableBatch,
  type DurableModel,
  type DurableStorage,
  type DurableSubmissionRow,
  type DurableTaskRow,
  type DurableTool,
  type JsonObject,
  type JsonValue,
} from '../storage/types.ts'
import { createCommitLine, type CommitLine } from './commit.ts'
import { DEFAULT_RESTART_LIMIT, evolveTask, holdPending, reconcileTask } from './scheduler.ts'
import { createPhases } from './turn.ts'

export type DurableRuntime = {
  resume(): Promise<void>
  root(): Promise<DurableConversation>
  submission(id: number): DurableSubmission
  close(): Promise<void>
  abandon(): void
  retryTask(taskId: number): Promise<void>
  readonly closed: boolean
}

export type DurableConversation = {
  readonly id: number
  submit(input: { content: string; requestId?: string }): Promise<DurableSubmission>
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
        const live = tx.readDocument('live')
        const run = liveRun(live)
        if (run) {
          const row = tx.readSubmission(run.submissionId)
          if (row && row.status === 'queued') {
            batch.submissions = [unanswered(row, 'task_parked')]
          }
          batch.documents = [{ key: 'live', value: {} }]
        }
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

  async function root(): Promise<DurableConversation> {
    if (isDead()) throw new DurableClosed('closed')
    await line.run((tx) => {
      if (tx.readConversation(ROOT_CONVERSATION_ID)) return
      const agent: JsonObject = { modelId: options.modelId }
      if (options.systemPrompt !== undefined) agent.systemPrompt = options.systemPrompt
      tx.stage({
        conversations: [{ id: ROOT_CONVERSATION_ID }],
        documents: [
          { key: 'agent', value: agent },
          { key: 'live', value: {} },
        ],
      })
    })
    return { id: ROOT_CONVERSATION_ID, submit }
  }

  async function submit(input: { content: string; requestId?: string }): Promise<DurableSubmission> {
    if (isDead()) throw new DurableClosed('closed')
    const row = await line.run((tx) => {
      if (input.requestId !== undefined) {
        const existing = tx.readSubmissionByRequest(ROOT_CONVERSATION_ID, input.requestId)
        if (existing) return existing
      }
      const live = tx.readDocument('live')
      if (liveRun(live)) throw new DurableBusy()
      const entryId = tx.mintId()
      const submissionId = tx.mintId()
      const taskId = tx.mintId()
      const submission: DurableSubmissionRow = {
        id: submissionId,
        conversationId: ROOT_CONVERSATION_ID,
        status: 'queued',
        entryId,
      }
      if (input.requestId !== undefined) submission.requestId = input.requestId
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
            message: { role: 'user', content: input.content },
          },
        ],
        submissions: [submission],
        tasks: [task],
        documents: [{ key: 'live', value: { run: { submissionId, generationTaskId: taskId } } }],
      })
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

  const runtime: DurableRuntime = {
    resume() {
      if (pumping) return loop
      return kick()
    },
    root,
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
    get closed() {
      return abandoned || closing || closedFlag
    },
  }
  return runtime
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
  const generation = tasks
    .filter((task) => task.name === 'generation' && task.status === 'pending' && !task.parked)
    .sort((a, b) => a.id - b.id)[0]
  return generation ? [generation] : []
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
