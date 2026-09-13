import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export interface AskUserOption {
  label: string
  description?: string
}

export interface AskUserQuestion {
  question: string
  header?: string
  options: AskUserOption[]
  multiSelect?: boolean
  /** Host-only free text (MCP elicitation). The AskUser tool schema still requires options. */
  freeText?: boolean
}

export interface AskUserInput {
  questions: AskUserQuestion[]
}

export type AskUserFn = (input: AskUserInput, signal: AbortSignal) => Promise<string>

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'options'],
        properties: {
          question: { type: 'string', minLength: 1 },
          header: { type: 'string' },
          multiSelect: { type: 'boolean' },
          options: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label'],
              properties: {
                label: { type: 'string', minLength: 1 },
                description: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
}

export function formatAskUserPrompt(input: AskUserInput): string {
  return input.questions
    .map((q, index) => {
      const title = q.header !== undefined && q.header !== '' ? `${q.header}: ${q.question}` : q.question
      const multi = q.multiSelect === true ? ' (multi-select)' : ''
      const head = `${index + 1}. ${title}${multi}`
      if (q.freeText === true) return [head, '   (type your answer)'].join('\n')
      const opts = q.options.map((opt, optIndex) => {
        const marker = `${String.fromCharCode(97 + optIndex)})`
        if (opt.description !== undefined && opt.description !== '') {
          return `   ${marker} ${opt.label} — ${opt.description}`
        }
        return `   ${marker} ${opt.label}`
      })
      return [head, ...opts].join('\n')
    })
    .join('\n\n')
}

export function createAskUserTool(ask?: AskUserFn): Tool<AskUserInput, string> {
  return {
    name: 'AskUser',
    description:
      'Ask the user one or more multiple-choice questions and return their answers. Each question needs at least two options. Optional multiSelect allows more than one choice. Hosts that cannot prompt return a formatted question list.',
    inputSchema,
    parse(input: unknown) {
      return parseWithSchema<AskUserInput>(inputSchema, input)
    },
    isEnabled() {
      return ask !== undefined
    },
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return true
    },
    interruptBehavior() {
      return 'block'
    },
    async checkPermissions(input: AskUserInput) {
      const n = input.questions.length
      return {
        behavior: 'ask',
        message: n === 1 ? 'Ask the user a question?' : `Ask the user ${n} questions?`,
        saveAs: 'session',
      }
    },
    async execute(input: AskUserInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      if (ask === undefined) {
        return `AskUser (no host):\n${formatAskUserPrompt(input)}`
      }
      return await ask(input, ctx.signal)
    },
  }
}

export const askUserTool = createAskUserTool()

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
