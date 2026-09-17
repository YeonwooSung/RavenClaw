import {
  PersistError,
  SESSION_LOCK_TTL_MS,
  SessionLockError,
  sessionLockedMessage,
} from '../types'
import type {
  Message,
  PermissionRule,
  SessionListFilter,
  SessionRecord,
  SessionStore,
} from '../types'
import type { PendingAsk } from './pending-asks'
import { repairRoleAlternation } from '../loop/repair'
import { clipAgentMailBody } from '../tasks/mailbox'

type Stored = {
  message: Message
  active: boolean
}

type MemoryLock = {
  holderId: string
  holderPid?: number
  holderName?: string
  acquiredAt: number
  expiresAt: number
}

function claimMemoryLock(
  locks: Map<string, MemoryLock>,
  sessionId: string,
  opts: { holderId: string; holderName: string; ttlMs?: number },
): void {
  const now = Date.now()
  const existing = locks.get(sessionId)
  if (existing && existing.expiresAt < now) locks.delete(sessionId)
  const live = locks.get(sessionId)
  if (live && live.holderId !== opts.holderId) {
    throw new SessionLockError(sessionLockedMessage(live.holderName, live.expiresAt), {
      holderName: live.holderName,
      expiresAt: live.expiresAt,
    })
  }
  locks.set(sessionId, {
    holderId: opts.holderId,
    holderPid: process.pid,
    holderName: opts.holderName,
    acquiredAt: now,
    expiresAt: now + (opts.ttlMs ?? SESSION_LOCK_TTL_MS),
  })
}

