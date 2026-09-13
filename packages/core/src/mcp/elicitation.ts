import type { AskUserInput } from '../tools/ask-user'
import type { McpElicitField, McpElicitFn, McpElicitParams, McpElicitResult } from './types'

export const MCP_ELICIT_TIMEOUT_MS = 120_000

export function parseMcpElicitParams(raw: unknown): McpElicitParams | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const rec = raw as {
    mode?: unknown
    message?: unknown
    requestedSchema?: unknown
    url?: unknown
  }
  if (rec.mode === 'url') return undefined
  if (typeof rec.url === 'string' && rec.url.length > 0 && rec.mode !== 'form') return undefined
  if (rec.mode !== undefined && rec.mode !== 'form') return undefined
  const schema = rec.requestedSchema
  if (!schema || typeof schema !== 'object') return undefined
  const sch = schema as { type?: unknown; properties?: unknown; required?: unknown }
  if (sch.type !== undefined && sch.type !== 'object') return undefined
  if (!sch.properties || typeof sch.properties !== 'object' || Array.isArray(sch.properties)) {
    return undefined
  }
  const properties: Record<string, McpElicitField> = {}
  for (const [key, value] of Object.entries(sch.properties as Record<string, unknown>)) {
    const field = parseField(value)
    if (!field) return undefined
    properties[key] = field
  }
  if (Object.keys(properties).length === 0) return undefined
  const required = Array.isArray(sch.required)
    ? sch.required.filter((item): item is string => typeof item === 'string')
    : undefined
  const params: McpElicitParams = {
    message: typeof rec.message === 'string' ? rec.message : '',
    requestedSchema: { type: 'object', properties },
  }
  if (required !== undefined && required.length > 0) params.requestedSchema.required = required
  return params
}

export function mcpElicitToAskUser(params: McpElicitParams): AskUserInput {
  const names = Object.keys(params.requestedSchema.properties)
  return {
    questions: names.map((name, index) => {
      const field = params.requestedSchema.properties[name]
      const question = field?.title ?? field?.description ?? name
      const header = index === 0 && params.message !== '' ? params.message : undefined
      if (field?.type === 'boolean' && field.enum === undefined) {
        return {
          question,
          ...(header !== undefined ? { header } : {}),
          options: [{ label: 'Yes' }, { label: 'No' }],
        }
      }
      if (field?.enum !== undefined && field.enum.length > 0) {
        return {
          question,
          ...(header !== undefined ? { header } : {}),
          options: field.enum.map((value) => ({ label: String(value) })),
        }
      }
      return {
        question,
        ...(header !== undefined ? { header } : {}),
        options: [],
        freeText: true,
      }
    }),
  }
}

export function askUserTextToElicitContent(
  params: McpElicitParams,
  text: string,
): McpElicitResult {
  const names = Object.keys(params.requestedSchema.properties)
  const required = new Set(params.requestedSchema.required ?? [])
  const values: Array<string | undefined> = names.map(() => undefined)
  for (const line of text.split('\n')) {
    const match = /^Q(\d+):\s*(.*)$/.exec(line.trim())
    if (!match?.[1]) continue
    const idx = Number(match[1]) - 1
    if (idx >= 0 && idx < names.length) values[idx] = match[2]
  }
  const content: Record<string, string | number | boolean> = {}
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    if (name === undefined) continue
    const field = params.requestedSchema.properties[name]
    if (!field) continue
    const raw = values[i]
    if (raw === undefined || raw === '') {
      if (required.has(name)) return { action: 'cancel' }
      continue
    }
    const converted = convertField(field, raw)
    if (converted === undefined) return { action: 'cancel' }
    content[name] = converted
  }
  return { action: 'accept', content }
}

export async function runMcpElicit(
  raw: unknown,
  elicit: McpElicitFn | undefined,
  timeoutMs = MCP_ELICIT_TIMEOUT_MS,
): Promise<McpElicitResult> {
  const params = parseMcpElicitParams(raw)
  if (!params || !elicit) return { action: 'cancel' }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await new Promise<McpElicitResult>((resolve) => {
      const onAbort = () => resolve({ action: 'cancel' })
      if (ac.signal.aborted) {
        onAbort()
        return
      }
      ac.signal.addEventListener('abort', onAbort, { once: true })
      void Promise.resolve(elicit(params, ac.signal)).then(
        (value) => {
          ac.signal.removeEventListener('abort', onAbort)
          resolve(normalizeResult(value))
        },
        () => {
          ac.signal.removeEventListener('abort', onAbort)
          resolve({ action: 'cancel' })
        },
      )
    })
  } finally {
    clearTimeout(timer)
  }
}

function parseField(value: unknown): McpElicitField | undefined {
  if (!value || typeof value !== 'object') return undefined
  const rec = value as {
    type?: unknown
    title?: unknown
    description?: unknown
    enum?: unknown
  }
  if (
    rec.type !== 'string' &&
    rec.type !== 'number' &&
    rec.type !== 'integer' &&
    rec.type !== 'boolean'
  ) {
    return undefined
  }
  const field: McpElicitField = { type: rec.type }
  if (typeof rec.title === 'string') field.title = rec.title
  if (typeof rec.description === 'string') field.description = rec.description
  if (Array.isArray(rec.enum)) {
    const values = rec.enum.filter(
      (item): item is string | number => typeof item === 'string' || typeof item === 'number',
    )
    if (values.length > 0) field.enum = values
  }
  return field
}

function convertField(
  field: McpElicitField,
  raw: string,
): string | number | boolean | undefined {
  if (field.type === 'boolean') {
    const needle = raw.toLowerCase()
    if (needle === 'yes' || needle === 'true') return true
    if (needle === 'no' || needle === 'false') return false
    return undefined
  }
  if (field.type === 'number' || field.type === 'integer') {
    const num = Number(raw)
    if (!Number.isFinite(num)) return undefined
    if (field.type === 'integer' && !Number.isInteger(num)) return undefined
    if (field.enum && !field.enum.some((value) => Number(value) === num)) return undefined
    return num
  }
  if (field.enum && !field.enum.some((value) => String(value) === raw)) return undefined
  return raw
}

function normalizeResult(value: McpElicitResult): McpElicitResult {
  if (value.action === 'accept') return value
  if (value.action === 'decline') return { action: 'decline' }
  return { action: 'cancel' }
}
