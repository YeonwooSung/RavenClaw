import { getSessionWorktree, runGit } from '../tools/session-worktree'
import { projectSessionTodos } from '../tools/todo'
import type { JobCheckpoint, Message, SessionRecord, SessionStore } from '../types'
import { formatUndoNotice, type FileHistory, type UndoResult } from './file-history'
import { clearSessionJobError, setSessionJobError } from './job'

export function dropLastUserTurn(messages: Message[]): Message[] {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUser = i
      break
    }
  }
  if (lastUser < 0) return messages
  return messages.slice(0, lastUser)
}

export function lastUserText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== 'user') continue
    const parts = msg.blocks.filter((b) => b.type === 'text').map((b) => b.text)
    const text = parts.join('')
    return text === '' ? undefined : text
  }
  return undefined
}

export function formatRewindNotice(undo: UndoResult, dropped: number): string {
  if (undo.blocked === true) return 'a turn is in progress'
  const filePart = formatUndoNotice(undo)
  const dropPart =
    dropped <= 0 ? undefined : dropped === 1 ? 'dropped 1 message' : `dropped ${dropped} messages`
  if (!dropPart) return filePart === 'nothing to undo' ? 'nothing to rewind' : filePart
  if (filePart === 'nothing to undo') return dropPart
  return `${filePart}; ${dropPart}`
}

export async function rewindLastTurn(opts: {
  fileHistory: FileHistory
  messages: Message[]
  store?: SessionStore
  sessionId?: string
  generation?: number
  session?: SessionRecord
}): Promise<{ ok: boolean; notice: string; messages: Message[] }> {
  if (opts.fileHistory.peekLast?.()?.open === true) {
    return {
      ok: false,
      notice: formatRewindNotice({ restored: [], removed: [], blocked: true }, 0),
      messages: opts.messages,
    }
  }

  const next = dropLastUserTurn(opts.messages)
  const droppedIds = opts.messages.slice(next.length).map((msg) => msg.id)
  if (opts.store !== undefined && opts.sessionId !== undefined && droppedIds.length > 0) {
    try {
      await opts.store.recordCompact(
        opts.sessionId,
        opts.generation ?? 0,
        'rewind',
        droppedIds,
      )
    } catch {
      return { ok: false, notice: 'rewind persist failed', messages: opts.messages }
    }
  }

  const undo = opts.fileHistory.undo()
  if (undo.blocked === true) {
    return { ok: false, notice: formatRewindNotice(undo, 0), messages: opts.messages }
  }

  let notice = formatRewindNotice(undo, droppedIds.length)
  if (droppedIds.length > 0 && opts.session && opts.store) {
    const snapshot = lastTodoCheckpoint(next)
    const hasAssistant = next.some((msg) => msg.role === 'assistant')
    if (!(snapshot === undefined && hasAssistant)) {
      const nextTodos = snapshot
        ? snapshot.todoSnapshot.map((item) => ({ ...item }))
        : []
      const toWrite = { ...opts.session, todos: nextTodos, updatedAt: Date.now() }
      try {
        await opts.store.upsertSession(toWrite)
      } catch {
        return { ok: false, notice: 'rewind persist failed', messages: next }
      }
      opts.session.todos = nextTodos
      opts.session.updatedAt = toWrite.updatedAt
      try {
        projectSessionTodos(opts.session.cwd, opts.session.todos ?? [])
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        notice = `${notice}; todo.json write failed: ${detail}`
      }
    }
  }

  return { ok: true, notice, messages: next }
}

function lastGitCheckpoint(messages: Message[]): JobCheckpoint | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const sha = msg?.role === 'assistant' ? msg.checkpoint?.commitSha : undefined
    if (msg?.role === 'assistant' && sha) return msg.checkpoint
  }
  return undefined
}

function lastTodoCheckpoint(messages: Message[]): JobCheckpoint | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'assistant' && msg.checkpoint) return msg.checkpoint
  }
  return undefined
}

