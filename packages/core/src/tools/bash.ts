import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolContext } from '../types'
import { ravenclawHome } from '../home'
import { parseWithSchema } from './parse'
import { createLocalTerminalBackend } from './terminal-backend'

export interface BashInput {
  command: string
  timeout?: number
}

export interface BashResult {
  content: string
  persistPath?: string
  exitCode: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const PERSIST_LIMIT = 100_000
const PREVIEW_CHARS = 4_000

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['command'],
  properties: {
    command: { type: 'string', minLength: 1 },
    timeout: { type: 'integer', minimum: 1 },
  },
}

export function matchesDangerousPattern(command: string): boolean {
  if (/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(?:\s|$)/.test(command)) return true
  if (/\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\/(?:\s|$)/.test(command)) return true
  if (/\bcurl\b[\s\S]*\|\s*(?:sh|bash)\b/.test(command)) return true
  if (/\bdd\s+if=/.test(command)) return true
  if (/\bmkfs(?:\.\w+)?\b/.test(command)) return true
  if (/:\(\)\s*\{/.test(command) || /:\|:/.test(command)) return true
  return false
}

export const bashTool: Tool<BashInput, BashResult> = {
  name: 'Bash',
  description:
    'Run a command with bash -c in the turn cwd. Optional timeout is milliseconds (default 120000 = 120 seconds). Reports exit code and ending cwd (captured via an in-band marker after the command). Combined output over 100000 characters is written to $RAVENCLAW_HOME/tool-results and only a preview is returned. interruptBehavior is cancel.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<BashInput>(inputSchema, input)
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  interruptBehavior() {
    return 'cancel'
  },
  async checkPermissions(input: BashInput) {
    if (matchesDangerousPattern(input.command)) {
      return { behavior: 'ask', message: 'Command matches a dangerous pattern' }
    }
    return { behavior: 'allow', reason: 'mode' }
  },
  async execute(input: BashInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS
    const backend = createLocalTerminalBackend()
    const result = await backend.exec({
      command: input.command,
      cwd: ctx.turn.cwd,
      timeoutMs,
      signal: ctx.signal,
      onOutput: (text) => {
        ctx.onProgress(text)
      },
    })

    const timedOut = result.exitCode === 124
    const body = formatBody(result.stdout, result.stderr, result.exitCode, result.cwd, timedOut)
    const persisted = persistIfLarge(body, result.exitCode, result.cwd)
    const out: BashResult = {
      content: persisted.content,
      exitCode: result.exitCode,
    }
    if (persisted.persistPath !== undefined) {
      out.persistPath = persisted.persistPath
    }
    return out
  },
  renderResult(output: BashResult) {
    return output.content
  },
}

function formatBody(
  stdout: string,
  stderr: string,
  exitCode: number,
  cwd: string,
  timedOut: boolean,
): string {
  const parts: string[] = []
  if (stdout.length > 0) {
    parts.push(stdout.endsWith('\n') ? stdout : `${stdout}\n`)
  }
  if (stderr.length > 0) {
    parts.push(stderr.endsWith('\n') ? stderr : `${stderr}\n`)
  }
  if (timedOut) parts.push('timed out\n')
  parts.push(`exit_code=${exitCode}\n`)
  parts.push(`cwd=${cwd}\n`)
  return parts.join('')
}

function persistIfLarge(
  body: string,
  exitCode: number,
  cwd: string,
): { content: string; persistPath?: string } {
  if (body.length <= PERSIST_LIMIT) return { content: body }

  const persistPath = join(ravenclawHome(), 'tool-results', `${crypto.randomUUID()}.txt`)
  mkdirSync(join(ravenclawHome(), 'tool-results'), { recursive: true })
  writeFileSync(persistPath, body, 'utf8')
  const content =
    `${body.slice(0, PREVIEW_CHARS)}\n` +
    `... [truncated: output exceeds 100000 characters; full output at ${persistPath}]\n` +
    `exit_code=${exitCode}\n` +
    `cwd=${cwd}\n`
  return { content, persistPath }
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
