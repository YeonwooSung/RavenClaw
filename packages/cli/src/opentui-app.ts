import { createInterface } from 'node:readline'
import {
  composerLine,
  createOpenTuiView,
  permissionPromptLines,
} from '@ravenclaw/tui-opentui'
import {
  buildSystemParts,
  createJsonCronStore,
  fireDueJobs,
  parseLoopArg,
  startLoop,
  takeLoopTurn,
  formatLoopStatus,
  discoverSkills,
  setSkillDisabled,
  formatTasksNotice,
  formatUndoNotice,
  parseTasksArg,
  type StreamEvent,
} from '@ravenclaw/core'
import {
  INTERVIEW_PROMPT,
  LEARN_PROMPT,
  RELOAD_NOTICE,
  REVIEW_PROMPT,
  SLASH_HELP,
  TASKS_NOTICE,
  formatContextNotice,
  formatPermissionsNotice,
  handleSlashCommand,
} from './commands'
import { formatPublicConfig } from './config-print'
import { formatCostNotice } from './cost-format'
import { formatMcpList } from './mcp-list'
import { runSessionReview } from './review'
import { searchNotice } from './search'
import { applyCronMutate } from './cron-cmd'
import { fireCronJob } from './cron-fire'
import { formatSkillShow, formatSkillsList, parseSkillsSlashArg } from './skills-list'
import { openNewSession, parsePermissionMode, resumeRuntime, type CliRuntime } from './engine'
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
import { copyConversationToClipboard, formatConversationMarkdown } from './copy-conversation'
import { formatGitDiff } from './diff-cmd'
import { formatAskUserDialog, parseAskUserAnswer } from './ask-host'
import { loadIncludedDockLines } from './included-ads'
import { applySessionTitle, formatResumeSessionLine } from './resume'
import { formatStatusLine, shortSessionId } from './status-line'

export interface OpenTuiAppIo {
  input?: AsyncIterable<string>
  write?: (chunk: string) => void
  resumeRuntime?: (runtime: CliRuntime, sessionId: string) => Promise<CliRuntime>
  openNewSession?: (runtime: CliRuntime) => Promise<CliRuntime>
}

