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

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const ANTHROPIC_VERSION = '2023-06-01'

export interface AnthropicMessagesProviderOptions {
  apiKey: string
  baseUrl?: string
  defaultModel?: string
}

export class AnthropicMessagesProvider implements Provider {
  readonly id = 'anthropic'
  readonly apiMode = 'anthropic_messages' as const

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly defaultModel?: string

  constructor(opts: AnthropicMessagesProviderOptions) {
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
      max_tokens: req.maxTokens,
      stream: true,
      messages: buildAnthropicMessages(req.messages, includeThinking),
    }
    if (req.system.length > 0) payload.system = mapAnthropicSystem(req.system)
    if (req.tools.length > 0) payload.tools = req.tools.map(toAnthropicTool)

    const response = await fetchWithSingleRetry(
      joinUrl(this.baseUrl, '/v1/messages'),
      {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
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
    const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const blocks = new Map<number, BlockState>()

    const flushUsage = (): ProviderChunk | undefined => {
      if (usageYielded) return undefined
      if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) {
        return undefined
      }
      usageYielded = true
      return { type: 'usage', usage: { ...usage } }
    }

    try {
      for await (const event of iterateSse(response.body, (n) => {
        bytes += n
      })) {
        if (signal.aborted) throw abortLike()
        const parsed = tryParseJson(event.data)
        if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') continue
        const body = parsed.value as AnthropicEvent
        const type = body.type || event.event

        if (type === 'ping') continue

        if (type === 'error') {
          const err = asRecord(body.error)
          const errType = typeof err?.type === 'string' ? err.type : ''
          const message = typeof err?.message === 'string' ? err.message : 'anthropic error'
          throw new ProviderError(message, {
            retryable: errType === 'overloaded_error' || errType === 'api_error',
          })
        }

        if (type === 'message_start') {
          const msg = asRecord(body.message)
          applyUsage(usage, asRecord(msg?.usage))
          continue
        }

        if (type === 'content_block_start') {
          const index = body.index ?? 0
          const block = asRecord(body.content_block)
          const state: BlockState = {
            type: typeof block?.type === 'string' ? block.type : 'text',
            id: typeof block?.id === 'string' ? block.id : '',
            name: typeof block?.name === 'string' ? block.name : '',
            json: '',
            emitted: false,
          }
          if (state.type === 'tool_use' && block && 'input' in block && block.input !== undefined) {
            const seeded = block.input
            if (seeded && typeof seeded === 'object' && !Array.isArray(seeded) && Object.keys(seeded).length > 0) {
              state.json = JSON.stringify(seeded)
            }
          }
          blocks.set(index, state)
          continue
        }

        if (type === 'content_block_delta') {
          const index = body.index ?? 0
          const delta = asRecord(body.delta)
          const deltaType = typeof delta?.type === 'string' ? delta.type : ''
          if (deltaType === 'text_delta' && typeof delta?.text === 'string' && delta.text !== '') {
            yield { type: 'text_delta', text: delta.text }
          } else if (
            deltaType === 'thinking_delta' &&
            typeof delta?.thinking === 'string' &&
            delta.thinking !== ''
          ) {
            yield { type: 'thinking_delta', text: delta.thinking }
          } else if (deltaType === 'input_json_delta' && typeof delta?.partial_json === 'string') {
            const state = blocks.get(index)
            if (state) {
              state.json += delta.partial_json
              const call = completeTool(state)
              if (call) yield call
            }
          }
          continue
        }

        if (type === 'content_block_stop') {
          const state = blocks.get(body.index ?? 0)
          if (state) {
            const call = completeTool(state)
            if (call) yield call
          }
          continue
        }

        if (type === 'message_delta') {
          const delta = asRecord(body.delta)
          if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason
          applyUsage(usage, asRecord(body.usage))
          continue
        }

        if (type === 'message_stop') {
          const usageChunk = flushUsage()
          if (usageChunk) yield usageChunk
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

    const usageChunk = flushUsage()
    if (usageChunk) yield usageChunk
    if (!stopped) yield { type: 'stop', reason: stopReason }
  }
}

interface AnthropicEvent {
  type?: string
  index?: number
  delta?: unknown
  usage?: unknown
  message?: unknown
  content_block?: unknown
  error?: unknown
}

interface BlockState {
  type: string
  id: string
  name: string
  json: string
  emitted: boolean
}

function abortLike(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function mapAnthropicSystem(parts: SystemPart[]): unknown[] {
  return parts.map((part) => {
    const block: Record<string, unknown> = { type: 'text', text: part.text }
    if (part.cacheBreakpoint === true) block.cache_control = { type: 'ephemeral' }
    return block
  })
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

function anthropicImagePart(block: { mediaType: string; data: string }): unknown {
  return {
    type: 'image',
    source: { type: 'base64', media_type: block.mediaType, data: block.data },
  }
}

function mapAnthropicUserContent(
  blocks: Array<{ type: string; text?: string; mediaType?: string; data?: string }>,
): unknown[] {
  const content: unknown[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text })
    } else if (isImageBlock(block)) {
      content.push(anthropicImagePart(block))
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return content
}

function mapAnthropicToolContent(
  blocks: Array<{ type: string; text?: string; mediaType?: string; data?: string }>,
): string | unknown[] {
  const hasImage = blocks.some((block) => isImageBlock(block))
  if (!hasImage) return joinText(blocks)
  const content: unknown[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text })
    } else if (isImageBlock(block)) {
      content.push(anthropicImagePart(block))
    }
  }
  return content
}

function joinText(blocks: Array<{ type: string; text?: string }>): string {
  let out = ''
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

function buildAnthropicMessages(messages: Message[], includeThinking: boolean): unknown[] {
  const out: unknown[] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]
    if (!msg) break
    if (msg.role === 'tool') {
      const results: unknown[] = []
      while (i < messages.length) {
        const tool = messages[i]
        if (!tool || tool.role !== 'tool') break
        results.push({
          type: 'tool_result',
          tool_use_id: tool.toolUseId,
          content: mapAnthropicToolContent(tool.blocks),
          is_error: !tool.ok,
        })
        i += 1
      }
      out.push({ role: 'user', content: results })
      continue
    }
    if (msg.role === 'user') {
      out.push({
        role: 'user',
        content: mapAnthropicUserContent(msg.blocks),
      })
      i += 1
      continue
    }
    if (isEmptyAssistantMessage(msg)) {
      i += 1
      continue
    }
    const content: unknown[] = []
    for (const block of msg.blocks) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text })
      else if (block.type === 'thinking') {
        if (includeThinking) content.push({ type: 'thinking', thinking: block.text })
      } else if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        })
      }
    }
    out.push({ role: 'assistant', content })
    i += 1
  }
  return out
}

