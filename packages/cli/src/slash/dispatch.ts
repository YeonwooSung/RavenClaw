import {
  agentCatalog,
  buildSystemParts,
  discoverSkills,
  formatTasksNotice,
  formatUndoNotice,
  followupNotice,
  getModelProfile,
  LIFECYCLE_EVENTS,
  parseTasksArg,
  ravenclawHome,
  scanTeamOnboarding,
  setSkillDisabled,
  applySessionDraftPr,
  clearSessionJobError,
  enterSessionWorktree,
  getSessionWorktree,
  setJobAutoCommit,
  setSessionJobError,
} from '@ravenclaw/core'
import {
  INTERVIEW_PROMPT,
  LEARN_PROMPT,
  RELOAD_NOTICE,
  REVIEW_PROMPT,
  SLASH_HELP,
  TASKS_NOTICE,
  formatContextNotice,
  formatOnboardingTurn,
  formatPermissionsNotice,
  type SlashResult,
} from '../commands'
import { formatPublicConfig } from '../config-print'
import { copyConversationToClipboard, formatConversationMarkdown } from '../copy-conversation'
import { formatCostNotice } from '../cost-format'
import { applyCronMutate } from '../cron-cmd'
import { type CliRuntime, parsePermissionMode } from '../engine'
import { formatMcpList } from '../mcp-list'
import { applySessionTitle } from '../resume'
import { runSessionReview } from '../review'
import { searchNotice } from '../search'
import { formatSkillShow, formatSkillsList, parseSkillsSlashArg, runSkillsPrune } from '../skills-list'

const HOST_ONLY = new Set([
  'quit',
  'stop',
  'clear',
  'resume',
  'diff',
  'retry',
  'queue',
  'loop',
  'bash',
])

export interface SlashHost {
  runtime(): CliRuntime
  notice(text: string): void
  runTurn(prompt: string): void | Promise<void>
  onModelChanged?(model: string): void
  onModeChanged?(mode: string): void
  writeOsc52?(text: string): void
  gh?: (args: string[], cwd: string) => { ok: boolean; stdout: string; stderr: string }
}