export async function runOpenTuiApp(
  runtime: CliRuntime,
  io: OpenTuiAppIo = {},
): Promise<number> {
  const write = io.write ?? ((chunk: string) => {
    process.stdout.write(chunk)
  })
  const resume = io.resumeRuntime ?? resumeRuntime
  const startNew = io.openNewSession ?? openNewSession
  const { input, close } = openInput(io.input)
  const readLine = lineReader(input)
  const view = createOpenTuiView()
  let current = runtime

  const flush = () => {
    const lines = view.lines()
    if (lines.length === 0) return
    write(`${lines.join('\n')}\n`)
  }

  const bindHosts = () => {
    current.ask.bind(async (event, signal) => {
      for (const line of permissionPromptLines(event)) write(`${line}\n`)
      if (signal.aborted) return 'deny'
      const answer = await readLine()
      if (answer === undefined || signal.aborted) return 'deny'
      return parsePermissionAnswer(answer)
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
  bindHosts()

  const queue = createMessageQueue()
  let turnBusy = false
  let loopState: import('@ravenclaw/core').LoopState | null = null

  const runTurn = async (text: string) => {
    if (turnBusy) {
      const n = enqueue(queue, text)
      write(`queued (${n})\n`)
      return
    }
    turnBusy = true
    const expanded = expandMentions(text, current.cwd)
    appendPrompt(text, current.config.home)
    view.append(`you  ${text}`)
    flush()
    try {
      const payload = collectUserImages(expanded.text, current.cwd, readClipboardImage)
      const gen = current.engine.submitMessage(payload)
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
    } finally {
      turnBusy = false
      const leftover = current.engine.drainSteering()
      if (leftover.length > 0) await runTurn(leftover.join('\n'))
      else {
        const queued = dequeue(queue)
        if (queued !== undefined) await runTurn(queued)
        else {
          const looped = takeLoopTurn(loopState)
          loopState = looped.next
          if (looped.prompt !== undefined) await runTurn(looped.prompt)
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

  let cronInflight = false
  const cronTimer = setInterval(() => {
    if (cronInflight) return
    cronInflight = true
    void (async () => {
      try {
        const home = current.config.home
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
    while (true) {
      write(`${composerLine()}\n`)
      const line = await readLine()
      if (line === undefined) return 0

      const parsed = handleSlashCommand(line)
      if (parsed.type === 'prompt') {
        if (parsed.text === '') {
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
            remaining: current.remainingSessions,
            compactGeneration: current.engine.session.compactGeneration,
          })}\n`)
          continue
        case 'clear': {
          try {
            await current.mcpCloser?.()
            current = await startNew(current)
            bindHosts()
            view.reset()
            write(`new session ${shortSessionId(current.engine.session.id)}\n`)
            await writeIncludedAds(current)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            write(`${message}\n`)
          }
          continue
        }
        case 'model': {
          const session = current.engine.session
          if (parsed.arg === undefined || parsed.arg.trim() === '') {
            write(`model ${session.model}\n`)
            continue
          }
          session.model = parsed.arg.trim()
          await current.store.upsertSession(session)
          write(`model ${session.model}\n`)
          continue
        }
        case 'reload':
          current.engine.reloadSystem(
            buildSystemParts({
              cwd: current.cwd,
              permissionMode: current.engine.session.permissionMode,
            }),
          )
          write(`${RELOAD_NOTICE}\n`)
          continue
        case 'tasks': {
          const parsedTasks = parseTasksArg(parsed.arg)
          if (parsedTasks.action === 'kill') {
            const stopped = current.engine.tasks.kill(parsedTasks.id)
            write(`${stopped ? `stopped ${stopped.id}` : `unknown task ${parsedTasks.id}`}\n`)
            continue
          }
          const listed = current.engine.tasks.list()
          write(`${listed.length === 0 ? TASKS_NOTICE : formatTasksNotice(listed)}\n`)
          continue
        }
        case 'undo': {
          write(`${formatUndoNotice(current.engine.fileHistory.undo())}\n`)
          continue
        }
        case 'permissions': {
          let sessionRuleCount = 0
          try {
            sessionRuleCount = (await current.store.listPermissionRules(current.engine.session.id)).length
          } catch {
            sessionRuleCount = 0
          }
          write(`${formatPermissionsNotice({
            home: current.config.home ?? '',
            cwd: current.cwd,
            sessionRuleCount,
          })}\n`)
          continue
        }
        case 'context': {
          let messageCount = 0
          try {
            messageCount = (await current.store.loadSession(current.engine.session.id)).messages.length
          } catch {
            messageCount = 0
          }
          write(`${formatContextNotice(current.engine.session.compactGeneration, messageCount)}\n`)
          continue
        }
        case 'mcp':
          write(`${formatMcpList(current.config.mcp?.servers ?? [])}\n`)
          continue
        case 'skills': {
          const home = current.config.home
          const parsedSkills = parseSkillsSlashArg(parsed.arg)
          if (parsedSkills.action === 'error') {
            write(`${parsedSkills.message}\n`)
            continue
          }
          if (parsedSkills.action === 'list') {
            write(`${formatSkillsList({ cwd: current.cwd, ...(home !== undefined ? { home } : {}) })}\n`)
            continue
          }
          const skills = discoverSkills(current.cwd, home)
          const skill = skills.find((row) => row.name === parsedSkills.name)
          if (parsedSkills.action === 'show') {
            write(`${skill ? formatSkillShow(skill.dir) : `unknown skill: ${parsedSkills.name}`}\n`)
            continue
          }
          if (home === undefined) {
            write('no home directory\n')
            continue
          }
          setSkillDisabled(parsedSkills.name, parsedSkills.action === 'disable', home)
          write(`${parsedSkills.action}d ${parsedSkills.name}\n`)
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
          if (first.prompt !== undefined) await runTurn(first.prompt)
          continue
        }
        case 'rewind':
          write(`${(await current.engine.rewindLast()).notice}\n`)
          continue
        case 'diff':
          write(`${formatGitDiff(current.cwd)}\n`)
          continue
        case 'steer': {
          if (parsed.arg === undefined || parsed.arg.trim() === '') {
            write('usage: /steer <text>\n')
            continue
          }
          current.engine.enqueueSteer(parsed.arg)
          write('steered (next round)\n')
          continue
        }
        case 'cron':
          write(`${applyCronMutate(parsed.arg, current.cwd, current.config.home).text}\n`)
          continue
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
        case 'copy': {
          try {
            const loaded = await current.store.loadSession(current.engine.session.id)
            const markdown = formatConversationMarkdown(
              loaded.messages.map((message) => ({
                role: message.role,
                text: message.blocks
                  .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
                  .map((block) => block.text)
                  .join(''),
              })),
            )
            const copied = copyConversationToClipboard(markdown)
            if (copied.method === 'osc52') write(copied.text)
            write(`${copied.ok ? 'copied conversation' : 'copy failed'}\n`)
          } catch {
            write('copy failed\n')
          }
          continue
        }
        case 'interview':
          await runTurn(INTERVIEW_PROMPT)
          continue
        case 'bash': {
          if (parsed.arg === undefined || parsed.arg.trim() === '') {
            write('usage: /bash <cmd>\n')
            continue
          }
          const result = runBangCommand(parsed.arg, current.cwd)
          write(`${result.text || `exit ${result.code}`}\n`)
          continue
        }
        case 'skill': {
          if (parsed.arg === undefined || parsed.arg.trim() === '') {
            write('usage: /skill:<name>\n')
            continue
          }
          await runTurn(`Use the Skill tool to load "${parsed.arg.trim()}" and follow its instructions.`)
          continue
        }
        case 'config':
          write(
            current.config.home !== undefined
              ? `${formatPublicConfig({ home: current.config.home })}\n`
              : 'see raven config\n',
          )
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
              bindHosts()
              write(`resumed ${shortSessionId(parsed.arg)}\n`)
              await writeIncludedAds(current)
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
