import { copyStrict } from '../json.ts'
import type {
  DurableBatch,
  DurableConversationRow,
  DurableEntryRow,
  DurableStorage,
  DurableSubmissionRow,
  DurableTaskRow,
  JsonValue,
} from './types.ts'

type State = {
  nextId: number
  conversations: Map<number, DurableConversationRow>
  entries: Map<number, DurableEntryRow>
  tasks: Map<number, DurableTaskRow>
  submissions: Map<number, DurableSubmissionRow>
  documents: Map<string, JsonValue>
}

export function openMemoryStorage(): DurableStorage {
  let closed = false
  let state: State = {
    nextId: 2,
    conversations: new Map(),
    entries: new Map(),
    tasks: new Map(),
    submissions: new Map(),
    documents: new Map(),
  }

  function guard(): void {
    if (closed) throw new Error('storage closed')
  }

  return {
    mintId() {
      guard()
      const id = state.nextId
      state = { ...state, nextId: id + 1 }
      return id
    },
    commit(batch) {
      guard()
      const next = cloneState(state)
      applyBatch(next, batch)
      state = next
    },
    readConversation(id) {
      guard()
      const row = state.conversations.get(id)
      return row ? copyStrict(row) : undefined
    },
    readEntries(conversationId) {
      guard()
      return [...state.entries.values()]
        .filter((row) => row.conversationId === conversationId)
        .sort((a, b) => a.id - b.id)
        .map((row) => copyStrict(row))
    },
    readTask(id) {
      guard()
      const row = state.tasks.get(id)
      return row ? copyStrict(row) : undefined
    },
    readTasks() {
      guard()
      return [...state.tasks.values()]
        .sort((a, b) => a.id - b.id)
        .map((row) => copyStrict(row))
    },
    readSubmission(id) {
      guard()
      const row = state.submissions.get(id)
      return row ? copyStrict(row) : undefined
    },
    readSubmissionByRequest(conversationId, requestId) {
      guard()
      const row = [...state.submissions.values()].find(
        (item) => item.conversationId === conversationId && item.requestId === requestId,
      )
      return row ? copyStrict(row) : undefined
    },
    readDocument(key) {
      guard()
      const value = state.documents.get(key)
      return value === undefined ? undefined : copyStrict(value)
    },
    close() {
      closed = true
    },
  }
}

function cloneState(state: State): State {
  return {
    nextId: state.nextId,
    conversations: new Map(state.conversations),
    entries: new Map(state.entries),
    tasks: new Map(state.tasks),
    submissions: new Map(state.submissions),
    documents: new Map(state.documents),
  }
}

function applyBatch(state: State, batch: DurableBatch): void {
  const conversations = (batch.conversations ?? []).map((row) => copyStrict(row))
  const entries = (batch.entries ?? []).map((row) => copyStrict(row))
  const tasks = (batch.tasks ?? []).map((row) => copyStrict(row))
  const submissions = (batch.submissions ?? []).map((row) => copyStrict(row))
  const documents = (batch.documents ?? []).map((row) => ({
    key: row.key,
    value: copyStrict(row.value),
  }))
  for (const row of conversations) state.conversations.set(row.id, row)
  for (const row of entries) state.entries.set(row.id, row)
  for (const row of tasks) state.tasks.set(row.id, row)
  for (const row of submissions) state.submissions.set(row.id, row)
  for (const row of documents) state.documents.set(row.key, row.value)
}
