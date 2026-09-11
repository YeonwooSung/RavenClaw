import type {
  ContentBlock,
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
  streamDroppedError,
  throwForHttpError,
  tryParseJson,
} from './errors'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export interface OpenAICompatProviderOptions {
  apiKey: string
  baseUrl?: string
  defaultModel?: string
  id?: string
}

export class OpenAICompatProvider implements Provider {
  readonly id: string
  readonly apiMode = 'openai_compat' as const

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly defaultModel?: string

  constructor(opts: OpenAICompatProviderOptions) {
    this.id = opts.id ?? 'openai_compat'
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    if (opts.defaultModel !== undefined) this.defaultModel = opts.defaultModel
  }

  profile(model: string): ModelProfile {
    return getModelProfile(model)
  }

  async *stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    const model = req.model || this.defaultModel || req.model
    const includeThinking = this.profile(model).supportsThinking
    const payload: Record<string, unknown> = {
      model,
      messages: buildOpenAIMessages(req.system, req.messages, includeThinking),
      max_tokens: req.maxTokens,
      stream: true,
    }
    if (req.tools.length > 0) payload.tools = req.tools.map(toOpenAITool)

    const response = await fetchWithSingleRetry(
      joinUrl(this.baseUrl, '/chat/completions'),
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
    const pending = new Map<number, PendingToolCall>()

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
        const chunk = parsed.value as OpenAIStreamChunk

        if (chunk.usage) yield { type: 'usage', usage: mapOpenAIUsage(chunk.usage) }

        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        if (delta?.content) yield { type: 'text_delta', text: delta.content }
        if (delta?.reasoning_content) {
          yield { type: 'thinking_delta', text: delta.reasoning_content }
        }

        if (delta?.tool_calls) {
          for (const part of delta.tool_calls) {
            const complete = accumulateOpenAITool(pending, part)
            if (complete) yield complete
          }
        }

        if (choice?.finish_reason != null && choice.finish_reason !== '') {
          stopReason = choice.finish_reason
        }
      }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error
      throw streamDroppedError(bytes)
    }

    if (!stopped) yield { type: 'stop', reason: stopReason }
  }
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: OpenAIToolDelta[]
    }
    finish_reason?: string | null
  }>
  usage?: Record<string, unknown>
}

interface OpenAIToolDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface PendingToolCall {
  id: string
  name: string
  arguments: string
  emitted: boolean
}

function abortLike(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
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

function mapOpenAIMultimodal(
  blocks: Array<{ type: string; text?: string; mediaType?: string; data?: string }>,
): string | unknown[] {
  const parts: unknown[] = []
  let hasImage = false
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    } else if (isImageBlock(block)) {
      hasImage = true
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${block.mediaType};base64,${block.data}` },
      })
    }
  }
  if (!hasImage) return joinText(blocks, false)
  return parts
}

function joinText(blocks: Array<{ type: string; text?: string }>, includeThinking: boolean): string {
  let out = ''
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
    else if (includeThinking && block.type === 'thinking' && typeof block.text === 'string') {
      out += block.text
    }
  }
  return out
}

function buildOpenAIMessages(
  system: SystemPart[],
  messages: Message[],
  includeThinking: boolean,
): unknown[] {
  const out: unknown[] = []
  if (system.length > 0) {
    let text = ''
    for (const part of system) text += part.text
    out.push({ role: 'system', content: text })
  }
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]
    if (!msg) break
    if (msg.role === 'user') {
      out.push({ role: 'user', content: mapOpenAIMultimodal(msg.blocks) })
      i += 1
      continue
    }
    if (msg.role === 'tool') {
      const imageBlocks: Array<{ type: string; text?: string; mediaType?: string; data?: string }> = []
      while (i < messages.length) {
        const tool = messages[i]
        if (!tool || tool.role !== 'tool') break
        out.push({
          role: 'tool',
          tool_call_id: tool.toolUseId,
          content: joinText(tool.blocks, false),
        })
        if (tool.blocks.some(isImageBlock)) imageBlocks.push(...tool.blocks)
        i += 1
      }
      if (imageBlocks.length > 0) {
        out.push({ role: 'user', content: mapOpenAIMultimodal(imageBlocks) })
      }
      continue
    }
    const toolCalls = msg.blocks
      .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function' as const,
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      }))
    const content = joinText(msg.blocks, includeThinking)
    if (toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: content.length > 0 ? content : null,
        tool_calls: toolCalls,
      })
    } else {
      out.push({ role: 'assistant', content })
    }
    i += 1
  }
  return out
}

function toOpenAITool(tool: { name: string; description: string; inputSchema: unknown }): unknown {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }
}

function accumulateOpenAITool(
  pending: Map<number, PendingToolCall>,
  part: OpenAIToolDelta,
): Extract<ProviderChunk, { type: 'tool_call' }> | undefined {
  const index = part.index ?? 0
  let slot = pending.get(index)
  if (!slot) {
    slot = { id: '', name: '', arguments: '', emitted: false }
    pending.set(index, slot)
  }
  if (part.id) slot.id = part.id
  if (part.function?.name) slot.name = part.function.name
  if (part.function?.arguments) slot.arguments += part.function.arguments
  if (slot.emitted || slot.id === '' || slot.name === '') return undefined
  const parsed = tryParseJson(slot.arguments)
  if (!parsed.ok) return undefined
  slot.emitted = true
  return { type: 'tool_call', id: slot.id, name: slot.name, input: parsed.value }
}

function mapOpenAIUsage(usage: Record<string, unknown>): TokenUsage {
  const details = asRecord(usage.prompt_tokens_details)
  return {
    input: num(usage.prompt_tokens) ?? num(usage.input_tokens) ?? 0,
    output: num(usage.completion_tokens) ?? num(usage.output_tokens) ?? 0,
    cacheRead: num(details?.cached_tokens) ?? num(usage.cache_read_input_tokens) ?? 0,
    cacheWrite:
      num(details?.cache_write_tokens) ?? num(usage.cache_creation_input_tokens) ?? 0,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
