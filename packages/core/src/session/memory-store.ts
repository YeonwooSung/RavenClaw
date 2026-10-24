import {
  PersistError,
  SESSION_LOCK_TTL_MS,
  SessionLockError,
  sessionLockedMessage,
} from '../types'
import type {
  Message,
  PermissionRule,
  SequencedStreamEvent,
  SessionListFilter,
  SessionRecord,
  SessionStore,
} from '../types'
import type { PendingAsk } from './pending-asks'
import { repairRoleAlternation } from '../loop/repair'
import { clipAgentMailBody } from '../tasks/mailbox'
import { streamEventAskCallId, toSequencedStreamEvent } from './stream-events'

type Stored = {
  message: Message
  active: boolean
  parentId: string | null
}

type MemoryLock = {
  holderId: string
  holderPid?: number
  holderName?: string
  acquiredAt: number
  expiresAt: number
}

function assertCompactSpliceInserted(inserted: Message[]): void {
  const oneUser = inserted.length === 1 && inserted[0]?.role === 'user'
  const stubThenUser =
    inserted.length === 2 && inserted[0]?.role === 'assistant' && inserted[1]?.role === 'user'
  if (!oneUser && !stubThenUser) {
    throw new PersistError('unknown', 'invalid compact splice')
  }
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
  const streamEvents = new Map<string, SequencedStreamEvent[]>()
  const spliceGenerations = new Map<string, Set<number>>()
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

  function rowsOf(sessionId: string): Stored[] {
    return messages.get(sessionId) ?? []
  }

  function repairLeaf(sessionId: string): void {
    const sess = sessions.get(sessionId)
    if (!sess || sess.leafId === undefined) return
    const byId = new Map(rowsOf(sessionId).map((row) => [row.message.id, row]))
    const seen = new Set<string>()
    let id: string | null = sess.leafId
    while (id) {
      if (seen.has(id)) throw new PersistError('unknown', 'message cycle')
      seen.add(id)
      const row = byId.get(id)
      if (!row) {
        delete sess.leafId
        return
      }
      if (row.active) {
        sess.leafId = id
        return
      }
      id = row.parentId
    }
    delete sess.leafId
  }

  function readLeafPath(sessionId: string): Message[] {
    const sess = sessions.get(sessionId)
    if (!sess) throw new PersistError('unknown', `session not found: ${sessionId}`)
    if (sess.leafId === undefined) return []
    const byId = new Map(rowsOf(sessionId).map((row) => [row.message.id, row]))
    const leaf = byId.get(sess.leafId)
    if (!leaf) throw new PersistError('unknown', `leaf not found: ${sess.leafId}`)

    let start: Stored | undefined = leaf
    const guard = new Set<string>()
    while (start && !start.active) {
      if (guard.has(start.message.id)) throw new PersistError('unknown', 'message cycle')
      guard.add(start.message.id)
      if (start.parentId == null) return []
      const parent = byId.get(start.parentId)
      if (!parent) return []
      start = parent
    }
    if (!start?.active) return []

    const chain: Stored[] = []
    const seen = new Set<string>()
    let node: Stored | undefined = start
    while (node?.active) {
      if (seen.has(node.message.id)) throw new PersistError('unknown', 'message cycle')
      seen.add(node.message.id)
      chain.push(node)
      if (node.parentId == null) break
      const parent = byId.get(node.parentId)
      if (!parent || !parent.active) break
      node = parent
    }
    chain.reverse()
    return chain.map((row) => row.message)
  }

  function readActiveMessages(sessionId: string): Message[] {
    return readLeafPath(sessionId)
  }

  function pushMessage(sessionId: string, message: Message): void {
    const rows = bucket(sessionId)
    if (rows.some((row) => row.message.id === message.id)) {
      throw new PersistError('unknown', `duplicate message id ${message.id}`)
    }
    const sess = sessions.get(sessionId)
    rows.push({ message, active: true, parentId: sess?.leafId ?? null })
    if (sess) sess.leafId = message.id
  }

  function keepLeaf(next: SessionRecord, leafId: string | undefined): SessionRecord {
    const copy = { ...next }
    if (leafId !== undefined) copy.leafId = leafId
    else delete copy.leafId
    return copy
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
        sessions.set(session.id, keepLeaf(session, undefined))
      })
    },

    async upsertSession(session) {
      await withWrite(async () => {
        const prev = sessions.get(session.id)
        sessions.set(session.id, keepLeaf(session, prev?.leafId))
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

    async appendStreamEvent(sessionId, event) {
      return withWrite(async () => {
        const rows = streamEvents.get(sessionId) ?? []
        const askCallId = streamEventAskCallId(event)
        if (askCallId !== undefined) {
          const existing = rows.find(
            (row) => row.type === 'permission_ask' && row.id === askCallId,
          )
          if (existing) return existing.seq
        }
        const seq = (rows.at(-1)?.seq ?? 0) + 1
        const sequenced = toSequencedStreamEvent(event, seq)
        rows.push(sequenced)
        streamEvents.set(sessionId, rows)
        return seq
      })
    },

    async listStreamEventsAfter(sessionId, afterSeq) {
      return (streamEvents.get(sessionId) ?? [])
        .filter((row) => row.seq > afterSeq)
        .map((row) => ({ ...row }))
    },

    async lastStreamSeq(sessionId) {
      return streamEvents.get(sessionId)?.at(-1)?.seq ?? 0
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

    async listActiveMessageIds(sessionId) {
      if (!sessions.has(sessionId)) {
        throw new PersistError('unknown', `session not found: ${sessionId}`)
      }
      return rowsOf(sessionId).filter((row) => row.active).map((row) => row.message.id)
    },

    async listBranchNodes(sessionId) {
      if (!sessions.has(sessionId)) {
        throw new PersistError('unknown', `session not found: ${sessionId}`)
      }
      const rows = rowsOf(sessionId).filter((row) => row.active)
      rows.sort((a, b) => {
        if (a.message.createdAt !== b.message.createdAt) {
          return a.message.createdAt - b.message.createdAt
        }
        if (a.message.id < b.message.id) return -1
        if (a.message.id > b.message.id) return 1
        return 0
      })
      return rows.map((row) => ({ message: row.message, parentId: row.parentId }))
    },

    async branchAt(sessionId, messageId) {
      await withWrite(async () => {
        const sess = sessions.get(sessionId)
        if (!sess) throw new PersistError('unknown', `session not found: ${sessionId}`)
        const row = rowsOf(sessionId).find((item) => item.message.id === messageId)
        if (!row?.active) throw new PersistError('unknown', 'message is not on this session')
        sess.leafId = messageId
      })
      return readLeafPath(sessionId)
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
        spliceGenerations.delete(sessionId)
        rules.delete(sessionId)
        mail.delete(sessionId)
        locks.delete(sessionId)
        streamEvents.delete(sessionId)
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
            pushMessage(sessionId, msg)
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
        repairLeaf(sessionId)
      })
    },

    async spliceCompactPath(sessionId, opts) {
      await withWrite(async () => {
        const sess = sessions.get(sessionId)
        if (!sess) throw new PersistError('unknown', `session not found: ${sessionId}`)
        assertCompactSpliceInserted(opts.inserted)
        const seen = new Set<string>()
        const existing = new Set(rowsOf(sessionId).map((row) => row.message.id))
        for (const message of opts.inserted) {
          if (seen.has(message.id) || existing.has(message.id)) {
            throw new PersistError('unknown', `duplicate message id ${message.id}`)
          }
          seen.add(message.id)
        }
        const pathIds = new Set(readLeafPath(sessionId).map((message) => message.id))
        if (opts.boundaryId !== null && !pathIds.has(opts.boundaryId)) {
          throw new PersistError('unknown', 'compact boundary is not on this path')
        }
        if (opts.boundaryId !== null) {
          const byId = new Map(rowsOf(sessionId).map((row) => [row.message.id, row]))
          for (const row of byId.values()) {
            if (!row.active || pathIds.has(row.message.id)) continue
            const walked = new Set<string>()
            let id: string | null = row.message.id
            while (id !== null) {
              if (walked.has(id)) throw new PersistError('unknown', 'message cycle')
              walked.add(id)
              if (id === opts.boundaryId) {
                throw new PersistError('unknown', 'compact would move another branch')
              }
              id = byId.get(id)?.parentId ?? null
            }
          }
        }

        const rows = bucket(sessionId)
        const snapshot = rows.map((row) => ({
          message: row.message,
          active: row.active,
          parentId: row.parentId,
        }))
        const prevLeaf = sess.leafId
        const prevGeneration = sess.compactGeneration
        const prevUpdatedAt = sess.updatedAt
        const prevUsed = new Set(spliceGenerations.get(sessionId) ?? [])
        try {
          let parentId: string | null = null
          for (const message of opts.inserted) {
            rows.push({ message, active: true, parentId })
            parentId = message.id
          }
          const last = opts.inserted[opts.inserted.length - 1]
          if (!last) throw new PersistError('unknown', 'invalid compact splice')
          if (opts.boundaryId !== null) {
            const boundary = rows.find((row) => row.message.id === opts.boundaryId)
            if (boundary) boundary.parentId = last.id
          } else {
            sess.leafId = last.id
          }
          if (prevUsed.has(opts.generation)) {
            throw new PersistError('unknown', 'compact generation already used')
          }
          const nextUsed = new Set(prevUsed)
          nextUsed.add(opts.generation)
          spliceGenerations.set(sessionId, nextUsed)
          sess.compactGeneration = opts.generation
          sess.updatedAt = Date.now()
        } catch (error) {
          rows.length = 0
          rows.push(...snapshot)
          if (prevLeaf === undefined) delete sess.leafId
          else sess.leafId = prevLeaf
          sess.compactGeneration = prevGeneration
          sess.updatedAt = prevUpdatedAt
          if (prevUsed.size === 0) spliceGenerations.delete(sessionId)
          else spliceGenerations.set(sessionId, prevUsed)
          throw error
        }
      })
    },

    async recordCompactAndUpsertSession(opts) {
      await withWrite(async () => {
        const sessionId = opts.session.id
        const prevSession = sessions.get(sessionId)
        const prevMessages = bucket(sessionId).map((row) => ({
          message: row.message,
          active: row.active,
          parentId: row.parentId,
        }))
        try {
          const keptLeaf = prevSession?.leafId
          if (opts.inactivatedIds.length > 0) {
            const sess = sessions.get(sessionId)
            if (sess) {
              sess.compactGeneration = opts.generation
              sess.updatedAt = Date.now()
            }
            const ids = new Set(opts.inactivatedIds)
            for (const row of bucket(sessionId)) {
              if (ids.has(row.message.id)) row.active = false
            }
          }
          sessions.set(sessionId, keepLeaf(opts.session, keptLeaf))
          if (opts.inactivatedIds.length > 0) repairLeaf(sessionId)
        } catch (error) {
          if (prevSession) sessions.set(sessionId, prevSession)
          else sessions.delete(sessionId)
          const rows = bucket(sessionId)
          rows.length = 0
          rows.push(...prevMessages)
          throw error
        }
      })
    },

    async clearConversation(opts) {
      await withWrite(async () => {
        const sessionId = opts.session.id
        const prevSession = sessions.get(sessionId)
        const prevMessages = bucket(sessionId).map((row) => ({
          message: row.message,
          active: row.active,
          parentId: row.parentId,
        }))
        const prevAsks = [...pendingAsks.entries()]
          .filter(([, row]) => row.sessionId === sessionId)
          .map(([callId, row]) => [callId, { ...row }] as const)
        const prevStream = (streamEvents.get(sessionId) ?? []).map((row) => ({ ...row }))
        const prevMail = (mail.get(sessionId) ?? []).map((row) => ({ ...row }))
        try {
          const keptLeaf = prevSession?.leafId
          if (opts.inactivatedIds.length > 0) {
            const ids = new Set(opts.inactivatedIds)
            for (const row of bucket(sessionId)) {
              if (ids.has(row.message.id)) row.active = false
            }
          }
          for (const [callId, row] of pendingAsks) {
            if (row.sessionId === sessionId) pendingAsks.delete(callId)
          }
          streamEvents.delete(sessionId)
          await store.drainAgentMail(sessionId)
          sessions.set(sessionId, keepLeaf(opts.session, keptLeaf))
          if (opts.inactivatedIds.length > 0) repairLeaf(sessionId)
        } catch (error) {
          if (prevSession) sessions.set(sessionId, prevSession)
          else sessions.delete(sessionId)
          const rows = bucket(sessionId)
          rows.length = 0
          rows.push(...prevMessages)
          for (const [callId, row] of pendingAsks) {
            if (row.sessionId === sessionId) pendingAsks.delete(callId)
          }
          for (const [callId, row] of prevAsks) pendingAsks.set(callId, row)
          if (prevStream.length > 0) streamEvents.set(sessionId, prevStream)
          else streamEvents.delete(sessionId)
          if (prevMail.length > 0) mail.set(sessionId, prevMail)
          else mail.delete(sessionId)
          throw error
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
