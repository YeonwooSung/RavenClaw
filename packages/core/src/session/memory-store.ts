import { PersistError } from '../types'
import type {
  Message,
  PermissionRule,
  SessionListFilter,
  SessionRecord,
  SessionStore,
} from '../types'
import { repairRoleAlternation } from '../loop/repair'

type Stored = {
  message: Message
  active: boolean
}

export function createMemoryStore(): SessionStore {
  const sessions = new Map<string, SessionRecord>()
  const messages = new Map<string, Stored[]>()
  const assistantKind = new Map<string, 'assistant' | 'tool_calls'>()
  const rules = new Map<string, PermissionRule[]>()

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
      const active = (messages.get(sessionId) ?? [])
        .filter((row) => row.active)
        .map((row) => row.message)
        .sort((a, b) => a.createdAt - b.createdAt)
      const repaired = repairRoleAlternation(active)
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
        const key = kindKey(sessionId, message.id)
        if (assistantKind.has(key)) {
          throw new PersistError('unknown', 'assistant row already persisted')
        }
        assistantKind.set(key, 'assistant')
        pushMessage(sessionId, message)
      })
    },

    async persistToolCalls(sessionId, message) {
      await withWrite(async () => {
        if (!hasToolUse(message)) {
          throw new PersistError('unknown', 'persistToolCalls requires tool_use')
        }
        const key = kindKey(sessionId, message.id)
        if (assistantKind.has(key)) {
          throw new PersistError('unknown', 'assistant row already persisted')
        }
        assistantKind.set(key, 'tool_calls')
        pushMessage(sessionId, message)
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

    withWrite,
  }

  return store
}
