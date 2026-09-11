import { createInterface } from 'node:readline'
import {
  composerLine,
  createOpenTuiView,
  permissionPromptLines,
} from '@ravenclaw/tui-opentui'
import type { StreamEvent } from '@ravenclaw/core'
import { LEARN_PROMPT, handleSlashCommand } from './commands'
import { formatCostNotice } from './cost-format'
import { parsePermissionMode, type CliRuntime } from './engine'
import { formatStatusLine } from './status-line'

export interface OpenTuiAppIo {
  input?: AsyncIterable<string>
  write?: (chunk: string) => void
}

export async function runOpenTuiApp(
  runtime: CliRuntime,
  io: OpenTuiAppIo = {},
): Promise<number> {
  const write = io.write ?? ((chunk: string) => {
    process.stdout.write(chunk)
  })
  const { input, close } = openInput(io.input)
  const readLine = lineReader(input)
  const view = createOpenTuiView()

  const flush = () => {
    const lines = view.lines()
    if (lines.length === 0) return
    write(`${lines.join('\n')}\n`)
  }

  runtime.ask.bind(async (event, signal) => {
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
      const gen = runtime.engine.submitMessage(text)
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
    write(`${statusLine(runtime)}\n`)
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
        case 'quit':
          return 0
        case 'cancel':
          runtime.engine.abort()
          write('cancelled\n')
          continue
        case 'learn':
          await runTurn(LEARN_PROMPT)
          continue
        case 'compact':
          await runtime.engine.compactNow()
          write('compact requested\n')
          continue
        case 'cost':
          write(`${formatCostNotice({
            usage: runtime.engine.session.usage,
            profile: runtime.config.profile,
            funding: runtime.engine.session.funding,
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
          await runtime.engine.setPermissionMode(next)
          write(`mode ${next}\n`)
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
