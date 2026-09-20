import { createInterface } from 'node:readline'
import {
  composerLine,
  createOpenTuiView,
  permissionPromptLines,
} from '@ravenclaw/tui-opentui'
import {
  createJsonCronStore,
  fireDueJobs,
  parseLoopArg,
  startLoop,
  takeLoopTurn,
  formatLoopStatus,
  shouldAdvanceLoop,
  maybePruneSkillsOnIdle,
  runFollowupAfterSubmit,
  createSecondAbortGate,
  formatKilledBackgroundNotice,
  type StreamEvent,
} from '@ravenclaw/core'
import { handleSlashCommand } from './commands'
import { fireCronJob } from './cron-fire'
import { formatSkillPruneResult } from './skills-list'
import { resumeRuntime, type CliRuntime } from './engine'
import { dispatchSharedSlash } from './slash/dispatch'
import { collectUserImages, readClipboardImage } from './image-paste'
import { parseBangLine, runBangCommand } from './bash-line'
import { appendPrompt } from './prompt-history'
import { expandMentions } from './mentions'
import {
  createMessageQueue,
  dequeue,
  enqueue,
  formatQueue,
  parseQueueArg,
  removeAt,
} from './message-queue'
import {
  formatDiffPanel,
  loadGitDiff,
  loadSessionDiff,
  parseDiffArg,
  type GitDiffView,
} from './diff-cmd'
import { formatAskUserDialog, parseAskUserAnswer } from './ask-host'
import { loadIncludedDockLines } from './included-ads'
import { formatResumeSessionLine } from './resume'
import { formatStatusLine, shortSessionId } from './status-line'

export interface OpenTuiAppIo {
  input?: AsyncIterable<string>
  write?: (chunk: string) => void
  resumeRuntime?: (runtime: CliRuntime, sessionId: string) => Promise<CliRuntime>
  openNewSession?: (runtime: CliRuntime) => Promise<CliRuntime>
  loadGitDiff?: (cwd: string) => GitDiffView
}

