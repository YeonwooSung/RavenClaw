import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import {
  cyclePermissionMode,
  type Funding,
  type PermissionMode,
  type SessionRecord,
  type StreamEvent,
  type TokenUsage,
} from '@ravenclaw/core'
import { AdDock } from './ad-dock'
import { LEARN_PROMPT, REVIEW_PROMPT, SLASH_HELP, handleSlashCommand } from './commands'
import { formatCostNotice } from './cost-format'
import { runSessionReview } from './review'
import { searchNotice } from './search'
import { Composer } from './composer'
import { applySessionTitle } from './resume'
import {
  parsePermissionMode,
  resumeRuntime,
  type CliRuntime,
} from './engine'
import { keyToPermission, PermissionDialog, type PermissionAsk } from './permission-dialog'
import { StatusLine, shortSessionId } from './status-line'
import {
  applyStreamEvent,
  rowsFromMessages,
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
  const queueRef = useRef<string[]>([])
  const busyRef = useRef(false)
  const askRef = useRef<PendingAsk | null>(null)

  const [rows, setRows] = useState<TranscriptRow[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [mode, setMode] = useState<PermissionMode>(props.runtime.engine.session.permissionMode)
  const [usage, setUsage] = useState<TokenUsage>(props.runtime.engine.session.usage)
  const [sessionId, setSessionId] = useState(props.runtime.engine.session.id)
  const [model, setModel] = useState(props.runtime.engine.session.model)
  const [funding, setFunding] = useState<Funding>(props.runtime.engine.session.funding)
  const [ask, setAsk] = useState<PermissionAsk | undefined>(undefined)
  const [picker, setPicker] = useState<SessionRecord[] | undefined>(undefined)
  const [pickerIndex, setPickerIndex] = useState(0)

  const syncSession = useCallback(() => {
    const session = runtimeRef.current.engine.session
    setMode(session.permissionMode)
    setUsage(session.usage)
    setSessionId(session.id)
    setModel(session.model)
    setFunding(session.funding)
  }, [])

  useEffect(() => {
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
  }, [])

  const runTurn = useCallback(
    async (text: string) => {
      if (busyRef.current) {
        queueRef.current.push(text)
        return
      }
      busyRef.current = true
      setBusy(true)
      setNotice(undefined)
      setRows((prev) => [...prev, { kind: 'user', text }])
      try {
        const gen = runtimeRef.current.engine.submitMessage(text)
        while (true) {
          const next = await gen.next()
          if (next.done) break
          const event: StreamEvent = next.value
          if (event.type === 'usage') {
            setUsage((prev) => ({
              input: prev.input + event.usage.input,
              output: prev.output + event.usage.output,
              cacheRead: prev.cacheRead + event.usage.cacheRead,
              cacheWrite: prev.cacheWrite + event.usage.cacheWrite,
            }))
          }
          setRows((prev) => applyStreamEvent(prev, event))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setRows((prev) => [...prev, { kind: 'error', message }])
      } finally {
        syncSession()
        busyRef.current = false
        setBusy(false)
        const queued = queueRef.current.shift()
        if (queued !== undefined) void runTurn(queued)
      }
    },
    [syncSession],
  )

  const applyResume = useCallback(
    async (id: string) => {
      try {
        const next = await resumeRuntime(runtimeRef.current, id)
        runtimeRef.current = next
        setRows(rowsFromMessages((await next.store.loadSession(id)).messages))
        syncSession()
        setNotice(`resumed ${shortSessionId(id)}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setNotice(message)
      }
    },
    [syncSession],
  )

  const submitLine = useCallback(
    (line: string) => {
      const parsed = handleSlashCommand(line)
      if (parsed.type === 'prompt') {
        if (parsed.text === '') return
        void runTurn(parsed.text)
        return
      }
      switch (parsed.name) {
        case 'help':
        case '?':
          setNotice(SLASH_HELP)
          return
        case 'quit':
          exit()
          return
        case 'compact':
          void runtimeRef.current.engine.compactNow().then(() => {
            setNotice('compact requested')
          })
          return
        case 'cost':
          setNotice(
            formatCostNotice({
              usage: runtimeRef.current.engine.session.usage,
              profile: runtimeRef.current.config.profile,
              funding: runtimeRef.current.engine.session.funding,
            }),
          )
          return
        case 'search':
          setNotice(
            searchNotice({
              store: runtimeRef.current.store,
              arg: parsed.arg,
              sessionId: runtimeRef.current.engine.session.id,
            }),
          )
          return
        case 'learn':
          void runTurn(LEARN_PROMPT)
          return
        case 'title':
          if (parsed.arg === undefined || parsed.arg.trim() === '') {
            setNotice('usage: /title <name>')
            return
          }
          void applySessionTitle(
            runtimeRef.current.store,
            runtimeRef.current.engine.session,
            parsed.arg.trim(),
          ).then(() => {
            setNotice(`title ${parsed.arg?.trim()}`)
          })
          return
        case 'review':
          void runSessionReview(
            runtimeRef.current,
            parsed.arg ?? REVIEW_PROMPT,
          ).then((notice) => {
            setNotice(notice)
          })
          return
        case 'mode': {
          if (parsed.arg === undefined) {
            setNotice('usage: /mode default|acceptEdits|plan|dontAsk')
            return
          }
          const next = parsePermissionMode(parsed.arg)
          if (!next) {
            setNotice(`unknown mode: ${parsed.arg}`)
            return
          }
          void runtimeRef.current.engine.setPermissionMode(next).then(() => {
            setMode(next)
            setNotice(`mode ${next}`)
          })
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
    },
    [applyResume, exit, runTurn],
  )

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit()
      return
    }

    if (key.escape) {
      const pending = askRef.current
      if (pending) pending.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      runtimeRef.current.engine.abort()
      if (picker) setPicker(undefined)
      else if (!busy && !pending) setDraft('')
      return
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

  return (
    <Box flexDirection="column">
      <Transcript rows={rows} />
      {picker ? <ResumePicker sessions={picker} index={pickerIndex} /> : null}
      {ask ? <PermissionDialog event={ask} /> : null}
      {funding === 'included' ? (
        <AdDock
          enabled
          feedUrl={runtimeRef.current.config.ads.feedUrl}
          sessionId={sessionId}
        />
      ) : null}
      <Composer value={draft} busy={busy} {...(notice !== undefined ? { notice } : {})} />
      <StatusLine
        model={model}
        mode={mode}
        usage={usage}
        sessionId={sessionId}
        funding={funding}
        usd={formatCostNotice({
          usage,
          profile: runtimeRef.current.config.profile,
          funding,
        })}
      />
    </Box>
  )
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