export function createMemoryStore(): SessionStore {
  const sessions = new Map<string, SessionRecord>()
  const messages = new Map<string, Stored[]>()
  const assistantKind = new Map<string, 'assistant' | 'tool_calls'>()
  const rules = new Map<string, PermissionRule[]>()
  const mail = new Map<string, Array<{ id: number; createdAt: number; body: string }>>()
  const locks = new Map<string, MemoryLock>()
  const pendingAsks = new Map<string, PendingAsk>()
  let mailSeq = 0

  let tail: Promise<void> = Promise.resolve()
  let depth = 0

  async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (
        error instanceof PersistError &&
        (error.code === 'busy' || error.code === 'locked')
      ) {
        return await fn()
      }
      throw error
    }
  }

  async function withWrite<T>(fn: () => Promise<T>): Promise<T> {
    if (depth > 0) return retryOnce(fn)
    let release!: () => void
    const prev = tail
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await prev
    depth += 1
    try {
      return await retryOnce(fn)
    } finally {
      depth -= 1
      release()
    }
  }

  function kindKey(sessionId: string, id: string): string {
    return `${sessionId}:${id}`
  }

  function bucket(sessionId: string): Stored[] {
    let rows = messages.get(sessionId)
    if (!rows) {
      rows = []
      messages.set(sessionId, rows)
    }
    return rows
  }

  function readActiveMessages(sessionId: string): Message[] {
    return (messages.get(sessionId) ?? [])
      .filter((row) => row.active)
      .map((row) => row.message)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  function pushMessage(sessionId: string, message: Message): void {
    const rows = bucket(sessionId)
    if (rows.some((row) => row.message.id === message.id)) {
      throw new PersistError('unknown', `duplicate message id ${message.id}`)
    }
    rows.push({ message, active: true })
  }

  function hasToolUse(message: Extract<Message, { role: 'assistant' }>): boolean {
    return message.blocks.some((block) => block.type === 'tool_use')
  }

  function upsertAssistant(
    sessionId: string,
    message: Extract<Message, { role: 'assistant' }>,
    kind: 'assistant' | 'tool_calls',
  ): void {
    const key = kindKey(sessionId, message.id)
    const existingKind = assistantKind.get(key)
    if (existingKind !== undefined) {
      if (existingKind !== kind) {
        throw new PersistError('unknown', 'assistant row already persisted')
      }
      const row = bucket(sessionId).find((stored) => stored.message.id === message.id)
      if (row) row.message = message
      return
    }
    assistantKind.set(key, kind)
    pushMessage(sessionId, message)
  }

  const store: SessionStore = {
    async createSession(session) {
      await withWrite(async () => {
        if (sessions.has(session.id)) {
          throw new PersistError('unknown', `session exists: ${session.id}`)
        }
        sessions.set(session.id, { ...session })
      })
    },

    async upsertSession(session) {
      await withWrite(async () => {
        sessions.set(session.id, { ...session })
      })
    },

    async updateSessionTodos(sessionId, todos) {
      await withWrite(async () => {
        const sess = sessions.get(sessionId)
        if (!sess) {
          throw new PersistError('unknown', `session not found: ${sessionId}`)
        }
        sess.todos = todos
        sess.updatedAt = Date.now()
      })
    },

    async listSessions(filter?: SessionListFilter) {
      let rows = [...sessions.values()].map((row) => ({ ...row }))
      if (filter?.cwd !== undefined) {
        rows = rows.filter((row) => row.cwd === filter.cwd)
      }
      if (filter && 'parentSessionId' in filter) {
        if (filter.parentSessionId === null) {
          rows = rows.filter((row) => row.parentSessionId === undefined)
        } else if (filter.parentSessionId !== undefined) {
          rows = rows.filter((row) => row.parentSessionId === filter.parentSessionId)
        }
      }
      rows.sort((a, b) => b.updatedAt - a.updatedAt)
      if (filter?.limit !== undefined) rows = rows.slice(0, filter.limit)
      return rows
    },

    async loadSession(sessionId) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new PersistError('unknown', `session not found: ${sessionId}`)
      }
      const active = readActiveMessages(sessionId)
      const open = await store.listPendingAsks(sessionId)
      const repaired = repairRoleAlternation(active, new Set(open.map((r) => r.callId)))
      const existingIds = new Set(active.map((msg) => msg.id))
      const inserted = repaired.filter(
        (msg): msg is Extract<Message, { role: 'tool' }> =>
          msg.role === 'tool' && !existingIds.has(msg.id),
      )
      if (inserted.length > 0) {
        await store.persistToolResults(sessionId, inserted)
      }
      return { session: { ...session }, messages: repaired }
    },

    async loadMessages(sessionId) {
      if (!sessions.has(sessionId)) {
        throw new PersistError('unknown', `session not found: ${sessionId}`)
      }
      return readActiveMessages(sessionId)
    },

    async deleteSession(sessionId) {
      await withWrite(async () => {
        if (!sessions.has(sessionId)) {
          throw new PersistError('unknown', `session not found: ${sessionId}`)
        }
        const children = [...sessions.values()].filter((row) => row.parentSessionId === sessionId)
        for (const child of children) {
          await store.deleteSession(child.id)
        }
        sessions.delete(sessionId)
        messages.delete(sessionId)
        rules.delete(sessionId)
        mail.delete(sessionId)
        locks.delete(sessionId)
        for (const [callId, row] of pendingAsks) {
          if (row.sessionId === sessionId) pendingAsks.delete(callId)
        }
        for (const key of [...assistantKind.keys()]) {
          if (key.startsWith(`${sessionId}:`)) assistantKind.delete(key)
        }
      })
    },

    async upsertPendingAsk(row) {
      await withWrite(async () => {
        pendingAsks.set(row.callId, { ...row })
      })
    },

    async listPendingAsks(sessionId) {
      return [...pendingAsks.values()]
        .filter((row) => row.sessionId === sessionId)
        .map((row) => ({ ...row }))
        .sort((a, b) => a.createdAt - b.createdAt || a.callId.localeCompare(b.callId))
    },

    async getPendingAsk(callId) {
      const row = pendingAsks.get(callId)
      return row ? { ...row } : undefined
    },

    async deletePendingAsk(callId) {
      await withWrite(async () => {
        pendingAsks.delete(callId)
      })
    },

    async persistUser(sessionId, message) {
      await withWrite(async () => {
        pushMessage(sessionId, message)
      })
    },

    async persistAssistant(sessionId, message) {
      await withWrite(async () => {
        if (hasToolUse(message)) {
          throw new PersistError('unknown', 'persistAssistant cannot write tool_use')
        }
        upsertAssistant(sessionId, message, 'assistant')
      })
    },

    async persistToolCalls(sessionId, message) {
      await withWrite(async () => {
        if (!hasToolUse(message)) {
          throw new PersistError('unknown', 'persistToolCalls requires tool_use')
        }
        upsertAssistant(sessionId, message, 'tool_calls')
      })
    },

    async persistToolResults(sessionId, msgs) {
      await withWrite(async () => {
        const rows = bucket(sessionId)
        for (const msg of msgs) {
          const existing = rows.find((row) => row.message.id === msg.id)
          if (existing) {
            existing.message = msg
            existing.active = true
          } else {
            rows.push({ message: msg, active: true })
          }
        }
      })
    },

    async setPermissionRules(sessionId, next) {
      await withWrite(async () => {
        rules.set(
          sessionId,
          next.map((rule) => ({ ...rule })),
        )
      })
    },

    async listPermissionRules(sessionId) {
      return (rules.get(sessionId) ?? []).map((rule) => ({ ...rule }))
    },

    async recordCompact(sessionId, generation, _summary, inactivatedIds) {
      await withWrite(async () => {
        const sess = sessions.get(sessionId)
        if (sess) {
          sess.compactGeneration = generation
          sess.updatedAt = Date.now()
        }
        const ids = new Set(inactivatedIds)
        for (const row of bucket(sessionId)) {
          if (ids.has(row.message.id)) row.active = false
        }
      })
    },

    async enqueueAgentMail(parentSessionId, text) {
      await withWrite(async () => {
        const body = clipAgentMailBody(text)
        const queue = mail.get(parentSessionId)
        const row = { id: ++mailSeq, createdAt: Date.now(), body }
        if (queue) queue.push(row)
        else mail.set(parentSessionId, [row])
      })
    },

    async peekAgentMail(parentSessionId) {
      const queue = mail.get(parentSessionId)
      if (!queue || queue.length === 0) return []
      return queue.map((row) => row.body)
    },

    async drainAgentMail(parentSessionId) {
      return withWrite(async () => {
        const queue = mail.get(parentSessionId)
        if (!queue || queue.length === 0) return []
        mail.delete(parentSessionId)
        return queue.map((row) => row.body)
      })
    },

    async acquireSessionLock(sessionId, opts) {
      await withWrite(async () => {
        claimMemoryLock(locks, sessionId, opts)
      })
    },

    async renewSessionLock(sessionId, holderId, ttlMs) {
      await withWrite(async () => {
        const now = Date.now()
        const row = locks.get(sessionId)
        if (!row || row.holderId !== holderId) {
          throw new SessionLockError(
            sessionLockedMessage(row?.holderName, row?.expiresAt ?? now),
            row ? { holderName: row.holderName, expiresAt: row.expiresAt } : undefined,
          )
        }
        row.expiresAt = now + (ttlMs ?? SESSION_LOCK_TTL_MS)
      })
    },

    async releaseSessionLock(sessionId, holderId) {
      await withWrite(async () => {
        const row = locks.get(sessionId)
        if (row && row.holderId === holderId) locks.delete(sessionId)
      })
    },

    withWrite,
  }

  return store
}