function isEmptyAssistantMessage(msg: Extract<Message, { role: 'assistant' }>): boolean {
  return !msg.blocks.some(
    (block) =>
      block.type === 'tool_use' ||
      (block.type === 'thinking' && block.text !== '') ||
      (block.type === 'text' && block.text.trim() !== ''),
  )
}

function toAnthropicTool(tool: { name: string; description: string; inputSchema: unknown }): unknown {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

function completeTool(state: BlockState): Extract<ProviderChunk, { type: 'tool_call' }> | undefined {
  if (state.type !== 'tool_use' || state.emitted || state.id === '' || state.name === '') return undefined
  if (state.json === '') return undefined
  const parsed = tryParseJson(state.json)
  if (!parsed.ok) return undefined
  state.emitted = true
  return { type: 'tool_call', id: state.id, name: state.name, input: parsed.value }
}

function applyUsage(target: TokenUsage, raw: Record<string, unknown> | undefined): void {
  if (!raw) return
  const input = num(raw.input_tokens)
  const output = num(raw.output_tokens)
  const cacheRead = num(raw.cache_read_input_tokens)
  const cacheWrite = num(raw.cache_creation_input_tokens)
  if (input !== undefined) target.input = input
  if (output !== undefined) target.output = output
  if (cacheRead !== undefined) target.cacheRead = cacheRead
  if (cacheWrite !== undefined) target.cacheWrite = cacheWrite
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