export async function dispatchSharedSlash(
  parsed: Extract<SlashResult, { type: 'command' }>,
  host: SlashHost,
): Promise<'handled' | 'host'> {
  if (HOST_ONLY.has(parsed.name)) return 'host'

  const runtime = host.runtime()
  switch (parsed.name) {
    case 'help':
    case '?':
      host.notice(SLASH_HELP)
      return 'handled'
    case 'compact':
      await runtime.engine.compactNow()
      host.notice('compact requested')
      return 'handled'
    case 'cost':
      host.notice(
        formatCostNotice({
          usage: runtime.engine.session.usage,
          profile: runtime.config.profile,
          funding: runtime.engine.session.funding,
          remaining: runtime.remainingSessions,
          compactGeneration: runtime.engine.session.compactGeneration,
        }),
      )
      return 'handled'
    case 'model': {
      const session = runtime.engine.session
      if (parsed.arg === undefined || parsed.arg.trim() === '') {
        host.notice(`model ${session.model}`)
        return 'handled'
      }
      const id = parsed.arg.trim()
      const profile = getModelProfile(id, {
        ...(runtime.config.contextWindow !== undefined
          ? { contextWindow: runtime.config.contextWindow }
          : {}),
        ...(runtime.config.prices?.[id] !== undefined ? { prices: runtime.config.prices[id] } : {}),
      })
      await runtime.engine.setModel(profile)
      runtime.config.model = profile.id
      runtime.config.profile = profile
      host.onModelChanged?.(profile.id)
      await runtime.store.upsertSession(runtime.engine.session)
      host.notice(`model ${profile.id}`)
      return 'handled'
    }
    case 'reload':
      reloadSystem(runtime)
      host.notice(RELOAD_NOTICE)
      return 'handled'
    case 'tasks': {
      const parsedTasks = parseTasksArg(parsed.arg)
      if (parsedTasks.action === 'error') {
        host.notice(parsedTasks.message)
        return 'handled'
      }
      if (parsedTasks.action === 'steer') {
        const out = runtime.engine.tasks.steer(parsedTasks.id, parsedTasks.text)
        host.notice(out.ok ? `steered ${parsedTasks.id}` : `TaskSteer failed: ${out.error}`)
        return 'handled'
      }
      if (parsedTasks.action === 'kill') {
        const stopped = runtime.engine.tasks.kill(parsedTasks.id)
        host.notice(stopped ? `stopped ${stopped.id}` : `unknown task ${parsedTasks.id}`)
        return 'handled'
      }
      const listed = runtime.engine.tasks.list()
      host.notice(listed.length === 0 ? TASKS_NOTICE : formatTasksNotice(listed))
      return 'handled'
    }
    case 'undo':
      host.notice(formatUndoNotice(runtime.engine.fileHistory.undo()))
      return 'handled'
    case 'permissions': {
      let sessionRuleCount = 0
      try {
        sessionRuleCount = (await runtime.store.listPermissionRules(runtime.engine.session.id)).length
      } catch {
        sessionRuleCount = 0
      }
      host.notice(
        formatPermissionsNotice({
          home: runtime.config.home ?? '',
          cwd: runtime.cwd,
          sessionRuleCount,
        }),
      )
      return 'handled'
    }
    case 'context': {
      let messageCount = 0
      try {
        messageCount = (await runtime.store.loadSession(runtime.engine.session.id)).messages.length
      } catch {
        messageCount = 0
      }
      host.notice(formatContextNotice(runtime.engine.session.compactGeneration, messageCount))
      return 'handled'
    }
    case 'mcp':
      host.notice(formatMcpList(runtime.config.mcp?.servers ?? []))
      return 'handled'
    case 'skills':
      await dispatchSkills(parsed.arg, host, runtime)
      return 'handled'
    case 'rewind':
      host.notice((await runtime.engine.rewindLast()).notice)
      return 'handled'
    case 'add-dir':
      host.notice(
        parsed.arg === undefined || parsed.arg.trim() === ''
          ? 'usage: /add-dir <path> — this slash does not add a root; use the AddDir tool or --add-dir'
          : `this slash does not add a root; use the AddDir tool or --add-dir: ${parsed.arg}`,
      )
      return 'handled'
    case 'effort':
      host.notice(
        parsed.arg === undefined || parsed.arg.trim() === ''
          ? 'usage: /effort low|medium|high|max — hint only; does not persist (use --effort)'
          : `effort ${parsed.arg.trim()} (hint only; does not persist — use --effort)`,
      )
      return 'handled'
    case 'agents':
      host.notice(
        agentCatalog(runtime.cwd)
          .map((agent) => `${agent.id}  ${agent.displayName}`)
          .join('\n'),
      )
      return 'handled'
    case 'hooks':
      host.notice(LIFECYCLE_EVENTS.join('\n'))
      return 'handled'
    case 'steer':
      if (parsed.arg === undefined || parsed.arg.trim() === '') {
        host.notice('usage: /steer <text>')
        return 'handled'
      }
      runtime.engine.enqueueSteer(parsed.arg)
      runtime.engine.abort()
      host.notice('steered (next round)')
      return 'handled'
    case 'cron':
      host.notice(applyCronMutate(parsed.arg, runtime.cwd, runtime.config.home).text)
      return 'handled'
    case 'job': {
      const arg = parsed.arg?.trim() ?? ''
      if (arg === 'commit on' || arg === 'commit off') {
        const session = runtime.engine.session
        setJobAutoCommit(session, arg === 'commit on')
        session.updatedAt = Date.now()
        await runtime.store.upsertSession(session)
        host.notice(`job commit ${arg === 'commit on' ? 'on' : 'off'}`)
        return 'handled'
      }
      const session = runtime.engine.session
      const parent = getSessionWorktree(session.id)?.originalCwd ?? runtime.cwd
      const name = arg === '' ? undefined : arg
      const entered = enterSessionWorktree(session.id, parent, name)
      if (!entered.ok) {
        const notice = entered.error ?? 'job failed'
        setSessionJobError(session, notice)
        session.updatedAt = Date.now()
        await runtime.store.upsertSession(session)
        host.notice(notice)
        return 'handled'
      }
      if (entered.job) session.job = entered.job
      session.cwd = entered.cwd
      runtime.cwd = entered.cwd
      clearSessionJobError(session)
      session.updatedAt = Date.now()
      await runtime.store.upsertSession(session)
      host.notice(`job ${entered.job?.shadowBranch ?? entered.cwd}`)
      return 'handled'
    }
    case 'follow': {
      const arg = parsed.arg?.trim() ?? ''
      if (arg === '') {
        host.notice(followupNotice(runtime.engine.getFollowup()))
        return 'handled'
      }
      if (arg === 'clear') {
        await runtime.engine.clearFollowup()
        host.notice('no follow-up')
        return 'handled'
      }
      const result = await runtime.engine.setFollowup(arg)
      if (!result.ok) {
        host.notice(result.notice)
        return 'handled'
      }
      host.notice(followupNotice(runtime.engine.getFollowup()))
      return 'handled'
    }
    case 'pr': {
      const session = runtime.engine.session
      if (!session.job) {
        host.notice('no job record')
        return 'handled'
      }
      const title = parsed.arg?.trim()
      const out = await applySessionDraftPr({
        job: session.job,
        cwd: session.job.worktreePath,
        ...(title ? { title } : {}),
        ...(host.gh ? { gh: host.gh } : {}),
        sessionId: session.id,
        loadMessages: async () => (await runtime.store.loadSession(session.id)).messages,
        persistAssistant: (sessionId, message) => runtime.store.persistAssistant(sessionId, message),
        persistToolCalls: (sessionId, message) => runtime.store.persistToolCalls(sessionId, message),
      })
      if (out.job) session.job = out.job
      if (out.ok) clearSessionJobError(session)
      else setSessionJobError(session, out.notice)
      session.updatedAt = Date.now()
      await runtime.store.upsertSession(session)
      host.notice(out.notice)
      return 'handled'
    }
    case 'copy':
      await dispatchCopy(host, runtime)
      return 'handled'
    case 'interview':
      await host.runTurn(INTERVIEW_PROMPT)
      return 'handled'
    case 'team-onboarding': {
      const scan = await scanTeamOnboarding({
        cwd: runtime.cwd,
        home: ravenclawHome(),
        store: runtime.store,
        mcp: runtime.config.mcp ?? { servers: [] },
      })
      await host.runTurn(formatOnboardingTurn(scan))
      return 'handled'
    }
    case 'skill':
      if (parsed.arg === undefined || parsed.arg.trim() === '') {
        host.notice('usage: /skill:<name>')
        return 'handled'
      }
      await host.runTurn(`Use the Skill tool to load "${parsed.arg.trim()}" and follow its instructions.`)
      return 'handled'
    case 'config':
      host.notice(
        runtime.config.home !== undefined
          ? formatPublicConfig({ home: runtime.config.home })
          : 'see raven config',
      )
      return 'handled'
    case 'search':
      host.notice(
        searchNotice({
          store: runtime.store,
          arg: parsed.arg,
          sessionId: runtime.engine.session.id,
        }),
      )
      return 'handled'
    case 'learn':
      await host.runTurn(LEARN_PROMPT)
      return 'handled'
    case 'title':
      if (parsed.arg === undefined || parsed.arg.trim() === '') {
        host.notice('usage: /title <name>')
        return 'handled'
      }
      await applySessionTitle(runtime.store, runtime.engine.session, parsed.arg.trim())
      host.notice(`title ${parsed.arg.trim()}`)
      return 'handled'
    case 'review':
      host.notice(await runSessionReview(runtime, parsed.arg ?? REVIEW_PROMPT))
      return 'handled'
    case 'mode': {
      if (parsed.arg === undefined) {
        host.notice('usage: /mode default|acceptEdits|plan|dontAsk')
        return 'handled'
      }
      const next = parsePermissionMode(parsed.arg)
      if (!next) {
        host.notice(`unknown mode: ${parsed.arg}`)
        return 'handled'
      }
      await runtime.engine.setPermissionMode(next)
      host.onModeChanged?.(next)
      host.notice(`mode ${next}`)
      return 'handled'
    }
    default:
      host.notice(`unknown command: /${parsed.name}`)
      return 'handled'
  }
}

