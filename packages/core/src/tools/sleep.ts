import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export interface SleepInput {
  seconds: number
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['seconds'],
  properties: {
    seconds: { type: 'number', minimum: 0.1, maximum: 60 },
  },
}

export const sleepTool: Tool<SleepInput, string> = {
  name: 'Sleep',
  description:
    'Pause the turn for a number of seconds (0.1–60). Aborts immediately if the turn is cancelled.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<SleepInput>(inputSchema, input)
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
  async execute(input: SleepInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    await sleepMs(input.seconds * 1000, ctx.signal)
    return `slept ${input.seconds}s`
  },
}

function sleepMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
