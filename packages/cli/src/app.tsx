import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import {
  createJsonCronStore,
  cyclePermissionMode,
  fireDueJobs,
  createSecondAbortGate,
  formatKilledBackgroundNotice,
  parseLoopArg,
  startLoop,
  takeLoopTurn,
  formatLoopStatus,
  shouldAdvanceLoop,
  type LoopState,
  maybePruneSkillsOnIdle,
  runFollowupAfterSubmit,
  type Funding,
  type PermissionMode,
  type SessionRecord,
  type StreamEvent,
  type TaskSnapshot,
  type TokenUsage,
  type TodoItem,
  loadTodos,
  nearCompact,
} from '@ravenclaw/core'
import { AdDock } from './ad-dock'
import { handleSlashCommand } from './commands'
import { collectUserImages, readClipboardImage } from './image-paste'
import { Composer } from './composer'
import { fireCronJob } from './cron-fire'
import {
  compactPolicyFromConfig,
  openNewSession,
  resumeRuntime,
  type CliRuntime,
} from './engine'
import { formatSkillPruneResult } from './skills-list'
import { dispatchSharedSlash } from './slash/dispatch'
import { ChildAgentList } from './child-agents'
import { TodoPanel } from './todo-panel'
import { parseBangLine, runBangCommand } from './bash-line'
import { appendPrompt, loadPrompts } from './prompt-history'
import { expandMentions } from './mentions'
import {
  createMessageQueue,
  dequeue,
  enqueue,
  formatQueue,
  parseQueueArg,
  removeAt,
} from './message-queue'
import { formatAskUserDialog, parseAskUserAnswer } from './ask-host'
import { loadSessionDiff, parseDiffArg, type GitDiffView } from './diff-cmd'
import { DiffPanel } from './diff-panel'
import type { AskUserInput } from '@ravenclaw/core'
import { keyToPermission, PermissionDialog, type PermissionAsk } from './permission-dialog'
import { StatusLine, shortSessionId } from './status-line'
import {
  applyStreamEvent,
  rowsFromMessages,
  selectedToolId,
  shouldToggleExpand,
  toggleExpanded,
  Transcript,
  type TranscriptRow,
} from './transcript'

export interface AppProps {
  runtime: CliRuntime
}

type PendingAsk = {
  event: PermissionAsk
  resolve: (value: 'allow' | 'deny' | 'allow_always') => void
  reject: (error: unknown) => void
}

