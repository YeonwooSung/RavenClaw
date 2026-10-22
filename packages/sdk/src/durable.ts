import { basename, normalize } from 'node:path'
import {
  bashTool,
  decidePermission,
  editTool,
  globTool,
  grepTool,
  readTool,
  writeTool,
  type PermissionMode,
  type Provider,
  type ProviderChunk,
  type SystemPart,
  type Tool,
  type ToolContext,
  type Turn,
} from '@ravenclaw/core'
import { markReadPath } from '../../core/src/tools/read-files.ts'
import {
  DurableClosed,
  openDurable,
  openSqliteStorage,
  type DurableMessage,
  type DurableModel,
  type DurableStorage,
  type DurableSubmission,
  type DurableTool,
  type DurableToolCall,
  type JsonObject,
} from '@ravenclaw/durable'

export interface CreateDurableSessionOptions {
  path: string
  cwd: string
  provider: Provider
  model: string
  systemPrompt?: string
  permissionMode?: PermissionMode
}

export interface DurableRavenSession {
  submit(input: { content: string; requestId?: string }): Promise<DurableSubmission>
  resume(): Promise<void>
  close(): Promise<void>
}

export interface DurableToolSink {
  abandon: () => void
}

const EMPTY_RULES = { session: [], user: [], project: [] }

export async function createDurableSession(opts: CreateDurableSessionOptions): Promise<DurableRavenSession> {
  return openDurableSession(opts, defaultTools())
}

export async function openDurableSession(
  opts: CreateDurableSessionOptions,
  tools: readonly Tool[],
  sink?: DurableToolSink,
): Promise<DurableRavenSession> {
  rejectSessionDatabasePath(opts.path)
  const mode = opts.permissionMode ?? 'dontAsk'
  const turn = makeTurn(opts.cwd, opts.model, mode)
  const storage = await openSqliteStorage(opts.path)
  const runtime = await openDurable(storage, {
    model: modelFromProvider(opts.provider, opts.model, tools),
    tools: tools.map((tool) => toDurableTool(tool, turn, mode)),
    modelId: opts.model,
    ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
  })
  if (sink) sink.abandon = () => runtime.abandon()
  rebuildReads(storage, turn)
  await runtime.resume()
  const conversation = await runtime.root()
  let closed = false
  return {
    submit(input) {
      return conversation.submit(input)
    },
    resume() {
      return runtime.resume()
    },
    async close() {
      if (closed) return
      closed = true
      try {
        await runtime.close()
      } catch (error) {
        if (!(error instanceof DurableClosed)) throw error
      }
      storage.close()
    },
  }
}

export function rejectSessionDatabasePath(path: string): void {
  if (path.trim() === '') throw new Error('durable session path is empty')
  if (basename(normalize(path)) === 'state.db') {
    throw new Error('durable session path must not be state.db')
  }
}

export async function collectProviderStream(
  provider: Provider,
  model: string,
  messages: readonly DurableMessage[],
  tools: readonly Tool[],
  signal: AbortSignal,
): Promise<{ content: string; toolCalls?: DurableToolCall[]; stopReason: 'stop' | 'toolUse' }> {
  const request = toProviderRequest(provider, model, messages, tools)
  let content = ''
  const toolCalls: DurableToolCall[] = []
  let sawChunk = false
  for await (const chunk of provider.stream(request, signal)) {
    sawChunk = true
    if (chunk.type === 'text_delta') content += chunk.text
    else if (chunk.type === 'tool_call') toolCalls.push(toolCallFromChunk(chunk))
  }
  if (!sawChunk) throw new Error('empty model response')
  if (toolCalls.length > 0) return { content, toolCalls, stopReason: 'toolUse' }
  return { content, stopReason: 'stop' }
}

function modelFromProvider(provider: Provider, model: string, tools: readonly Tool[]): DurableModel {
  return {
    complete(input) {
      return collectProviderStream(provider, model, input.messages, tools, input.signal)
    },
  }
}