export async function runOpenTuiApp(
  runtime: CliRuntime,
  io: OpenTuiAppIo = {},
): Promise<number> {
  const write = io.write ?? ((chunk: string) => {
    process.stdout.write(chunk)
  })
  const resume = io.resumeRuntime ?? resumeRuntime
  const readDiff = io.loadGitDiff ?? loadGitDiff
  let diffOpen = false
  let diffSelected = 0
  const { input, close } = openInput(io.input)
  const readLine = lineReader(input)
  const view = createOpenTuiView()
  let current = runtime
  const abortGate = createSecondAbortGate()

  const writeDiffPanel = () => {
    const writePanel = () => {
      if (current.engine.session.job) {
        const panel = loadSessionDiff(current.engine.session, current.cwd)
        if (panel.kind === 'job') {
          write(`${panel.lines.join('\n')}\n`)
          return
        }
      }
      const next = readDiff(current.cwd)
      if (next.kind === 'files') {
        diffSelected = Math.min(diffSelected, Math.max(0, next.files.length - 1))
      }
      write(`${formatDiffPanel(next, diffSelected).join('\n')}\n`)
    }
    if (current.engine.maybeFinishRewindReset) {
      void current.engine.maybeFinishRewindReset().then(writePanel)
      return
    }
    writePanel()
  }

  const flush = () => {
    const lines = view.lines()
    if (lines.length === 0) return
    write(`${lines.join('\n')}\n`)
  }

  const renderEvent = (event: StreamEvent) => {
    view.apply(event)
    flush()
  }

  const bindHosts = () => {
    current.ask.bind(async (event, signal) => {
      for (const line of permissionPromptLines(event)) write(`${line}\n`)
      while (true) {
        if (signal.aborted) throw abortError()
        const answer = await readLine()
        if (answer === undefined || signal.aborted) throw abortError()
        const parsed = parsePermissionAnswer(answer)
        if (parsed !== undefined) return parsed
      }
    })
    current.askQuestions?.bind(async (input, signal) => {
      write(`${formatAskUserDialog(input)}\n`)
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      const line = await readLine()
      if (line === undefined || signal.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
      return parseAskUserAnswer(input, line)
    })
  }

  const replayPending = async () => {
    try {
      for await (const ev of current.engine.replayPendingAsks()) {
        renderEvent(ev)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      write(`${message}\n`)
    }
  }

  bindHosts()
  if (runtime.status !== undefined && runtime.status !== '') {
    write(`${runtime.status}\n`)
  }

  const queue = createMessageQueue()
  let turnBusy = false
  let draft = ''
  let loopState: import('@ravenclaw/core').LoopState | null = null

  const runTurn = async (text: string) => {
    if (turnBusy) {
      const n = enqueue(queue, text)
      write(`queued (${n})\n`)
      return
    }
    current.engine.bindDrainQueued(() => dequeue(queue))
    turnBusy = true
    const expanded = expandMentions(text, current.cwd)
    appendPrompt(text, current.config.home)
    view.append(`you  ${text}`)
    flush()
    let advanceLoop = false
    let followupRan = false
    try {
      const payload = collectUserImages(expanded.text, current.cwd, readClipboardImage)
      const queued =
        typeof payload === 'string'
          ? { text: payload, turnPolicy: 'queue' as const }
          : { ...payload, turnPolicy: 'queue' as const }
      const beforeLastEnd = current.engine.session.lastEnd
      const gen = current.engine.submitMessage(queued)
      while (true) {
        const next = await gen.next()
        if (next.done) {
          view.apply({ type: 'round_end', end: next.value })
          flush()
          advanceLoop = shouldAdvanceLoop(next.value.reason)
          if (
            typeof current.engine.getFollowup === 'function' &&
            typeof current.engine.clearFollowup === 'function' &&
            typeof current.engine.liveTurnId === 'function'
          ) {
            const flag = await runFollowupAfterSubmit({
              engine: current.engine,
              store: current.store,
              sessionId: current.engine.session.id,
              beforeLastEnd,
            })
            followupRan = flag === 'ran'
          }
          break
        }
        renderEvent(next.value)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      view.append(`error  ${message}`)
      flush()
      loopState = null
    } finally {
      turnBusy = false
      const leftover = current.engine.drainSteering()
      if (leftover.length > 0) void runTurn(leftover.join('\n'))
      else if (!followupRan) {
        const queued = dequeue(queue)
        if (queued !== undefined) void runTurn(queued)
        else if (advanceLoop) {
          const looped = takeLoopTurn(loopState)
          loopState = looped.next
          if (looped.prompt !== undefined) void runTurn(looped.prompt)
        } else {
          loopState = null
          void current.store.peekAgentMail(current.engine.session.id).then((mail) => {
            if (mail.length > 0) void runTurn('[mailbox]')
          })
        }
      }
    }
    write(`${statusLine(current)}\n`)
  }

  const writeIncludedAds = async (runtime: CliRuntime) => {
    if (runtime.engine.session.funding !== 'included') return
    const lines = await loadIncludedDockLines({
      enabled: true,
      feedUrl: runtime.config.ads.feedUrl,
      sessionId: runtime.engine.session.id,
      hasPaidCapacityPlan: runtime.hasPaidCapacityPlan === true,
      width: process.stdout.columns || 80,
      height: process.stdout.rows || 24,
    })
    if (lines.length > 0) write(`${lines.join('\n')}\n`)
  }

  let lastActivityAt = Date.now()
  let cronInflight = false
  const cronTimer = setInterval(() => {
    if (cronInflight) return
    cronInflight = true
    void (async () => {
      try {
        const home = current.config.home
        if (!turnBusy) {
          const mail = await current.store.peekAgentMail(current.engine.session.id)
          if (mail.length > 0) void runTurn('[mailbox]')
          try {
            await current.store.renewSessionLock(current.engine.session.id, current.lockHolderId)
          } catch {
            // idle renew is best-effort
          }
          try {
            const idle = maybePruneSkillsOnIdle({
              cwd: current.cwd,
              ...(home !== undefined ? { home } : {}),
              lastActivityAt,
            })
            if (idle.ran && (idle.result.stale.length > 0 || idle.result.archived.length > 0)) {
              write(`${formatSkillPruneResult(idle.result)}\n`)
            }
          } catch {
            // prune is best-effort
          }
        }
        const fired = await fireDueJobs({
          store: createJsonCronStore(home !== undefined ? { home } : undefined),
          run: (job) => fireCronJob(current, job),
        })
        if (fired.length > 0) {
          const last = fired[fired.length - 1]
          if (last) write(`cron ${last.job.id} ${last.status}\n`)
        }
      } catch {
        // ticker must not take down the live session
      } finally {
        cronInflight = false
      }
    })()
  }, 15_000)

  try {
    await writeIncludedAds(current)
    await replayPending()
    while (true) {
      if (diffOpen) writeDiffPanel()
      write(`${composerLine(draft)}\n`)
      const line = await readLine()
      if (line === undefined) return 0
      const restored = draft
      draft = ''
      lastActivityAt = Date.now()

      const parsed = handleSlashCommand(line)
      if (parsed.type === 'prompt') {
        if (parsed.text === '') {
          if (restored !== '') {
            await runTurn(restored)
            continue
          }
          if (!readClipboardImage()) continue
          await runTurn('')
          continue
        }
        const bang = parseBangLine(parsed.text)
        if (bang.kind === 'bash') {
          const result = runBangCommand(bang.command, current.cwd)
          write(`${result.text || `exit ${result.code}`}\n`)
          continue
        }
        await runTurn(parsed.text)
        continue
      }

      const shared = await dispatchSharedSlash(parsed, {
        runtime: () => current,
        notice: (text) => {
          write(`${text}\n`)
        },
        runTurn,
        writeOsc52: (text) => {
          write(text)
        },
      })
      if (shared === 'handled') continue
      switch (parsed.name) {
        case 'quit':
          return 0
        case 'stop': {
          const wasLive = current.engine.liveTurnId() !== null
          current.engine.abort('cancel')
          if (abortGate.press() === 'kill_all') {
            const killed = current.engine.tasks.killAll()
            write(`${formatKilledBackgroundNotice(killed.length)}\n`)
          } else {
            const tree = await current.engine.whenTreeStop()
            write(
              wasLive || tree.descendantWork || tree.thisSessionWork
                ? 'stopped\n'
                : 'nothing to stop\n',
            )
          }
          continue
        }
        case 'clear': {
          try {
            const result = await current.engine.clearKeepId()
            if (!result.ok) {
              write(`${result.notice}\n`)
              continue
            }
            view.reset()
            write(`cleared session ${shortSessionId(current.engine.session.id)}\n`)
            await writeIncludedAds(current)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            write(`${message}\n`)
          }
          continue
        }
        case 'loop': {
          const action = parseLoopArg(parsed.arg)
          if (action.action === 'error') {
            write(`${action.message}\n`)
            continue
          }
          if (action.action === 'stop') {
            loopState = null
            write('loop stopped\n')
            continue
          }
          if (action.action === 'status') {
            write(`${formatLoopStatus(loopState)}\n`)
            continue
          }
          loopState = startLoop(action.times, action.prompt)
          const first = takeLoopTurn(loopState)
          loopState = first.next
          if (first.prompt !== undefined) void runTurn(first.prompt)
          continue
        }
        case 'diff': {
          const action = parseDiffArg(parsed.arg)
          if (action.action === 'error') {
            write(`${action.message}\n`)
            continue
          }
          if (action.action === 'close' || (action.action === 'toggle' && diffOpen)) {
            diffOpen = false
            write('diff closed\n')
            continue
          }
          if (action.action === 'select') diffSelected = action.index
          diffOpen = true
          writeDiffPanel()
          continue
        }
        case 'retry': {
          const rewound = await current.engine.rewindLast()
          write(`${rewound.notice}\n`)
          if (rewound.droppedText !== undefined) draft = rewound.droppedText
          if (!rewound.ok) continue
          if (parsed.arg !== undefined && parsed.arg.trim() !== '') {
            await runTurn(parsed.arg)
            continue
          }
          continue
        }
        case 'queue': {
          const action = parseQueueArg(parsed.arg)
          if (action.action === 'error') {
            write(`${action.message}\n`)
            continue
          }
          if (action.action === 'clear') {
            queue.items.length = 0
            write('queue empty\n')
            continue
          }
          if (action.action === 'drop') {
            const removed = removeAt(queue, action.index - 1)
            write(`${removed === undefined ? `unknown queue item ${action.index}` : formatQueue(queue)}\n`)
            continue
          }
          write(`${formatQueue(queue)}\n`)
          continue
        }
        case 'bash': {
          if (parsed.arg === undefined || parsed.arg.trim() === '') {
            write('usage: /bash <cmd>\n')
            continue
          }
          const result = runBangCommand(parsed.arg, current.cwd)
          write(`${result.text || `exit ${result.code}`}\n`)
          continue
        }
        case 'resume': {
          if (parsed.arg !== undefined) {
            try {
              current = await resume(current, parsed.arg)
              bindHosts()
              write(`resumed ${shortSessionId(parsed.arg)}\n`)
              await writeIncludedAds(current)
              await replayPending()
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
    clearInterval(cronTimer)
    await current.engine.close()
    close()
    await current.engine.close?.()
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

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

function parsePermissionAnswer(line: string): 'allow' | 'deny' | 'allow_always' | undefined {
  const key = line.trim().toLowerCase()
  if (key === 'y' || key === 'yes' || key === 'allow') return 'allow'
  if (key === 'n' || key === 'no' || key === 'deny') return 'deny'
  if (key === 'a' || key === 'always' || key === 'allow_always') return 'allow_always'
  return undefined
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
