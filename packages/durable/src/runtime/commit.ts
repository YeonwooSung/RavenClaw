import { DurableBusy, DurableClosed, DurableFault } from '../errors.ts'
import { copyStrict } from '../json.ts'
import type {
  DurableBatch,
  DurableConversationRow,
  DurableEntryRow,
  DurableStorage,
  DurableSubmissionRow,
  DurableTaskRow,
  JsonValue,
} from '../storage/types.ts'

export type CommitTx = {
  mintId(): number
  readConversation(id: number): DurableConversationRow | undefined
  readEntries(conversationId: number): DurableEntryRow[]
  readTask(id: number): DurableTaskRow | undefined
  readTasks(): DurableTaskRow[]
  readSubmission(id: number): DurableSubmissionRow | undefined
  readSubmissionByRequest(conversationId: number, requestId: string): DurableSubmissionRow | undefined
  readDocument(key: string): JsonValue | undefined
  stage(batch: DurableBatch): void
}

type Buffer = {
  conversations: Map<number, DurableConversationRow>
  entries: Map<number, DurableEntryRow>
  tasks: Map<number, DurableTaskRow>
  submissions: Map<number, DurableSubmissionRow>
  documents: Map<string, JsonValue>
}

export type CommitLine = {
  run<T>(fn: (tx: CommitTx) => T | Promise<T>): Promise<T>
  readonly closed: boolean
}

export function createCommitLine(
  storage: DurableStorage,
  hooks?: { onCommit?: () => void; onFatal?: (error: Error) => void },
): CommitLine {
  let closedError: Error | undefined
  let chain = Promise.resolve()

  function kill(error: unknown): never {
    const cause = error instanceof Error ? error : new Error(String(error))
    closedError = cause
    hooks?.onFatal?.(cause)
    throw new DurableClosed(cause.message)
  }

  function run<T>(fn: (tx: CommitTx) => T | Promise<T>): Promise<T> {
    const prev = chain
    let release!: () => void
    chain = new Promise<void>((resolve) => {
      release = resolve
    })
    return prev.then(() => runBody(fn)).finally(release)
  }

  async function runBody<T>(fn: (tx: CommitTx) => T | Promise<T>): Promise<T> {
    if (closedError) throw new DurableClosed(closedError.message)
    const buffer = emptyBuffer()
    try {
      const result = await fn(makeTx(storage, buffer, kill))
      if (!dirty(buffer)) return result
      try {
        storage.commit(toBatch(buffer))
      } catch (error) {
        if (error instanceof DurableFault || error instanceof DurableBusy) throw error
        kill(error)
      }
      hooks?.onCommit?.()
      return result
    } catch (error) {
      if (error instanceof DurableClosed) throw error
      throw error
    }
  }

  return {
    run,
    get closed() {
      return closedError !== undefined
    },
  }
}

function emptyBuffer(): Buffer {
  return {
    conversations: new Map(),
    entries: new Map(),
    tasks: new Map(),
    submissions: new Map(),
    documents: new Map(),
  }
}

function dirty(buffer: Buffer): boolean {
  return (
    buffer.conversations.size > 0 ||
    buffer.entries.size > 0 ||
    buffer.tasks.size > 0 ||
    buffer.submissions.size > 0 ||
    buffer.documents.size > 0
  )
}

function toBatch(buffer: Buffer): DurableBatch {
  const batch: DurableBatch = {}
  if (buffer.conversations.size > 0) batch.conversations = [...buffer.conversations.values()]
  if (buffer.entries.size > 0) batch.entries = [...buffer.entries.values()]
  if (buffer.tasks.size > 0) batch.tasks = [...buffer.tasks.values()]
  if (buffer.submissions.size > 0) batch.submissions = [...buffer.submissions.values()]
  if (buffer.documents.size > 0) {
    batch.documents = [...buffer.documents.entries()].map(([key, value]) => ({ key, value }))
  }
  return batch
}

function makeTx(storage: DurableStorage, buffer: Buffer, kill: (error: unknown) => never): CommitTx {
  return {
    mintId() {
      try {
        return storage.mintId()
      } catch (error) {
        if (error instanceof DurableFault) throw error
        kill(error)
      }
    },
    readConversation(id) {
      const staged = buffer.conversations.get(id)
      return staged ? copyStrict(staged) : storage.readConversation(id)
    },
    readEntries(conversationId) {
      const byId = new Map<number, DurableEntryRow>()
      for (const row of storage.readEntries(conversationId)) byId.set(row.id, row)
      for (const row of buffer.entries.values()) {
        if (row.conversationId === conversationId) byId.set(row.id, row)
      }
      return [...byId.values()].sort((a, b) => a.id - b.id).map((row) => copyStrict(row))
    },
    readTask(id) {
      const staged = buffer.tasks.get(id)
      return staged ? copyStrict(staged) : storage.readTask(id)
    },
    readTasks() {
      const byId = new Map<number, DurableTaskRow>()
      for (const row of storage.readTasks()) byId.set(row.id, row)
      for (const row of buffer.tasks.values()) byId.set(row.id, row)
      return [...byId.values()].sort((a, b) => a.id - b.id).map((row) => copyStrict(row))
    },
    readSubmission(id) {
      const staged = buffer.submissions.get(id)
      return staged ? copyStrict(staged) : storage.readSubmission(id)
    },
    readSubmissionByRequest(conversationId, requestId) {
      const staged = [...buffer.submissions.values()].find(
        (row) => row.conversationId === conversationId && row.requestId === requestId,
      )
      return staged ? copyStrict(staged) : storage.readSubmissionByRequest(conversationId, requestId)
    },
    readDocument(key) {
      if (buffer.documents.has(key)) {
        const value = buffer.documents.get(key)
        return value === undefined ? undefined : copyStrict(value)
      }
      return storage.readDocument(key)
    },
    stage(batch) {
      for (const row of batch.conversations ?? []) buffer.conversations.set(row.id, copyStrict(row))
      for (const row of batch.entries ?? []) buffer.entries.set(row.id, copyStrict(row))
      for (const row of batch.tasks ?? []) buffer.tasks.set(row.id, copyStrict(row))
      for (const row of batch.submissions ?? []) buffer.submissions.set(row.id, copyStrict(row))
      for (const row of batch.documents ?? []) buffer.documents.set(row.key, copyStrict(row.value))
    },
  }
}
