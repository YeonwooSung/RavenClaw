export const ROOT_CONVERSATION_ID = 1

export type JsonObject = { [key: string]: JsonValue }
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

export type DurableReplay = 'safe' | 'unsafe'

export type DurableHooks = {
  beforeRequest?(input: {
    conversationId: number
    taskId: number
    messages: readonly DurableMessage[]
  }): Promise<{ messages: readonly DurableMessage[] } | void> | { messages: readonly DurableMessage[] } | void
  afterResponse?(input: {
    conversationId: number
    taskId: number
    content: string
    stopReason: 'stop' | 'toolUse' | 'error'
  }): Promise<void> | void
  beforeTool?(input: {
    conversationId: number
    taskId: number
    name: string
    arguments: JsonObject
  }): Promise<{ arguments?: JsonObject; block?: string } | void> | { arguments?: JsonObject; block?: string } | void
  afterTool?(input: {
    conversationId: number
    taskId: number
    name: string
    content: string
    isError: boolean
  }): Promise<{ content: string; isError?: boolean } | void> | { content: string; isError?: boolean } | void
  beforeCompact?(input: {
    conversationId: number
    taskId: number
    messages: readonly DurableMessage[]
    instructions?: string
  }): Promise<{ decline: true } | { summary: string } | void> | { decline: true } | { summary: string } | void
}

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
  stream?(input: {
    messages: readonly DurableMessage[]
    modelId: string
    signal: AbortSignal
    onPartial: (text: string) => void | Promise<void>
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
    ctx: {
      signal: AbortSignal
      taskId: number
      call(name: string, args: JsonObject): Promise<{ content: string; isError: boolean }>
      spawn(input: { content: string }): Promise<
        { status: 'done'; text: string } | { status: 'unanswered'; reason: string }
      >
    },
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

export type DurableConversationRow = {
  id: number
  parentConversationId?: number
  atEntryId?: number
  ownerTaskId?: number
}

export type DurableEntryRow = {
  id: number
  conversationId: number
  kind: 'system' | 'user' | 'assistant' | 'tool' | 'compact'
  message: DurableMessage
  boundaryId?: number
}

export type DurableTaskStatus = 'pending' | 'running' | 'waiting' | 'sleeping' | 'terminal'
export type DurableTaskOutcome = 'completed' | 'failed' | 'faulted' | 'aborted'

export type DurableTaskRow = {
  id: number
  name: 'generation' | 'tool' | 'compaction'
  conversationId: number
  parentTaskId?: number
  nested?: boolean
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
