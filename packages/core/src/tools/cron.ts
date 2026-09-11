import { formatSchedule, nextFireAt as computeNextFireAt, parseJobSpec } from '../schedule/cron'
import { newCronId } from '../schedule/store'
import type { CronJob, CronStore } from '../schedule/types'
import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export interface CronCreateInput {
  spec: string
  prompt: string
  name?: string
}

export interface CronDeleteInput {
  id: string
}

export interface CronSetEnabledInput {
  id: string
  enabled: boolean
}

export type CronListInput = Record<string, never>

const createSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['spec', 'prompt'],
  properties: {
    spec: { type: 'string', minLength: 1 },
    prompt: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
  },
}

const listSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

const deleteSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1 },
  },
}

const setEnabledSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'enabled'],
  properties: {
    id: { type: 'string', minLength: 1 },
    enabled: { type: 'boolean' },
  },
}

export function createCronTools(store: CronStore): {
  create: Tool
  list: Tool
  remove: Tool
  setEnabled: Tool
} {
  const create: Tool<CronCreateInput, string> = {
    name: 'CronCreate',
    description:
      'Create a local scheduled job. spec is every 30s/5m/2h, a 5-field UTC cron, or @hourly/@daily. prompt runs in a new session when the job fires. Optional name labels the job.',
    inputSchema: createSchema,
    parse(input: unknown) {
      return parseWithSchema<CronCreateInput>(createSchema, input)
    },
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return false
    },
    interruptBehavior() {
      return 'block'
    },
    async checkPermissions() {
      return { behavior: 'ask', message: 'Create this scheduled job?', saveAs: 'session' }
    },
    async execute(input: CronCreateInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      const parsed = parseJobSpec(input.spec)
      if (!parsed.ok) return `CronCreate failed: ${parsed.message}`

      let fireAt: number
      try {
        fireAt = computeNextFireAt(parsed.schedule, Date.now())
      } catch (error) {
        return `CronCreate failed: ${errorMessage(error)}`
      }

      const now = Date.now()
      const job: CronJob = {
        id: newCronId(),
        name: input.name ?? input.prompt,
        enabled: true,
        cwd: ctx.turn.projectCwd ?? ctx.turn.cwd,
        prompt: input.prompt,
        schedule: parsed.schedule,
        nextFireAt: fireAt,
        createdAt: now,
      }
      store.upsert(job)
      return `created ${formatJobLine(job)}`
    },
  }

  const list: Tool<CronListInput, string> = {
    name: 'CronList',
    description: 'List local scheduled jobs as id, on/off, schedule, and prompt.',
    inputSchema: listSchema,
    parse(input: unknown) {
      return parseWithSchema<CronListInput>(listSchema, input)
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
    async execute(_input: CronListInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      const jobs = store.list()
      if (jobs.length === 0) return 'no jobs'
      return jobs.map(formatJobLine).join('\n')
    },
  }

  const remove: Tool<CronDeleteInput, string> = {
    name: 'CronDelete',
    description: 'Delete a local scheduled job by id from CronList.',
    inputSchema: deleteSchema,
    parse(input: unknown) {
      return parseWithSchema<CronDeleteInput>(deleteSchema, input)
    },
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return false
    },
    interruptBehavior() {
      return 'block'
    },
    async checkPermissions() {
      return { behavior: 'ask', message: 'Delete this scheduled job?', saveAs: 'session' }
    },
    async execute(input: CronDeleteInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      const job = store.remove(input.id)
      if (!job) return `CronDelete failed: unknown job ${input.id}`
      return `deleted ${job.id}`
    },
  }

  const setEnabled: Tool<CronSetEnabledInput, string> = {
    name: 'CronSetEnabled',
    description: 'Enable or disable a local scheduled job by id without changing its schedule.',
    inputSchema: setEnabledSchema,
    parse(input: unknown) {
      return parseWithSchema<CronSetEnabledInput>(setEnabledSchema, input)
    },
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return false
    },
    interruptBehavior() {
      return 'block'
    },
    async checkPermissions() {
      return { behavior: 'ask', message: 'Change this scheduled job?', saveAs: 'session' }
    },
    async execute(input: CronSetEnabledInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      const job = store.get(input.id)
      if (!job) return `CronSetEnabled failed: unknown job ${input.id}`
      const next = { ...job, enabled: input.enabled }
      store.upsert(next)
      return `${input.enabled ? 'enabled' : 'disabled'} ${next.id}`
    },
  }

  return { create, list, remove, setEnabled }
}

function formatJobLine(job: CronJob): string {
  const flag = job.enabled ? 'on' : 'off'
  return `${job.id}  ${flag}  ${formatSchedule(job.schedule)}  ${job.prompt}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