function reloadSystem(runtime: CliRuntime): void {
  runtime.engine.reloadSystem(
    buildSystemParts({
      cwd: runtime.cwd,
      permissionMode: runtime.engine.session.permissionMode,
    }),
  )
}

async function dispatchSkills(arg: string | undefined, host: SlashHost, runtime: CliRuntime): Promise<void> {
  const home = runtime.config.home
  const parsedSkills = parseSkillsSlashArg(arg)
  if (parsedSkills.action === 'error') {
    host.notice(parsedSkills.message)
    return
  }
  if (parsedSkills.action === 'list') {
    host.notice(formatSkillsList({ cwd: runtime.cwd, ...(home !== undefined ? { home } : {}) }))
    return
  }
  if (parsedSkills.action === 'prune') {
    host.notice(runSkillsPrune({ cwd: runtime.cwd, ...(home !== undefined ? { home } : {}) }))
    return
  }
  const skills = discoverSkills(runtime.cwd, home)
  const skill = skills.find((row) => row.name === parsedSkills.name)
  if (parsedSkills.action === 'show') {
    host.notice(skill ? formatSkillShow(skill.dir) : `unknown skill: ${parsedSkills.name}`)
    return
  }
  if (home === undefined) {
    host.notice('no home directory')
    return
  }
  setSkillDisabled(parsedSkills.name, parsedSkills.action === 'disable', home)
  reloadSystem(runtime)
  host.notice(`${parsedSkills.action}d ${parsedSkills.name}`)
}

async function dispatchCopy(host: SlashHost, runtime: CliRuntime): Promise<void> {
  try {
    const loaded = await runtime.store.loadSession(runtime.engine.session.id)
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
    if (copied.method === 'osc52') host.writeOsc52?.(copied.text)
    host.notice(copied.ok ? 'copied conversation' : 'copy failed')
  } catch {
    host.notice('copy failed')
  }
}