export async function rewindToCheckpoint(opts: {
  session: SessionRecord
  messages: Message[]
  store: SessionStore
}): Promise<{ ok: boolean; notice: string; messages: Message[] }> {
  const job = opts.session.job
  if (!job) {
    return { ok: false, notice: 'nothing to rewind', messages: opts.messages }
  }

  const next = dropLastUserTurn(opts.messages)
  const droppedIds = opts.messages.slice(next.length).map((msg) => msg.id)
  const checkpoint = lastGitCheckpoint(next)
  const sha = checkpoint?.commitSha ?? job.baseCommitSha

  const nextSession: SessionRecord = {
    ...opts.session,
    job: { ...job, pendingResetSha: sha },
    updatedAt: Date.now(),
  }
  try {
    await opts.store.recordCompactAndUpsertSession({
      session: nextSession,
      inactivatedIds: droppedIds,
      generation: opts.session.compactGeneration,
      summary: 'rewind',
    })
  } catch {
    return { ok: false, notice: 'rewind persist failed', messages: opts.messages }
  }
  opts.session.job = nextSession.job
  opts.session.updatedAt = nextSession.updatedAt

  const reset = runGit(job.worktreePath, ['reset', '--hard', sha])
  if (!reset.ok) {
    const detail = reset.stderr.trim() || reset.stdout.trim() || 'git reset failed'
    const notice = `rewind reset failed: ${detail}`
    setSessionJobError(opts.session, notice)
    opts.session.updatedAt = Date.now()
    try {
      await opts.store.upsertSession(opts.session)
    } catch {
      // surface the reset failure even if jobError persist fails
    }
    return { ok: false, notice, messages: next }
  }

  const nextJob = { ...opts.session.job }
  delete nextJob.pendingResetSha
  opts.session.job = nextJob
  opts.session.todos = checkpoint
    ? checkpoint.todoSnapshot.map((item) => ({ ...item }))
    : []
  clearSessionJobError(opts.session)
  opts.session.updatedAt = Date.now()
  try {
    await opts.store.upsertSession(opts.session)
  } catch {
    return { ok: false, notice: 'rewind persist failed', messages: next }
  }

  const root = getSessionWorktree(opts.session.id)?.originalCwd ?? opts.session.cwd
  let notice = formatRewindNotice({ restored: [], removed: [] }, droppedIds.length)
  try {
    projectSessionTodos(root, opts.session.todos ?? [])
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    notice = `${notice}; todo.json write failed: ${detail}`
  }

  return { ok: true, notice, messages: next }
}

export async function maybeFinishRewindReset(opts: {
  session: SessionRecord
  store: SessionStore
  messages?: Message[]
}): Promise<{ ran: boolean; ok: boolean; notice?: string }> {
  const job = opts.session.job
  const sha = job?.pendingResetSha
  if (!job || !sha) return { ran: false, ok: true }

  const reset = runGit(job.worktreePath, ['reset', '--hard', sha])
  if (!reset.ok) {
    const detail = reset.stderr.trim() || reset.stdout.trim() || 'git reset failed'
    const notice = `rewind reset failed: ${detail}`
    setSessionJobError(opts.session, notice)
    opts.session.updatedAt = Date.now()
    try {
      await opts.store.upsertSession(opts.session)
    } catch {
      // surface the reset failure even if jobError persist fails
    }
    return { ran: true, ok: false, notice }
  }

  const rows = opts.messages ?? (opts.store.loadMessages ? await opts.store.loadMessages(opts.session.id) : [])
  const checkpoint = lastGitCheckpoint(rows)
  opts.session.todos = checkpoint
    ? checkpoint.todoSnapshot.map((item) => ({ ...item }))
    : []
  const nextJob = { ...job }
  delete nextJob.pendingResetSha
  opts.session.job = nextJob
  clearSessionJobError(opts.session)
  opts.session.updatedAt = Date.now()
  try {
    await opts.store.upsertSession(opts.session)
  } catch {
    return { ran: true, ok: false, notice: 'rewind persist failed' }
  }
  const root = getSessionWorktree(opts.session.id)?.originalCwd ?? opts.session.cwd
  let notice = formatRewindNotice({ restored: [], removed: [] }, 0)
  try {
    projectSessionTodos(root, opts.session.todos ?? [])
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    notice = `${notice}; todo.json write failed: ${detail}`
  }
  return { ran: true, ok: true, notice }
}
