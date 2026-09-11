import type {
  Message,
  ModelProfile,
  Provider,
  ProviderChunk,
  ProviderRequest,
  SystemPart,
  TokenUsage,
} from '@ravenclaw/core'
import { getModelProfile } from '@ravenclaw/core'
import {
  fetchWithSingleRetry,
  isAbortError,
  iterateSse,
  joinUrl,
  ProviderError,
  streamDroppedError,
  throwForHttpError,
  tryParseJson,
} from './errors'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
// Default Responses model when the request omits one. gpt-4.1 is the
// current general-purpose Responses-capable chat model.
const DEFAULT_MODEL = 'gpt-4.1'

export interface OpenAIResponsesProviderOptions {
  apiKey: string
  baseUrl?: string
  defaultModel?: string
}

export class OpenAIResponsesProvider implements Provider {
  readonly id = 'openai_responses'
  readonly apiMode = 'openai_responses' as const

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly defaultModel: string

  constructor(opts: OpenAIResponsesProviderOptions) {
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL
  }

  profile(model: string): ModelProfile {
    return getModelProfile(model)
  }

  async *stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    const model = req.model || this.defaultModel
    const includeThinking = this.profile(model).supportsThinking
    const payload: Record<string, unknown> = {
      model,
      input: buildResponsesInput(req.messages, includeThinking),
      stream: true,
    }
    if (req.maxTokens > 0) payload.max_output_tokens = req.maxTokens
    if (req.system.length > 0) payload.instructions = joinSystem(req.system)
    if (req.tools.length > 0) payload.tools = req.tools.map(toResponsesTool)

    const response = await fetchWithSingleRetry(
      joinUrl(this.baseUrl, '/responses'),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal,
      },
      signal,
    )
    if (!response.ok) await throwForHttpError(response)
    if (!response.body) throw streamDroppedError(0)

    let bytes = 0
    let stopReason: string | null = null
    let stopped = false
    let usageYielded = false
    const pending = new Map<string, PendingFunctionCall>()

    try {
      for await (const event of iterateSse(response.body, (n) => {
        bytes += n
      })) {
        if (signal.aborted) throw abortLike()
        if (event.data === '[DONE]') {
          if (!stopped) {
            stopped = true
            yield { type: 'stop', reason: stopReason }
          }
          return
        }
        const parsed = tryParseJson(event.data)
        if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') continue
        const body = parsed.value as ResponsesEvent
        const type = body.type || event.event

        if (type === 'response.failed' || type === 'error') {
          const err = asRecord(body.error) ?? asRecord(body.response)
          const message =
            typeof err?.message === 'string'
              ? err.message
              : typeof err?.error === 'string'
                ? err.error
                : 'responses error'
          throw new ProviderError(message, { retryable: false })
        }

        if (type === 'response.output_text.delta' || type === 'response.text.delta') {
          const text = typeof body.delta === 'string' ? body.delta : typeof body.text === 'string' ? body.text : ''
          if (text !== '') yield { type: 'text_delta', text }
          continue
        }

        if (type === 'response.output_item.added' || type === 'response.output_item.done') {
          const item = asRecord(body.item)
          if (item && item.type === 'function_call') {
            const call = upsertFunctionCall(pending, item, body.item_id)
            const complete = completeFunctionCall(call)
            if (complete) yield complete
          }
          continue
        }

        if (type === 'response.function_call_arguments.delta') {
          const call = pendingByItem(pending, body.item_id)
          if (call && typeof body.delta === 'string') {
            call.arguments += body.delta
            const complete = completeFunctionCall(call)
            if (complete) yield complete
          }
          continue
        }

        if (type === 'response.function_call_arguments.done') {
          const call = pendingByItem(pending, body.item_id)
          if (call) {
            if (typeof body.arguments === 'string') call.arguments = body.arguments
            const complete = completeFunctionCall(call)
            if (complete) yield complete
          }
          continue
        }

        if (type === 'response.completed' || type === 'response.incomplete') {
          const resp = asRecord(body.response)
          if (typeof resp?.status === 'string') stopReason = resp.status
          else if (type === 'response.incomplete') stopReason = 'incomplete'
          else stopReason = 'completed'
          const usage = mapResponsesUsage(asRecord(resp?.usage) ?? asRecord(body.usage))
          if (usage && !usageYielded) {
            usageYielded = true
            yield { type: 'usage', usage }
          }
          if (!stopped) {
            stopped = true
            yield { type: 'stop', reason: stopReason }
          }
          return
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error
      if (isAbortError(error) || signal.aborted) throw error
      throw streamDroppedError(bytes)
    }

    if (!stopped) yield { type: 'stop', reason: stopReason }
  }
}

