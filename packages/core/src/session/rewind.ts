import { runGit } from '../tools/session-worktree'
import type { JobCheckpoint, Message, SessionRecord, SessionStore } from '../types'
import { formatUndoNotice, type FileHistory, type UndoResult } from './file-history'

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

  return { ok: true, notice: formatRewindNotice(undo, droppedIds.length), messages: next }
}

function lastAssistantCheckpoint(messages: Message[]): JobCheckpoint | undefined {
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
  if (droppedIds.length > 0) {
    try {
      await opts.store.recordCompact(
        opts.session.id,
        opts.session.compactGeneration,
        'rewind',
        droppedIds,
      )
    } catch {
      return { ok: false, notice: 'rewind persist failed', messages: opts.messages }
    }
  }

  const checkpoint = lastAssistantCheckpoint(next)
  const sha = checkpoint?.commitSha ?? job.baseCommitSha
  const reset = runGit(job.worktreePath, ['reset', '--hard', sha])
  if (!reset.ok) {
    const detail = reset.stderr.trim() || reset.stdout.trim() || 'git reset failed'
    return { ok: false, notice: `rewind reset failed: ${detail}`, messages: next }
  }

  opts.session.todos = checkpoint
    ? checkpoint.todoSnapshot.map((item) => ({ ...item }))
    : []
  opts.session.updatedAt = Date.now()
  try {
    await opts.store.upsertSession(opts.session)
  } catch {
    return { ok: false, notice: 'rewind persist failed', messages: next }
  }

  return {
    ok: true,
    notice: formatRewindNotice({ restored: [], removed: [] }, droppedIds.length),
    messages: next,
  }
}
