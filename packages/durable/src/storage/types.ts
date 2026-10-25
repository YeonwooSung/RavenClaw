export const ROOT_CONVERSATION_ID = 1

export type JsonObject = { [key: string]: JsonValue }
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

export type DurableReplay = 'safe' | 'unsafe'

export type DurableModel = {
  complete(input: {
    messages: readonly DurableMessage[]
    modelId: string
    signal: AbortSignal
  }): Promise<{
    content: string
    toolCalls?: DurableToolCall[]
    stopReason: 'stop' | 'toolUse' | 'error'
  }>
}

export type DurableTool = {
  name: string
  replay?: DurableReplay
  execute(
    args: JsonObject,
    ctx: { signal: AbortSignal; taskId: number },
  ): Promise<{ content: string; isError?: boolean; sleepUntil?: number }>
}

export type DurableToolCall = {
  id: string
  name: string
  arguments: JsonObject
}

export type DurableMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string
      toolCalls?: DurableToolCall[]
      stopReason: 'stop' | 'toolUse' | 'aborted' | 'error'
    }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError: boolean }

export type DurableConversationRow = { id: number }

export type DurableEntryRow = {
  id: number
  conversationId: number
  kind: 'system' | 'user' | 'assistant' | 'tool'
  message: DurableMessage
}

export type DurableTaskStatus = 'pending' | 'running' | 'waiting' | 'sleeping' | 'terminal'
export type DurableTaskOutcome = 'completed' | 'failed' | 'faulted' | 'aborted'

export type DurableTaskRow = {
  id: number
  name: 'generation' | 'tool'
  conversationId: number
  parentTaskId?: number
  status: DurableTaskStatus
  checkpoint?: JsonObject
  restarts: number
  parked: boolean
  outcome?: DurableTaskOutcome
}

export type DurableSubmissionRow = {
  id: number
  conversationId: number
  requestId?: string
  status: 'queued' | 'done' | 'unanswered'
  entryId?: number
  answer?: string
  reason?: string
}

export type InboxItem = {
  id: number
  mode: 'steer' | 'followUp'
  content: string
  requestId?: string
}

export type DurableBatch = {
  conversations?: DurableConversationRow[]
  entries?: DurableEntryRow[]
  tasks?: DurableTaskRow[]
  submissions?: DurableSubmissionRow[]
  documents?: { key: string; value: JsonValue }[]
}

export type DurableStorage = {
  mintId(): number
  commit(batch: DurableBatch): void
  readConversation(id: number): DurableConversationRow | undefined
  readEntries(conversationId: number): DurableEntryRow[]
  readTask(id: number): DurableTaskRow | undefined
  readTasks(): DurableTaskRow[]
  readSubmission(id: number): DurableSubmissionRow | undefined
  readSubmissionByRequest(conversationId: number, requestId: string): DurableSubmissionRow | undefined
  readDocument(key: string): JsonValue | undefined
  close(): void
}
