import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export interface SuggestFollowup {
  prompt: string
  label?: string
}

export interface SuggestFollowupsInput {
  followups: SuggestFollowup[]
}

const DEFAULT_LABEL_CHARS = 40

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['followups'],
  properties: {
    followups: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', minLength: 1 },
          label: { type: 'string' },
        },
      },
    },
  },
}

export function formatSuggestFollowups(input: SuggestFollowupsInput): string {
  return input.followups
    .map((item) => {
      const label =
        item.label !== undefined && item.label !== ''
          ? item.label
          : item.prompt.slice(0, DEFAULT_LABEL_CHARS)
      return `${label}: ${item.prompt}`
    })
    .join('\n')
}

export function parseFollowupLines(text: string): Array<{ label: string; prompt: string }> {
  const out: Array<{ label: string; prompt: string }> = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const idx = line.indexOf(': ')
    if (idx === -1) {
      out.push({ label: line, prompt: line })
      continue
    }
    out.push({ label: line.slice(0, idx), prompt: line.slice(idx + 2) })
  }
  return out
}

export const suggestFollowupsTool: Tool<SuggestFollowupsInput, string> = {
  name: 'SuggestFollowups',
  description:
    'Propose short follow-up prompts the host can offer the user. Each item is { prompt, label? }. label defaults to the first 40 characters of prompt. Returns one "label: prompt" line per item.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<SuggestFollowupsInput>(inputSchema, input)
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  interruptBehavior() {
    return 'cancel'
  },
  async checkPermissions() {
    return { behavior: 'allow', reason: 'mode' }
  },
  async execute(input: SuggestFollowupsInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    return formatSuggestFollowups(input)
  },
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
