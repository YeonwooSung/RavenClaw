import { createInterface } from 'node:readline'
import {
  composerLine,
  createOpenTuiView,
  permissionPromptLines,
} from '@ravenclaw/tui-opentui'
import type { StreamEvent } from '@ravenclaw/core'
import { LEARN_PROMPT, REVIEW_PROMPT, SLASH_HELP, handleSlashCommand } from './commands'
import { formatCostNotice } from './cost-format'
import { runSessionReview } from './review'
import { searchNotice } from './search'
import { parsePermissionMode, resumeRuntime, type CliRuntime } from './engine'
import { applySessionTitle, formatResumeSessionLine } from './resume'
import { formatStatusLine, shortSessionId } from './status-line'

export interface OpenTuiAppIo {
  input?: AsyncIterable<string>
  write?: (chunk: string) => void
  resumeRuntime?: (runtime: CliRuntime, sessionId: string) => Promise<CliRuntime>
}

export async function runOpenTuiApp(
  runtime: CliRuntime,
  io: OpenTuiAppIo = {},
): Promise<number> {
  const write = io.write ?? ((chunk: string) => {
    process.stdout.write(chunk)
  })
  const resume = io.resumeRuntime ?? resumeRuntime
  const { input, close } = openInput(io.input)
  const readLine = lineReader(input)
  const view = createOpenTuiView()
  let current = runtime

  const flush = () => {
    const lines = view.lines()
    if (lines.length === 0) return
    write(`${lines.join('\n')}\n`)
  }

  current.ask.bind(async (event, signal) => {
    for (const line of permissionPromptLines(event)) write(`${line}\n`)
    if (signal.aborted) return 'deny'
    const answer = await readLine()
    if (answer === undefined || signal.aborted) return 'deny'
    return parsePermissionAnswer(answer)
  })

  const runTurn = async (text: string) => {
    view.append(`you  ${text}`)
    flush()
    try {
      const gen = current.engine.submitMessage(text)
      while (true) {
        const next = await gen.next()
        if (next.done) {
          view.apply({ type: 'round_end', end: next.value })
          flush()
          break
        }
        const event: StreamEvent = next.value
        view.apply(event)
        flush()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      view.append(`error  ${message}`)
      flush()
    }
    write(`${statusLine(current)}\n`)
  }

  try {
    while (true) {
      write(`${composerLine()}\n`)
      const line = await readLine()
      if (line === undefined) return 0

      const parsed = handleSlashCommand(line)
      if (parsed.type === 'prompt') {
        if (parsed.text === '') continue
        await runTurn(parsed.text)
        continue
      }

      switch (parsed.name) {
        case 'help':
        case '?':
          write(`${SLASH_HELP}\n`)
          continue
        case 'quit':
          return 0
        case 'cancel':
          current.engine.abort()
          write('cancelled\n')
          continue
        case 'learn':
          await runTurn(LEARN_PROMPT)
          continue
        case 'title':
          if (parsed.arg === undefined || parsed.arg.trim() === '') {
            write('usage: /title <name>\n')
            continue
          }
          await applySessionTitle(current.store, current.engine.session, parsed.arg.trim())
          write(`title ${parsed.arg.trim()}\n`)
          continue
        case 'review':
          write(`${await runSessionReview(current, parsed.arg ?? REVIEW_PROMPT)}\n`)
          continue
        case 'compact':
          await current.engine.compactNow()
          write('compact requested\n')
          continue
        case 'cost':
          write(`${formatCostNotice({
            usage: current.engine.session.usage,
            profile: current.config.profile,
            funding: current.engine.session.funding,
          })}\n`)
          continue
        case 'search':
          write(`${searchNotice({
            store: current.store,
            arg: parsed.arg,
            sessionId: current.engine.session.id,
          })}\n`)
          continue
        case 'mode': {
          if (parsed.arg === undefined) {
            write('usage: /mode default|acceptEdits|plan|dontAsk\n')
            continue
          }
          const next = parsePermissionMode(parsed.arg)
          if (!next) {
            write(`unknown mode: ${parsed.arg}\n`)
            continue
          }
          await current.engine.setPermissionMode(next)
          write(`mode ${next}\n`)
          continue
        }
        case 'resume': {
          if (parsed.arg !== undefined) {
            try {
              current = await resume(current, parsed.arg)
              write(`resumed ${shortSessionId(parsed.arg)}\n`)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              write(`${message}\n`)
            }
            continue
          }
          const sessions = await current.store.listSessions({
            cwd: current.cwd,
            limit: 20,
          })
          if (sessions.length === 0) {
            write('no sessions to resume\n')
            continue
          }
          write(`${sessions.map(formatResumeSessionLine).join('\n')}\n`)
          continue
        }
        default:
          write(`unknown command: /${parsed.name}\n`)
      }
    }
  } finally {
    close()
  }
}

function openInput(source?: AsyncIterable<string>): {
  input: AsyncIterable<string>
  close: () => void
} {
  if (source) return { input: source, close() {} }
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  return { input: rl, close: () => rl.close() }
}

function parsePermissionAnswer(line: string): 'allow' | 'deny' | 'allow_always' {
  const key = line.trim().toLowerCase()
  if (key === 'y') return 'allow'
  if (key === 'n') return 'deny'
  if (key === 'a') return 'allow_always'
  return 'deny'
}

function lineReader(source: AsyncIterable<string>): () => Promise<string | undefined> {
  const iterator = source[Symbol.asyncIterator]()
  return async () => {
    const next = await iterator.next()
    return next.done ? undefined : next.value
  }
}

function statusLine(runtime: CliRuntime): string {
  return formatStatusLine({
    model: runtime.engine.session.model,
    mode: runtime.engine.session.permissionMode,
    usage: runtime.engine.session.usage,
    sessionId: runtime.engine.session.id,
  })
}