export function App(props: AppProps) {
  const { exit } = useApp()
  const runtimeRef = useRef(props.runtime)
  const queueRef = useRef(createMessageQueue())
  const busyRef = useRef(false)
  const lastActivityAtRef = useRef(Date.now())
  const askRef = useRef<PendingAsk | null>(null)
  const historyRef = useRef<string[]>(loadPrompts(props.runtime.config.home))
  const historyIndexRef = useRef<number | null>(null)
  const loopRef = useRef<LoopState | null>(null)
  const askUserRef = useRef<{
    input: AskUserInput
    resolve: (value: string) => void
    reject: (error: unknown) => void
  } | null>(null)

  const [rows, setRows] = useState<TranscriptRow[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(props.runtime.status)
  const [mode, setMode] = useState<PermissionMode>(props.runtime.engine.session.permissionMode)
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffView, setDiffView] = useState<GitDiffView | undefined>()
  const [diffLines, setDiffLines] = useState<string[] | undefined>()
  const [diffSelected, setDiffSelected] = useState(0)
  const diffOpenRef = useRef(false)
  const abortGateRef = useRef(createSecondAbortGate())
  const [usage, setUsage] = useState<TokenUsage>(props.runtime.engine.session.usage)
  const [sessionId, setSessionId] = useState(props.runtime.engine.session.id)
  const [model, setModel] = useState(props.runtime.engine.session.model)
  const [funding, setFunding] = useState<Funding>(props.runtime.engine.session.funding)
  const [ask, setAsk] = useState<PermissionAsk | undefined>(undefined)
  const [picker, setPicker] = useState<SessionRecord[] | undefined>(undefined)
  const [pickerIndex, setPickerIndex] = useState(0)
  const [todos, setTodos] = useState<TodoItem[]>(
    () => props.runtime.engine.session.todos ?? loadTodos(props.runtime.cwd),
  )
  const [tasks, setTasks] = useState<TaskSnapshot[]>(() => props.runtime.engine.tasks.list())
  const [selectedIndex, setSelectedIndex] = useState<number | undefined>(undefined)
  const [expandedIds, setExpandedIds] = useState(() => new Set<string>())
  const [lastAssembleInput, setLastAssembleInput] = useState(0)

  const syncSession = useCallback(() => {
    const session = runtimeRef.current.engine.session
    setMode(session.permissionMode)
    setUsage(session.usage)
    setSessionId(session.id)
    setModel(session.model)
    setFunding(session.funding)
  }, [])

  const applyDiffView = useCallback((select?: number) => {
    const runtime = runtimeRef.current
    const apply = () => {
      const panel = loadSessionDiff(runtime.engine.session, runtime.cwd)
      diffOpenRef.current = true
      setDiffOpen(true)
      if (panel.kind === 'job') {
        setDiffLines(panel.lines)
        setDiffView(undefined)
        setDiffSelected(0)
        return
      }
      setDiffLines(undefined)
      setDiffView(panel.view)
      if (panel.view.kind === 'files') {
        const max = panel.view.files.length - 1
        setDiffSelected(select === undefined ? 0 : Math.min(max, Math.max(0, select)))
      } else {
        setDiffSelected(0)
      }
    }
    if (runtime.engine.maybeFinishRewindReset) {
      void runtime.engine.maybeFinishRewindReset().then(apply)
      return
    }
    apply()
  }, [])

  const closeDiff = useCallback(() => {
    diffOpenRef.current = false
    setDiffOpen(false)
  }, [])

  const refreshDiff = useCallback(() => {
    if (!diffOpenRef.current) return
    const runtime = runtimeRef.current
    const apply = () => {
      const panel = loadSessionDiff(runtime.engine.session, runtime.cwd)
      if (panel.kind === 'job') {
        setDiffLines(panel.lines)
        setDiffView(undefined)
        return
      }
      setDiffLines(undefined)
      setDiffView(panel.view)
      if (panel.view.kind === 'files') {
        setDiffSelected((index) => Math.min(index, panel.view.files.length - 1))
      }
    }
    if (runtime.engine.maybeFinishRewindReset) {
      void runtime.engine.maybeFinishRewindReset().then(apply)
      return
    }
    apply()
  }, [])

  const bindAskQuestions = useCallback(() => {
    runtimeRef.current.askQuestions?.bind(async (input, signal) => {
      return await new Promise<string>((resolve, reject) => {
        const pending = {
          input,
          resolve: (value: string) => {
            cleanup()
            resolve(value)
          },
          reject: (error: unknown) => {
            cleanup()
            reject(error)
          },
        }
        const onAbort = () => {
          pending.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }
        const cleanup = () => {
          signal.removeEventListener('abort', onAbort)
          askUserRef.current = null
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        askUserRef.current = pending
        setNotice(formatAskUserDialog(input))
      })
    })
  }, [])

  const bindAsk = useCallback(() => {
    runtimeRef.current.ask.bind(async (event, signal) => {
      return await new Promise<'allow' | 'deny' | 'allow_always'>((resolve, reject) => {
        const pending: PendingAsk = {
          event,
          resolve: (value) => {
            cleanup()
            resolve(value)
          },
          reject: (error) => {
            cleanup()
            reject(error)
          },
        }
        const onAbort = () => {
          pending.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }
        const cleanup = () => {
          signal.removeEventListener('abort', onAbort)
          askRef.current = null
          setAsk(undefined)
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        askRef.current = pending
        setAsk(event)
      })
    })
    bindAskQuestions()
  }, [bindAskQuestions])

  const applyLiveEvent = useCallback((event: StreamEvent) => {
    if (event.type === 'usage') {
      setLastAssembleInput(event.usage.input)
      setUsage((prev) => ({
        input: prev.input + event.usage.input,
        output: prev.output + event.usage.output,
        cacheRead: prev.cacheRead + event.usage.cacheRead,
        cacheWrite: prev.cacheWrite + event.usage.cacheWrite,
      }))
    }
    setRows((prev) => {
      const next = applyStreamEvent(prev, event)
      if (event.type === 'tool_result') {
        const name = next.find((row) => row.kind === 'tool' && row.id === event.id)?.name ?? ''
        if (name === 'TodoWrite') {
          setTodos(
            runtimeRef.current.engine.session.todos ?? loadTodos(runtimeRef.current.cwd),
          )
        }
        setTasks(runtimeRef.current.engine.tasks.list())
      }
      return next
    })
  }, [])

  const replayPending = useCallback(async () => {
    const message = await replayPendingAsksTo(
      () => runtimeRef.current.engine.replayPendingAsks(),
      applyLiveEvent,
    )
    if (message !== undefined) setNotice(message)
  }, [applyLiveEvent])

  useEffect(() => {
    return () => {
      void runtimeRef.current.engine.close()
    }
  }, [])

  useEffect(() => {
    bindAsk()
    void replayPending()
  }, [bindAsk, replayPending])

  const runTurn = useCallback(
    async (text: string) => {
      if (busyRef.current) {
        const n = enqueue(queueRef.current, text)
        setNotice(`queued (${n})`)
        return
      }
      runtimeRef.current.engine.bindDrainQueued(() => dequeue(queueRef.current))
      busyRef.current = true
      setBusy(true)
      setNotice(undefined)
      const expanded = expandMentions(text, runtimeRef.current.cwd)
      const prompt = expanded.text
      appendPrompt(text, runtimeRef.current.config.home)
      historyRef.current = loadPrompts(runtimeRef.current.config.home)
      historyIndexRef.current = null
      setRows((prev) => [...prev, { kind: 'user', text }])
      let advanceLoop = false
      let followupRan = false
      try {
        const payload = collectUserImages(
          prompt,
          runtimeRef.current.cwd,
          readClipboardImage,
        )
        const queued =
          typeof payload === 'string'
            ? { text: payload, turnPolicy: 'queue' as const }
            : { ...payload, turnPolicy: 'queue' as const }
        const engine = runtimeRef.current.engine
        const beforeLastEnd = engine.session.lastEnd
        const gen = engine.submitMessage(queued)
        while (true) {
          const next = await gen.next()
          if (next.done) {
            advanceLoop = shouldAdvanceLoop(next.value.reason)
            if (
              typeof engine.getFollowup === 'function' &&
              typeof engine.clearFollowup === 'function' &&
              typeof engine.liveTurnId === 'function'
            ) {
              const flag = await runFollowupAfterSubmit({
                engine,
                store: runtimeRef.current.store,
                sessionId: engine.session.id,
                beforeLastEnd,
              })
              followupRan = flag === 'ran'
            }
            break
          }
          applyLiveEvent(next.value)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setRows((prev) => [...prev, { kind: 'error', message }])
        loopRef.current = null
      } finally {
        syncSession()
        refreshDiff()
        busyRef.current = false
        setBusy(false)
        const leftover = runtimeRef.current.engine.drainSteering()
        if (leftover.length > 0) void runTurn(leftover.join('\n'))
        else if (!followupRan) {
          const queued = dequeue(queueRef.current)
          if (queued !== undefined) void runTurn(queued)
          else if (advanceLoop) {
            const looped = takeLoopTurn(loopRef.current)
            loopRef.current = looped.next
            if (looped.prompt !== undefined) void runTurn(looped.prompt)
          } else {
            loopRef.current = null
            void runtimeRef.current.store
              .peekAgentMail(runtimeRef.current.engine.session.id)
              .then((mail) => {
                if (mail.length > 0) void runTurn('[mailbox]')
              })
          }
        }
      }
    },
    [syncSession, refreshDiff, applyLiveEvent],
  )

  const applyResume = useCallback(
    async (id: string) => {
      try {
        const next = await resumeRuntime(runtimeRef.current, id)
        runtimeRef.current = next
        bindAsk()
        setRows(rowsFromMessages((await next.store.loadSession(id)).messages))
        setTodos(next.engine.session.todos ?? loadTodos(next.cwd))
        setTasks(next.engine.tasks.list())
        setSelectedIndex(undefined)
        setExpandedIds(new Set())
        setLastAssembleInput(0)
        syncSession()
        setNotice(`resumed ${shortSessionId(id)}`)
        await replayPending()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setNotice(message)
      }
    },
    [syncSession, bindAsk, replayPending],
  )

  const submitLine = useCallback(
    (line: string) => {
      if (askUserRef.current) {
        const pending = askUserRef.current
        const answer = parseAskUserAnswer(pending.input, line)
        pending.resolve(answer)
        setNotice(answer)
        return
      }
      const parsed = handleSlashCommand(line)
      if (parsed.type === 'prompt') {
        if (parsed.text === '') {
          if (!readClipboardImage()) return
          void runTurn('')
          return
        }
        const bang = parseBangLine(parsed.text)
        if (bang.kind === 'bash') {
          const result = runBangCommand(bang.command, runtimeRef.current.cwd)
          setRows((prev) => [
            ...prev,
            { kind: 'user', text: parsed.text },
            { kind: 'status', message: result.text || `exit ${result.code}` },
          ])
          return
        }
        void runTurn(parsed.text)
        return
      }
      void dispatchSharedSlash(parsed, {
        runtime: () => runtimeRef.current,
        notice: setNotice,
        runTurn: (prompt) => {
          void runTurn(prompt)
        },
        onModelChanged: setModel,
        onModeChanged: (mode) => {
          setMode(mode as PermissionMode)
        },
        writeOsc52: (text) => {
          process.stdout.write(text)
        },
      }).then((shared) => {
        if (shared === 'handled') return
        switch (parsed.name) {
          case 'quit':
            exit()
            return
          case 'stop':
            runtimeRef.current.engine.abort('cancel')
            setNotice(busyRef.current ? 'stopped' : 'nothing to stop')
            return
          case 'clear':
            void (async () => {
              await runtimeRef.current.engine.close()
              await runtimeRef.current.mcpCloser?.()
              const next = await openNewSession(runtimeRef.current)
              runtimeRef.current = next
              bindAskQuestions()
              setRows([])
              setTodos(next.engine.session.todos ?? loadTodos(next.cwd))
              setTasks(next.engine.tasks.list())
              setSelectedIndex(undefined)
              setExpandedIds(new Set())
              setLastAssembleInput(0)
              syncSession()
              setNotice(`new session ${shortSessionId(next.engine.session.id)}`)
            })()
            return
          case 'loop': {
            const action = parseLoopArg(parsed.arg)
            if (action.action === 'error') {
              setNotice(action.message)
              return
            }
            if (action.action === 'stop') {
              loopRef.current = null
              setNotice('loop stopped')
              return
            }
            if (action.action === 'status') {
              setNotice(formatLoopStatus(loopRef.current))
              return
            }
            loopRef.current = startLoop(action.times, action.prompt)
            const first = takeLoopTurn(loopRef.current)
            loopRef.current = first.next
            if (first.prompt !== undefined) void runTurn(first.prompt)
            return
          }
          case 'diff': {
            const action = parseDiffArg(parsed.arg)
            if (action.action === 'error') {
              setNotice(action.message)
              return
            }
            if (action.action === 'close' || (action.action === 'toggle' && diffOpenRef.current)) {
              closeDiff()
              return
            }
            applyDiffView(action.action === 'select' ? action.index : undefined)
            return
          }
          case 'retry': {
            void (async () => {
              const rewound = await runtimeRef.current.engine.rewindLast()
              setNotice(rewound.notice)
              if (!rewound.ok) return
              if (parsed.arg !== undefined && parsed.arg.trim() !== '') {
                void runTurn(parsed.arg)
                return
              }
              if (rewound.droppedText !== undefined) setDraft(rewound.droppedText)
            })()
            return
          }
          case 'queue': {
            const action = parseQueueArg(parsed.arg)
            if (action.action === 'error') {
              setNotice(action.message)
              return
            }
            if (action.action === 'clear') {
              queueRef.current.items.length = 0
              setNotice('queue empty')
              return
            }
            if (action.action === 'drop') {
              const removed = removeAt(queueRef.current, action.index - 1)
              setNotice(removed === undefined ? `unknown queue item ${action.index}` : formatQueue(queueRef.current))
              return
            }
            setNotice(formatQueue(queueRef.current))
            return
          }
          case 'bash': {
            if (parsed.arg === undefined || parsed.arg.trim() === '') {
              setNotice('usage: /bash <cmd>')
              return
            }
            const result = runBangCommand(parsed.arg, runtimeRef.current.cwd)
            setRows((prev) => [
              ...prev,
              { kind: 'user', text: `!${parsed.arg}` },
              { kind: 'status', message: result.text || `exit ${result.code}` },
            ])
            return
          }
          case 'resume': {
            if (parsed.arg) {
              void applyResume(parsed.arg)
              return
            }
            void runtimeRef.current.store
              .listSessions({ cwd: runtimeRef.current.cwd, limit: 20 })
              .then((sessions) => {
                if (sessions.length === 0) {
                  setNotice('no sessions to resume')
                  return
                }
                setPicker(sessions)
                setPickerIndex(0)
              })
            return
          }
          default:
            setNotice(`unknown command: /${parsed.name}`)
        }
      })
    },
    [applyResume, applyDiffView, closeDiff, exit, runTurn],
  )

  useEffect(() => {
    const id = setInterval(() => {
      setTasks(runtimeRef.current.engine.tasks.list())
    }, 500)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    let inflight = false
    const id = setInterval(() => {
      if (inflight) return
      inflight = true
      void (async () => {
        try {
          const home = runtimeRef.current.config.home
          if (!busyRef.current) {
            const mail = await runtimeRef.current.store.peekAgentMail(
              runtimeRef.current.engine.session.id,
            )
            if (mail.length > 0) void runTurn('[mailbox]')
            try {
              await runtimeRef.current.store.renewSessionLock(
                runtimeRef.current.engine.session.id,
                runtimeRef.current.lockHolderId,
              )
            } catch {
              // idle renew is best-effort
            }
            try {
              const idle = maybePruneSkillsOnIdle({
                cwd: runtimeRef.current.cwd,
                ...(home !== undefined ? { home } : {}),
                lastActivityAt: lastActivityAtRef.current,
              })
              if (
                !cancelled &&
                idle.ran &&
                (idle.result.stale.length > 0 || idle.result.archived.length > 0)
              ) {
                setNotice(formatSkillPruneResult(idle.result))
              }
            } catch {
              // prune is best-effort
            }
          }
          const fired = await fireDueJobs({
            store: createJsonCronStore(home !== undefined ? { home } : undefined),
            run: (job) => fireCronJob(runtimeRef.current, job),
          })
          if (!cancelled && fired.length > 0) {
            const last = fired[fired.length - 1]
            if (last) setNotice(`cron ${last.job.id} ${last.status}`)
          }
        } catch {
          // ticker must not take down the live session
        } finally {
          inflight = false
        }
      })()
    }, 15_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  useInput((input, key) => {
    lastActivityAtRef.current = Date.now()
    if (key.ctrl && input === 'c') {
      exit()
      return
    }

    if (shouldToggleExpand(input, key)) {
      const id = selectedToolId(rows, selectedIndex) ?? lastToolId(rows)
      if (id !== undefined) setExpandedIds((prev) => toggleExpanded(prev, id))
      return
    }
    if (key.shift && key.upArrow) {
      setSelectedIndex((i) => {
        if (rows.length === 0) return undefined
        if (i === undefined) return rows.length - 1
        return Math.max(0, i - 1)
      })
      return
    }
    if (key.shift && key.downArrow) {
      setSelectedIndex((i) => {
        if (rows.length === 0) return undefined
        if (i === undefined) return 0
        return Math.min(rows.length - 1, i + 1)
      })
      return
    }

    if (key.escape) {
      if (diffOpenRef.current && !askRef.current) {
        closeDiff()
        return
      }
      const pending = askRef.current
      if (pending) pending.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      runtimeRef.current.engine.abort('cancel')
      if (abortGateRef.current.press() === 'kill_all') {
        const killed = runtimeRef.current.engine.tasks.killAll()
        setNotice(formatKilledBackgroundNotice(killed.length))
      }
      if (picker) setPicker(undefined)
      else if (!busy && !pending) setDraft('')
      return
    }

    if (diffOpen && diffView?.kind === 'files') {
      if (key.leftArrow) {
        setDiffSelected((index) => Math.max(0, index - 1))
        return
      }
      if (key.rightArrow) {
        setDiffSelected((index) => Math.min(diffView.files.length - 1, index + 1))
        return
      }
    }

    if (key.tab && key.shift) {
      const next = cyclePermissionMode(runtimeRef.current.engine.session.permissionMode)
      if (next === runtimeRef.current.engine.session.permissionMode) return
      void runtimeRef.current.engine.setPermissionMode(next).then(() => {
        setMode(next)
        setNotice(`mode ${next}`)
      })
      return
    }

    if (ask) {
      const answer = keyToPermission(input)
      if (answer && askRef.current) askRef.current.resolve(answer)
      return
    }

    if (picker) {
      if (key.upArrow) {
        setPickerIndex((i) => Math.max(0, i - 1))
        return
      }
      if (key.downArrow) {
        setPickerIndex((i) => Math.min(picker.length - 1, i + 1))
        return
      }
      if (key.return) {
        const chosen = picker[pickerIndex]
        setPicker(undefined)
        if (chosen) void applyResume(chosen.id)
      }
      return
    }

    if (key.upArrow) {
      const history = historyRef.current
      if (history.length === 0) return
      const idx = historyIndexRef.current
      const next = idx === null ? history.length - 1 : Math.max(0, idx - 1)
      historyIndexRef.current = next
      setDraft(history[next] ?? '')
      return
    }
    if (key.downArrow) {
      const history = historyRef.current
      const idx = historyIndexRef.current
      if (idx === null) return
      if (idx >= history.length - 1) {
        historyIndexRef.current = null
        setDraft('')
        return
      }
      historyIndexRef.current = idx + 1
      setDraft(history[idx + 1] ?? '')
      return
    }

    if (key.return) {
      const line = draft
      setDraft('')
      submitLine(line)
      return
    }
    if (key.backspace || key.delete) {
      setDraft((value) => value.slice(0, -1))
      return
    }
    if (input) setDraft((value) => value + input)
  })

  const compactSoon = nearCompact({
    estimatedTokens: lastAssembleInput,
    model: runtimeRef.current.config.profile,
    compact: compactPolicyFromConfig(runtimeRef.current.config.compact),
    usage: { input: lastAssembleInput },
  })

  return (
    <Box flexDirection="column">
      <Transcript
        rows={rows}
        selectedIndex={selectedIndex}
        expandedIds={expandedIds}
      />
      {diffOpen && diffLines ? (
        <DiffPanel lines={diffLines} />
      ) : diffOpen && diffView ? (
        <DiffPanel view={diffView} selected={diffSelected} />
      ) : null}
      <TodoPanel items={todos} />
      <ChildAgentList tasks={tasks} />
      {picker ? <ResumePicker sessions={picker} index={pickerIndex} /> : null}
      {ask ? <PermissionDialog event={ask} /> : null}
      {funding === 'included' ? (
        <AdDock
          enabled
          feedUrl={runtimeRef.current.config.ads.feedUrl}
          sessionId={sessionId}
          hasPaidCapacityPlan={runtimeRef.current.hasPaidCapacityPlan === true}
        />
      ) : null}
      <Composer value={draft} busy={busy} {...(notice !== undefined ? { notice } : {})} />
      <StatusLine
        model={model}
        mode={mode}
        usage={usage}
        sessionId={sessionId}
        funding={funding}
        compactSoon={compactSoon}
        usd={formatCostNotice({
          usage,
          profile: runtimeRef.current.config.profile,
          funding,
          remaining: runtimeRef.current.remainingSessions,
        })}
      />
    </Box>
  )
}

export async function replayPendingAsksTo(
  replay: () => AsyncGenerator<StreamEvent, void>,
  apply: (event: StreamEvent) => void,
): Promise<string | undefined> {
  try {
    for await (const ev of replay()) apply(ev)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function lastToolId(rows: TranscriptRow[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row?.kind === 'tool') return row.id
  }
  return undefined
}

function ResumePicker(props: { sessions: SessionRecord[]; index: number }) {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>Resume session</Text>
      {props.sessions.map((session, i) => {
        const title = session.title ?? new Date(session.updatedAt).toISOString().slice(0, 16)
        const line = `${shortSessionId(session.id)}  ${session.model}  ${title}`
        return (
          <Text key={session.id} inverse={i === props.index}>
            {line}
          </Text>
        )
      })}
    </Box>
  )
}