interface ResponsesEvent {
  type?: string
  delta?: unknown
  text?: unknown
  item?: unknown
  item_id?: unknown
  arguments?: unknown
  error?: unknown
  response?: unknown
  usage?: unknown
}

interface PendingFunctionCall {
  itemId: string
  id: string
  name: string
  arguments: string
  emitted: boolean
}

function abortLike(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function joinSystem(parts: SystemPart[]): string {
  let text = ''
  for (const part of parts) text += part.text
  return text
}

function joinText(
  blocks: Array<{ type: string; text?: string }>,
  includeThinking: boolean,
): string {
  let out = ''
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
    else if (includeThinking && block.type === 'thinking' && typeof block.text === 'string') {
      out += block.text
    }
  }
  return out
}

function mapResponsesUserContent(
  blocks: Array<{ type: string; text?: string; mediaType?: string; data?: string }>,
): string | unknown[] {
  const parts: unknown[] = []
  let hasImage = false
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'input_text', text: block.text })
    } else if (isImageBlock(block)) {
      hasImage = true
      parts.push({
        type: 'input_image',
        image_url: `data:${block.mediaType};base64,${block.data}`,
      })
    }
  }
  if (!hasImage) return joinText(blocks, false)
  return parts
}

function isImageBlock(block: {
  type: string
  mediaType?: string
  data?: string
}): block is { type: 'image'; mediaType: string; data: string } {
  return (
    block.type === 'image' &&
    typeof block.mediaType === 'string' &&
    block.mediaType.length > 0 &&
    typeof block.data === 'string' &&
    block.data.length > 0
  )
}

function buildResponsesInput(messages: Message[], includeThinking: boolean): unknown[] {
  const out: unknown[] = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: mapResponsesUserContent(msg.blocks) })
      continue
    }
    if (msg.role === 'tool') {
      out.push({
        type: 'function_call_output',
        call_id: msg.toolUseId,
        output: joinText(msg.blocks, false),
      })
      continue
    }
    const text = joinText(msg.blocks, includeThinking)
    if (text.length > 0) out.push({ role: 'assistant', content: text })
    for (const block of msg.blocks) {
      if (block.type === 'tool_use') {
        out.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        })
      }
    }
  }
  return out
}

function toResponsesTool(tool: { name: string; description: string; inputSchema: unknown }): unknown {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }
}

function pendingKey(itemId: unknown, fallback: string): string {
  return typeof itemId === 'string' && itemId.length > 0 ? itemId : fallback
}

function upsertFunctionCall(
  pending: Map<string, PendingFunctionCall>,
  item: Record<string, unknown>,
  eventItemId: unknown,
): PendingFunctionCall {
  const itemId = pendingKey(
    typeof item.id === 'string' ? item.id : eventItemId,
    typeof item.call_id === 'string' ? item.call_id : `fn_${pending.size}`,
  )
  let slot = pending.get(itemId)
  if (!slot) {
    slot = { itemId, id: '', name: '', arguments: '', emitted: false }
    pending.set(itemId, slot)
  }
  if (typeof item.call_id === 'string' && item.call_id.length > 0) slot.id = item.call_id
  else if (typeof item.id === 'string' && item.id.length > 0 && slot.id === '') slot.id = item.id
  if (typeof item.name === 'string' && item.name.length > 0) slot.name = item.name
  if (typeof item.arguments === 'string' && item.arguments.length > 0) slot.arguments = item.arguments
  return slot
}

function pendingByItem(
  pending: Map<string, PendingFunctionCall>,
  itemId: unknown,
): PendingFunctionCall | undefined {
  if (typeof itemId === 'string' && pending.has(itemId)) return pending.get(itemId)
  if (pending.size === 1) return pending.values().next().value
  return undefined
}

function completeFunctionCall(
  state: PendingFunctionCall,
): Extract<ProviderChunk, { type: 'tool_call' }> | undefined {
  if (state.emitted || state.id === '' || state.name === '' || state.arguments === '') return undefined
  const parsed = tryParseJson(state.arguments)
  if (!parsed.ok) return undefined
  state.emitted = true
  return { type: 'tool_call', id: state.id, name: state.name, input: parsed.value }
}

function mapResponsesUsage(raw: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!raw) return undefined
  const details = asRecord(raw.input_tokens_details)
  const usage: TokenUsage = {
    input: num(raw.input_tokens) ?? num(raw.prompt_tokens) ?? 0,
    output: num(raw.output_tokens) ?? num(raw.completion_tokens) ?? 0,
    cacheRead: num(details?.cached_tokens) ?? num(raw.cache_read_input_tokens) ?? 0,
    cacheWrite: num(details?.cache_write_tokens) ?? num(raw.cache_creation_input_tokens) ?? 0,
  }
  if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) {
    return undefined
  }
  return usage
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