function toProviderRequest(
  provider: Provider,
  model: string,
  messages: readonly DurableMessage[],
  tools: readonly Tool[],
) {
  const profile = provider.profile(model)
  const systemText = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const system: SystemPart[] = systemText.length > 0 ? [{ tier: 'stable', text: systemText }] : []
  let next = 0
  const id = () => {
    next += 1
    return `durable-msg-${next}`
  }
  return {
    model,
    system,
    messages: messages.flatMap((message) => {
      if (message.role === 'system') return []
      if (message.role === 'user') {
        return [{ id: id(), role: 'user' as const, blocks: [{ type: 'text' as const, text: message.content }], createdAt: 0 }]
      }
      if (message.role === 'assistant') {
        const blocks = [
          ...(message.content.length > 0 ? [{ type: 'text' as const, text: message.content }] : []),
          ...(message.toolCalls ?? []).map((call) => ({
            type: 'tool_use' as const,
            id: call.id,
            name: call.name,
            input: call.arguments,
          })),
        ]
        return [
          {
            id: id(),
            role: 'assistant' as const,
            blocks: blocks.length > 0 ? blocks : [{ type: 'text' as const, text: '' }],
            createdAt: 0,
          },
        ]
      }
      return [
        {
          id: id(),
          role: 'tool' as const,
          toolUseId: message.toolCallId,
          ok: !message.isError,
          blocks: [{ type: 'text' as const, text: message.content }],
          createdAt: 0,
        },
      ]
    }),
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    maxTokens: profile.reserveOutputTokens,
  }
}

function toolCallFromChunk(chunk: Extract<ProviderChunk, { type: 'tool_call' }>) {
  if (!isJsonObject(chunk.input)) throw new Error('tool input was not a JSON object')
  return { id: chunk.id, name: chunk.name, arguments: chunk.input }
}

function toDurableTool(tool: Tool, turn: Turn, mode: PermissionMode): DurableTool {
  return {
    name: tool.name,
    replay: tool.isReadOnly(undefined as never) ? 'safe' : 'unsafe',
    async execute(args, ctx) {
      const parsed = tool.parse(args)
      if (!parsed.ok) throw new Error(parsed.message)
      const decision = await decidePermission({
        tool,
        name: tool.name,
        input: parsed.value,
        ctx: toolContext(turn, ctx.signal),
        mode,
        rules: EMPTY_RULES,
      })
      if (decision.behavior !== 'allow') return { content: 'permission_denied', isError: true }
      const value = await tool.execute(parsed.value, toolContext(turn, ctx.signal))
      const content = typeof value === 'string' ? value : String(value)
      if (tool.name === 'Read' && typeof args.path === 'string' && args.path.length > 0) {
        markReadPath(turn, args.path)
      }
      return { content, isError: false }
    },
  }
}

function rebuildReads(storage: DurableStorage, turn: Turn): void {
  const pending = new Map<string, string>()
  for (const entry of storage.readEntries(1)) {
    const message = entry.message
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        if (call.name !== 'Read') continue
        const path = call.arguments.path
        if (typeof path === 'string' && path.length > 0) pending.set(call.id, path)
      }
    }
    if (message.role === 'tool' && !message.isError) {
      const path = pending.get(message.toolCallId)
      if (path !== undefined) markReadPath(turn, path)
    }
  }
}

function toolContext(turn: Turn, signal: AbortSignal): ToolContext {
  return { turn, signal, onProgress() {} }
}

function makeTurn(cwd: string, model: string, permissionMode: PermissionMode): Turn {
  return {
    id: 'durable-turn',
    sessionId: 'durable-session',
    messages: [],
    round: 1,
    maxRounds: 1,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd,
    model,
    readFiles: new Set(),
  }
}

function defaultTools(): Tool[] {
  return [readTool, writeTool, editTool, globTool, grepTool, bashTool] as Tool[]
}

function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
