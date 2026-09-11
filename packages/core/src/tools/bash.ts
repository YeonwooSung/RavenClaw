import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolContext } from '../types'
import { ravenclawHome } from '../home'
import { parseWithSchema } from './parse'
import { createLocalTerminalBackend, type TerminalBackend } from './terminal-backend'

export interface BashInput {
  command: string
  timeout?: number
  run_in_background?: boolean
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
    run_in_background: { type: 'boolean' },
  },
}

export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed === '' || /[|&><;`$]/.test(trimmed)) return false
  if (/\bgit\s+(push|commit|reset|rebase|clean|add)\b/.test(trimmed)) return false
  return /^(ls|echo|pwd|true|false|date|whoami|uname|cat|head|tail|wc|which|type)\b/.test(trimmed)
    || /^git\s+(status|log|diff|show|rev-parse|branch)\b/.test(trimmed)
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

export function createBashTool(backend: TerminalBackend): Tool<BashInput, BashResult> {
  return {
    name: 'Bash',
    description:
      'Run a command with bash -c in the turn cwd. Optional timeout is milliseconds (default 120000 = 120 seconds). Set run_in_background to start the process and return a task id immediately; then use TaskOutput / TaskStop or /tasks. Reports exit code and ending cwd (captured via an in-band marker after the command). Combined output over 100000 characters is written to $RAVENCLAW_HOME/tool-results and only a preview is returned. interruptBehavior is cancel.',
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
        return { behavior: 'ask', message: 'Command matches a dangerous pattern', saveAs: 'session' }
      }
      if (isReadOnlyBashCommand(input.command)) {
        return { behavior: 'allow', reason: 'mode' }
      }
      return { behavior: 'ask', message: 'Run this command?', saveAs: 'session' }
    },
    async execute(input: BashInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      if (input.run_in_background === true) {
        return startBackground(backend, input, ctx)
      }
      const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS
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
}

export const bashTool: Tool<BashInput, BashResult> = createBashTool(createLocalTerminalBackend())

function startBackground(
  backend: TerminalBackend,
  input: BashInput,
  ctx: ToolContext,
): BashResult {
  if (!backend.start) {
    return {
      content: 'Bash failed: run_in_background requires the local terminal backend',
      exitCode: 1,
    }
  }
  const tasks = ctx.tasks
  if (!tasks) {
    return { content: 'Bash failed: no task registry', exitCode: 1 }
  }

  mkdirSync(join(ravenclawHome(), 'tasks'), { recursive: true })
  const outputFile = join(ravenclawHome(), 'tasks', `${crypto.randomUUID()}.log`)
  writeFileSync(outputFile, '', 'utf8')
  const job = backend.start({
    command: input.command,
    cwd: ctx.turn.cwd,
    timeoutMs: input.timeout ?? 0,
    signal: new AbortController().signal,
    onOutput: (text) => {
      try {
        appendFileSync(outputFile, text)
      } catch {
        // keep running even if the log write fails
      }
    },
  })
  const task = tasks.register({
    command: input.command,
    outputFile,
    kill: () => job.kill(),
  })
  void job.wait().then(
    (result) => {
      const timedOut = result.exitCode === 124
      const body = formatBody(result.stdout, result.stderr, result.exitCode, result.cwd, timedOut)
      try {
        writeFileSync(outputFile, body, 'utf8')
      } catch {
        // keep the streamed log if the final write fails
      }
      tasks.complete(task.id, result.exitCode)
    },
    () => {
      tasks.complete(task.id, 137)
    },
  )
  return {
    content:
      `started background task ${task.id}\n` +
      `output: ${outputFile}\n` +
      'use TaskOutput to read; TaskStop or /tasks kill <id> to stop',
    exitCode: 0,
  }
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
