import type { CompactPolicy, Message, ModelProfile, Provider } from '../types'

const SUMMARIZE_MAX_TOKENS = 1_024
const SPAN_ITEM_CHARS = 800

const SUMMARIZE_PROMPT = [
  'RavenClaw is compacting a coding-agent transcript.',
  'Write a concise factual summary of the span below.',
  'Preserve user goals, file paths, commands, outcomes, and unfinished work.',
  'Do not invent details. Do not paste raw tool dumps.',
].join(' ')

function textOf(msg: Message): string {
  return msg.blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function mechanicalSummary(messages: Message[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = textOf(msg).trim()
      if (text) lines.push(clip(text, SPAN_ITEM_CHARS))
      continue
    }
    if (msg.role !== 'assistant') continue
    for (const block of msg.blocks) {
      if (block.type !== 'tool_use') continue
      const path = stringField(block.input, 'path')
      const command = stringField(block.input, 'command')
      const pattern = stringField(block.input, 'pattern')
      if (path) lines.push(`${block.name} ${path}`)
      if (command) lines.push(`${block.name} ${command}`)
      if (pattern) lines.push(`${block.name} ${pattern}`)
    }
  }
  return lines.length > 0 ? lines.join('\n') : 'Prior conversation compacted.'
}

function renderSpan(messages: Message[]): string {
  return messages
    .map((msg) => {
      if (msg.role === 'user') return `User: ${clip(textOf(msg), SPAN_ITEM_CHARS)}`
      if (msg.role === 'assistant') {
        const bits: string[] = []
        for (const block of msg.blocks) {
          if (block.type === 'text' && block.text.trim()) bits.push(clip(block.text, SPAN_ITEM_CHARS))
          if (block.type === 'tool_use') {
            const path = stringField(block.input, 'path')
            const command = stringField(block.input, 'command')
            const pattern = stringField(block.input, 'pattern')
            bits.push(
              `${block.name}${path ? ` ${path}` : ''}${command ? ` ${command}` : ''}${pattern ? ` ${pattern}` : ''}`,
            )
          }
        }
        return `Assistant: ${bits.join('; ')}`
      }
      return `Tool: ${clip(textOf(msg), 200)}`
    })
    .join('\n')
}

export async function summarizeSpan(
  messages: Message[],
  provider: Provider,
  model: ModelProfile,
  signal: AbortSignal,
): Promise<string> {
  let text = ''
  for await (const chunk of provider.stream(
    {
      model: model.id,
      system: [{ tier: 'volatile', text: SUMMARIZE_PROMPT }],
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          blocks: [{ type: 'text', text: renderSpan(messages) }],
          createdAt: Date.now(),
        },
      ],
      tools: [],
      maxTokens: SUMMARIZE_MAX_TOKENS,
    },
    signal,
  )) {
    if (chunk.type === 'text_delta') text += chunk.text
  }
  return text.trim()
}

export async function compactSummary(
  messages: Message[],
  compact: CompactPolicy,
  provider: Provider,
  model: ModelProfile,
  signal: AbortSignal,
): Promise<string> {
  if (!compact.llmSummarize) return mechanicalSummary(messages)
  try {
    const text = await summarizeSpan(messages, provider, model, signal)
    if (text) return text
  } catch {
    // LLM summary is optional; mechanical notes are enough.
  }
  return mechanicalSummary(messages)
}
