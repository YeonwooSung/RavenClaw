import { Database } from 'bun:sqlite'
import {
  PersistError,
  SESSION_LOCK_TTL_MS,
  SessionLockError,
  sessionLockedMessage,
} from '../types'
import type {
  Funding,
  JobCheckpoint,
  Message,
  PermissionMode,
  PermissionRule,
  SessionJob,
  SessionListFilter,
  SessionRecord,
  SessionStore,
  TokenUsage,
} from '../types'
import { clipAgentMailBody } from '../tasks/mailbox'
import { repairRoleAlternation } from '../loop/repair'
import { parseTodoItems, type TodoItem } from '../tools/todo'
import { applyMigrations } from './schema'
import {
  deletePendingAskRow,
  getPendingAskRow,
  listPendingAskRows,
  upsertPendingAskRow,
} from './pending-asks'
import {
  appendStreamEventRow,
  deleteStreamEventsBySession,
  lastStreamSeqRow,
  listStreamEventRowsAfter,
} from './stream-events'
import {
  indexMessageFts,
  searchMessages,
  unindexMessagesFts,
  type MessageSearchHit,
} from './search'

type SessionRow = {
  id: string
  created_at: number
  updated_at: number
  cwd: string
  model: string
  permission_mode: string
  pre_plan_mode: string | null
  compact_generation: number
  usage_json: string
  title: string | null
  parent_session_id: string | null
  funding: string
  todos_json: string | null
  job_json: string | null
  job_auto_commit: number
}

type MessageRow = {
  id: string
  session_id: string
  created_at: number
  role: string
  blocks_json: string
  tool_use_id: string | null
  ok: number | null
  persist_path: string | null
  usage_json: string | null
  read_mtime_ms: number | null
  checkpoint_json: string | null
  active: number
  generation: number
}

type RuleRow = {
  id: string
  session_id: string
  tool: string
  spec_json: string
  behavior: string
}

function sqliteCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

function sqliteErrno(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'errno' in error) {
    const errno = (error as { errno?: unknown }).errno
    if (typeof errno === 'number') return errno
  }
  return undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toPersistError(error: unknown): PersistError {
  if (error instanceof SessionLockError) throw error
  if (error instanceof PersistError) return error
  const code = sqliteCode(error)
  const errno = sqliteErrno(error)
  const message = errorMessage(error)
  if (code === 'SQLITE_BUSY' || code?.startsWith('SQLITE_BUSY') || errno === 5) {
    return new PersistError('busy', message)
  }
  if (code === 'SQLITE_LOCKED' || code?.startsWith('SQLITE_LOCKED') || errno === 6) {
    return new PersistError('locked', message)
  }
  if (
    code === 'SQLITE_CORRUPT' ||
    code === 'SQLITE_NOTADB' ||
    errno === 11 ||
    errno === 26
  ) {
    return new PersistError('corrupt', message)
  }
  if (code === 'SQLITE_READONLY' || code?.startsWith('SQLITE_READONLY') || errno === 8) {
    return new PersistError('readonly', message)
  }
  return new PersistError('unknown', message)
}

function isUniqueConstraint(error: unknown): boolean {
  const code = sqliteCode(error)
  const errno = sqliteErrno(error)
  return (
    code === 'SQLITE_CONSTRAINT' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    errno === 19 ||
    errno === 1555 ||
    errno === 2067
  )
}

function sessionFromRow(row: SessionRow): SessionRecord {
  const session: SessionRecord = {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cwd: row.cwd,
    model: row.model,
    permissionMode: row.permission_mode as PermissionMode,
    compactGeneration: row.compact_generation,
    usage: JSON.parse(row.usage_json) as TokenUsage,
    funding: row.funding as Funding,
  }
  if (row.pre_plan_mode != null) session.prePlanMode = row.pre_plan_mode as PermissionMode
  if (row.title != null) session.title = row.title
  if (row.parent_session_id != null) session.parentSessionId = row.parent_session_id
  const todos = todosFromJson(row.todos_json)
  if (todos !== undefined) session.todos = todos
  const job = jobFromJson(row.job_json)
  if (job !== undefined) session.job = job
  if (row.job_auto_commit === 1) session.jobAutoCommit = true
  return session
}

function jobFromJson(raw: string | null): SessionJob | undefined {
  if (raw == null) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<SessionJob>
    if (
      typeof parsed.baseBranch !== 'string' ||
      typeof parsed.shadowBranch !== 'string' ||
      typeof parsed.baseCommitSha !== 'string' ||
      typeof parsed.worktreePath !== 'string'
    ) {
      return undefined
    }
    const job: SessionJob = {
      baseBranch: parsed.baseBranch,
      shadowBranch: parsed.shadowBranch,
      baseCommitSha: parsed.baseCommitSha,
      worktreePath: parsed.worktreePath,
    }
    if (typeof parsed.prNumber === 'number') job.prNumber = parsed.prNumber
    if (typeof parsed.prUrl === 'string') job.prUrl = parsed.prUrl
    return job
  } catch {
    return undefined
  }
}

function todosFromJson(raw: string | null): TodoItem[] | undefined {
  if (raw == null) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return undefined
    return parseTodoItems(parsed)
  } catch {
    return undefined
  }
}

function checkpointFromJson(raw: string | null): JobCheckpoint | undefined {
  if (raw == null) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<JobCheckpoint>
    if (typeof parsed.commitSha !== 'string' || typeof parsed.dirty !== 'boolean') {
      return undefined
    }
    return {
      commitSha: parsed.commitSha,
      todoSnapshot: parseTodoItems(parsed.todoSnapshot),
      dirty: parsed.dirty,
    }
  } catch {
    return undefined
  }
}

function messageFromRow(row: MessageRow): Message {
  const blocks = JSON.parse(row.blocks_json) as Message['blocks']
  if (row.role === 'user') {
    return {
      id: row.id,
      role: 'user',
      blocks: blocks as Extract<Message, { role: 'user' }>['blocks'],
      createdAt: row.created_at,
    }
  }
  if (row.role === 'assistant') {
    const message: Extract<Message, { role: 'assistant' }> = {
      id: row.id,
      role: 'assistant',
      blocks: blocks as Extract<Message, { role: 'assistant' }>['blocks'],
      createdAt: row.created_at,
    }
    if (row.usage_json != null) message.usage = JSON.parse(row.usage_json) as TokenUsage
    const checkpoint = checkpointFromJson(row.checkpoint_json)
    if (checkpoint) message.checkpoint = checkpoint
    return message
  }
  if (row.role === 'tool') {
    const message: Extract<Message, { role: 'tool' }> = {
      id: row.id,
      role: 'tool',
      toolUseId: row.tool_use_id ?? '',
      ok: row.ok === 1,
      blocks: blocks as Extract<Message, { role: 'tool' }>['blocks'],
      createdAt: row.created_at,
    }
    if (row.persist_path != null) message.persistPath = row.persist_path
    if (row.read_mtime_ms != null) message.readMtimeMs = row.read_mtime_ms
    return message
  }
  throw new PersistError('corrupt', `unknown message role ${row.role}`)
}

function hasToolUse(message: Extract<Message, { role: 'assistant' }>): boolean {
  return message.blocks.some((block) => block.type === 'tool_use')
}

function sessionBind(session: SessionRecord) {
  return {
    $id: session.id,
    $created_at: session.createdAt,
    $updated_at: session.updatedAt,
    $cwd: session.cwd,
    $model: session.model,
    $permission_mode: session.permissionMode,
    $pre_plan_mode: session.prePlanMode ?? null,
    $compact_generation: session.compactGeneration,
    $usage_json: JSON.stringify(session.usage),
    $title: session.title ?? null,
    $parent_session_id: session.parentSessionId ?? null,
    $funding: session.funding,
    $todos_json: session.todos !== undefined ? JSON.stringify(session.todos) : null,
    $job_json: session.job !== undefined ? JSON.stringify(session.job) : null,
    $job_auto_commit: session.jobAutoCommit === true ? 1 : 0,
  }
}

function messageBind(sessionId: string, message: Message) {
  return {
    $id: message.id,
    $session_id: sessionId,
    $created_at: message.createdAt,
    $role: message.role,
    $blocks_json: JSON.stringify(message.blocks),
    $tool_use_id: message.role === 'tool' ? message.toolUseId : null,
    $ok: message.role === 'tool' ? (message.ok ? 1 : 0) : null,
    $persist_path:
      message.role === 'tool' && message.persistPath !== undefined
        ? message.persistPath
        : null,
    $usage_json:
      message.role === 'assistant' && message.usage !== undefined
        ? JSON.stringify(message.usage)
        : null,
    $read_mtime_ms:
      message.role === 'tool' && message.readMtimeMs !== undefined
        ? message.readMtimeMs
        : null,
    $checkpoint_json:
      message.role === 'assistant' && message.checkpoint !== undefined
        ? JSON.stringify(message.checkpoint)
        : null,
  }
}

const sqliteStoreDbs = new WeakMap<object, Database>()

export function searchSessionStore(
  store: SessionStore,
  query: string,
  opts?: { sessionId?: string; limit?: number },
): MessageSearchHit[] {
  const db = sqliteStoreDbs.get(store)
  if (!db) return []
  try {
    return searchMessages(db, query, opts)
  } catch {
    return []
  }
}

export function sqliteStoreDatabase(store: SessionStore): Database | undefined {
  return sqliteStoreDbs.get(store)
}

// One live writer per session id. withWrite is a process-local mutex
// (store-wide is ok). A second store instance on the same file may read.
export function createSqliteStore(dbPath: string): SessionStore {
  const db = new Database(dbPath, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  applyMigrations(db)

  const insertSession = db.query(
    `INSERT INTO sessions (
       id, created_at, updated_at, cwd, model, permission_mode, pre_plan_mode,
       compact_generation, usage_json, title, parent_session_id, funding, todos_json,
       job_json, job_auto_commit
     ) VALUES (
       $id, $created_at, $updated_at, $cwd, $model, $permission_mode, $pre_plan_mode,
       $compact_generation, $usage_json, $title, $parent_session_id, $funding, $todos_json,
       $job_json, $job_auto_commit
     )`,
  )
  const upsertSessionSql = db.query(
    `INSERT INTO sessions (
       id, created_at, updated_at, cwd, model, permission_mode, pre_plan_mode,
       compact_generation, usage_json, title, parent_session_id, funding, todos_json,
       job_json, job_auto_commit
     ) VALUES (
       $id, $created_at, $updated_at, $cwd, $model, $permission_mode, $pre_plan_mode,
       $compact_generation, $usage_json, $title, $parent_session_id, $funding, $todos_json,
       $job_json, $job_auto_commit
     )
     ON CONFLICT(id) DO UPDATE SET
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       cwd = excluded.cwd,
       model = excluded.model,
       permission_mode = excluded.permission_mode,
       pre_plan_mode = excluded.pre_plan_mode,
       compact_generation = excluded.compact_generation,
       usage_json = excluded.usage_json,
       title = excluded.title,
       parent_session_id = excluded.parent_session_id,
       funding = excluded.funding,
       todos_json = excluded.todos_json,
       job_json = excluded.job_json,
       job_auto_commit = excluded.job_auto_commit`,
  )
  const updateSessionTodosSql = db.query(
    `UPDATE sessions SET todos_json = ?, updated_at = ? WHERE id = ?`,
  )
  const selectSession = db.query(`SELECT * FROM sessions WHERE id = ?`)
  const insertMessage = db.query(
    `INSERT INTO messages (
       id, session_id, created_at, role, blocks_json, tool_use_id, ok,
       persist_path, usage_json, read_mtime_ms, checkpoint_json, active, generation
     ) VALUES (
       $id, $session_id, $created_at, $role, $blocks_json, $tool_use_id, $ok,
       $persist_path, $usage_json, $read_mtime_ms, $checkpoint_json, 1, 0
     )`,
  )
  const selectMessageById = db.query(`SELECT * FROM messages WHERE id = ?`)
  const updateMessage = db.query(
    `UPDATE messages SET
       session_id = $session_id,
       created_at = $created_at,
       role = $role,
       blocks_json = $blocks_json,
       tool_use_id = $tool_use_id,
       ok = $ok,
       persist_path = $persist_path,
       usage_json = $usage_json,
       read_mtime_ms = $read_mtime_ms,
       checkpoint_json = $checkpoint_json
     WHERE id = $id`,
  )
  const upsertTool = db.query(
    `INSERT INTO messages (
       id, session_id, created_at, role, blocks_json, tool_use_id, ok,
       persist_path, usage_json, read_mtime_ms, active, generation
     ) VALUES (
       $id, $session_id, $created_at, $role, $blocks_json, $tool_use_id, $ok,
       $persist_path, $usage_json, $read_mtime_ms, 1, 0
     )
     ON CONFLICT(id) DO UPDATE SET
       session_id = excluded.session_id,
       created_at = excluded.created_at,
       role = excluded.role,
       blocks_json = excluded.blocks_json,
       tool_use_id = excluded.tool_use_id,
       ok = excluded.ok,
       persist_path = excluded.persist_path,
       usage_json = excluded.usage_json,
       read_mtime_ms = excluded.read_mtime_ms,
       active = 1`,
  )
  const selectActiveMessages = db.query(
    `SELECT * FROM messages WHERE session_id = ? AND active = 1 ORDER BY created_at`,
  )
  const inactivateMessage = db.query(`UPDATE messages SET active = 0 WHERE id = ?`)
  const insertBoundary = db.query(
    `INSERT INTO compact_boundaries (session_id, generation, created_at, summary)
     VALUES (?, ?, ?, ?)`,
  )
  const bumpCompact = db.query(
    `UPDATE sessions SET compact_generation = ?, updated_at = ? WHERE id = ?`,
  )
  const deleteRules = db.query(`DELETE FROM permission_rules WHERE session_id = ?`)
  const deletePendingAsksBySession = db.query(`DELETE FROM pending_asks WHERE session_id = ?`)
  const deleteFtsBySession = db.query(`DELETE FROM messages_fts WHERE session_id = ?`)
  const deleteMessagesBySession = db.query(`DELETE FROM messages WHERE session_id = ?`)
  const deleteBoundariesBySession = db.query(`DELETE FROM compact_boundaries WHERE session_id = ?`)
  const deleteSessionRow = db.query(`DELETE FROM sessions WHERE id = ?`)
  const selectChildIds = db.query(`SELECT id FROM sessions WHERE parent_session_id = ?`)
  const insertRule = db.query(
    `INSERT INTO permission_rules (id, session_id, tool, spec_json, behavior)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const selectRules = db.query(`SELECT * FROM permission_rules WHERE session_id = ?`)
  const insertMail = db.query(
    `INSERT INTO agent_mail (parent_session_id, created_at, body) VALUES (?, ?, ?)`,
  )
  const selectMail = db.query(
    `SELECT id, body FROM agent_mail WHERE parent_session_id = ? ORDER BY created_at, id`,
  )
  const deleteMailByIds = db.query(`DELETE FROM agent_mail WHERE id = ?`)
  const deleteExpiredLock = db.query(
    `DELETE FROM session_locks WHERE session_id = ? AND expires_at < ?`,
  )
  const selectLock = db.query(
    `SELECT holder_id, holder_name, expires_at FROM session_locks WHERE session_id = ?`,
  )
  const upsertLock = db.query(
    `INSERT INTO session_locks (
       session_id, holder_id, holder_pid, holder_name, acquired_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       holder_id = excluded.holder_id,
       holder_pid = excluded.holder_pid,
       holder_name = excluded.holder_name,
       acquired_at = excluded.acquired_at,
       expires_at = excluded.expires_at`,
  )
  const updateLockExpiry = db.query(
    `UPDATE session_locks SET expires_at = ? WHERE session_id = ? AND holder_id = ?`,
  )
  const deleteLock = db.query(
    `DELETE FROM session_locks WHERE session_id = ? AND holder_id = ?`,
  )

  let tail: Promise<void> = Promise.resolve()
  let depth = 0

  function beginImmediate<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // already rolled back
      }
      throw error
    }
  }

  async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof SessionLockError) throw error
      const mapped = toPersistError(error)
      if (mapped.code === 'busy' || mapped.code === 'locked') {
        try {
          return await fn()
        } catch (retryError) {
          if (retryError instanceof SessionLockError) throw retryError
          throw toPersistError(retryError)
        }
      }
      throw mapped
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

  function insertMessageRow(sessionId: string, message: Message): void {
    const bind = messageBind(sessionId, message)
    try {
      insertMessage.run(bind)
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new PersistError('unknown', `duplicate message id ${message.id}`)
      }
      throw error
    }
    indexMessageFts(db, sessionId, message, bind.$blocks_json)
  }

  function assistantPersistKind(
    message: Extract<Message, { role: 'assistant' }>,
  ): 'assistant' | 'tool_calls' {
    return hasToolUse(message) ? 'tool_calls' : 'assistant'
  }

  function existingAssistantPersistKind(row: MessageRow): 'assistant' | 'tool_calls' | undefined {
    if (row.role !== 'assistant') return undefined
    try {
      const blocks = JSON.parse(row.blocks_json) as Array<{ type?: string }>
      return blocks.some((block) => block.type === 'tool_use') ? 'tool_calls' : 'assistant'
    } catch {
      return 'assistant'
    }
  }

  function persistAssistantRow(
    sessionId: string,
    message: Extract<Message, { role: 'assistant' }>,
    kind: 'assistant' | 'tool_calls',
  ): void {
    if (assistantPersistKind(message) !== kind) {
      throw new PersistError(
        'unknown',
        kind === 'tool_calls'
          ? 'persistToolCalls requires tool_use'
          : 'persistAssistant cannot write tool_use',
      )
    }
    const existing = selectMessageById.get(message.id) as MessageRow | null
    if (existing) {
      if (existingAssistantPersistKind(existing) !== kind) {
        throw new PersistError('unknown', 'assistant row already persisted')
      }
      const bind = messageBind(sessionId, message)
      updateMessage.run(bind)
      indexMessageFts(db, sessionId, message, bind.$blocks_json)
      return
    }
    insertMessageRow(sessionId, message)
  }

  const persistToolsTx = db.transaction(
    (sessionId: string, msgs: Array<Extract<Message, { role: 'tool' }>>) => {
      for (const msg of msgs) {
        const bind = messageBind(sessionId, msg)
        upsertTool.run(bind)
        indexMessageFts(db, sessionId, msg, bind.$blocks_json)
      }
    },
  )

  const setRulesTx = db.transaction((sessionId: string, rules: PermissionRule[]) => {
    deleteRules.run(sessionId)
    for (const rule of rules) {
      insertRule.run(
        rule.id,
        sessionId,
        rule.tool,
        JSON.stringify(rule.spec),
        rule.behavior,
      )
    }
  })

  const recordCompactTx = db.transaction(
    (sessionId: string, generation: number, summary: string, inactivatedIds: string[]) => {
      for (const id of inactivatedIds) {
        inactivateMessage.run(id)
      }
      insertBoundary.run(sessionId, generation, Date.now(), summary)
      bumpCompact.run(generation, Date.now(), sessionId)
    },
  )

  function readActiveMessages(sessionId: string): Message[] {
    return (selectActiveMessages.all(sessionId) as MessageRow[]).map(messageFromRow)
  }

  const store: SessionStore & { close(): void } = {
    async createSession(session) {
      await withWrite(async () => {
        try {
          insertSession.run(sessionBind(session))
        } catch (error) {
          if (isUniqueConstraint(error)) {
            throw new PersistError('unknown', `session exists: ${session.id}`)
          }
          throw error
        }
      })
    },

    async upsertSession(session) {
      await withWrite(async () => {
        upsertSessionSql.run(sessionBind(session))
      })
    },

    async updateSessionTodos(sessionId, todos) {
      await withWrite(async () => {
        const result = updateSessionTodosSql.run(JSON.stringify(todos), Date.now(), sessionId)
        if (result.changes === 0) {
          throw new PersistError('unknown', `session not found: ${sessionId}`)
        }
      })
    },

    async appendStreamEvent(sessionId, event) {
      return withWrite(async () => beginImmediate(() => appendStreamEventRow(db, sessionId, event)))
    },

    async listStreamEventsAfter(sessionId, afterSeq) {
      try {
        return listStreamEventRowsAfter(db, sessionId, afterSeq)
      } catch (error) {
        throw toPersistError(error)
      }
    },

    async lastStreamSeq(sessionId) {
      try {
        return lastStreamSeqRow(db, sessionId)
      } catch (error) {
        throw toPersistError(error)
      }
    },

    async listSessions(filter?: SessionListFilter) {
      const where: string[] = []
      const params: Array<string | number> = []
      if (filter?.cwd !== undefined) {
        where.push('cwd = ?')
        params.push(filter.cwd)
      }
      if (filter && 'parentSessionId' in filter) {
        if (filter.parentSessionId === null) {
          where.push('parent_session_id IS NULL')
        } else if (filter.parentSessionId !== undefined) {
          where.push('parent_session_id = ?')
          params.push(filter.parentSessionId)
        }
      }
      let sql = 'SELECT * FROM sessions'
      if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`
      sql += ' ORDER BY updated_at DESC'
      if (filter?.limit !== undefined) {
        sql += ' LIMIT ?'
        params.push(filter.limit)
      }
      const rows = db.query(sql).all(...params) as SessionRow[]
      return rows.map(sessionFromRow)
    },

    async loadSession(sessionId) {
      let session: SessionRecord
      let active: Message[]
      try {
        const row = selectSession.get(sessionId) as SessionRow | null
        if (!row) {
          throw new PersistError('unknown', `session not found: ${sessionId}`)
        }
        session = sessionFromRow(row)
        active = readActiveMessages(sessionId)
      } catch (error) {
        throw toPersistError(error)
      }
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
      return { session, messages: repaired }
    },

    async loadMessages(sessionId) {
      try {
        const row = selectSession.get(sessionId) as SessionRow | null
        if (!row) {
          throw new PersistError('unknown', `session not found: ${sessionId}`)
        }
        return readActiveMessages(sessionId)
      } catch (error) {
        throw toPersistError(error)
      }
    },

    async deleteSession(sessionId) {
      await withWrite(async () => {
        const row = selectSession.get(sessionId) as SessionRow | null
        if (!row) {
          throw new PersistError('unknown', `session not found: ${sessionId}`)
        }
        const children = selectChildIds.all(sessionId) as Array<{ id: string }>
        for (const child of children) {
          await store.deleteSession(child.id)
        }
        try {
          deleteFtsBySession.run(sessionId)
        } catch {
          /* FTS is fail-open */
        }
        deleteMessagesBySession.run(sessionId)
        deleteBoundariesBySession.run(sessionId)
        deleteRules.run(sessionId)
        deletePendingAsksBySession.run(sessionId)
        deleteStreamEventsBySession(db, sessionId)
        deleteSessionRow.run(sessionId)
      })
    },

    async upsertPendingAsk(row) {
      await withWrite(async () => {
        upsertPendingAskRow(db, row)
      })
    },

    async listPendingAsks(sessionId) {
      return listPendingAskRows(db, sessionId)
    },

    async getPendingAsk(callId) {
      return getPendingAskRow(db, callId)
    },

    async deletePendingAsk(callId) {
      await withWrite(async () => {
        deletePendingAskRow(db, callId)
      })
    },

    async persistUser(sessionId, message) {
      await withWrite(async () => {
        insertMessageRow(sessionId, message)
      })
    },

    async persistAssistant(sessionId, message) {
      await withWrite(async () => {
        persistAssistantRow(sessionId, message, 'assistant')
      })
    },

    async persistToolCalls(sessionId, message) {
      await withWrite(async () => {
        persistAssistantRow(sessionId, message, 'tool_calls')
      })
    },

    async persistToolResults(sessionId, msgs) {
      await withWrite(async () => {
        persistToolsTx(sessionId, msgs)
      })
    },

    async setPermissionRules(sessionId, rules) {
      await withWrite(async () => {
        setRulesTx(sessionId, rules)
      })
    },

    async listPermissionRules(sessionId) {
      const rows = selectRules.all(sessionId) as RuleRow[]
      return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        tool: row.tool,
        spec: JSON.parse(row.spec_json) as unknown,
        behavior: row.behavior as PermissionRule['behavior'],
      }))
    },

    async recordCompact(sessionId, generation, summary, inactivatedIds) {
      await withWrite(async () => {
        recordCompactTx(sessionId, generation, summary, inactivatedIds)
        unindexMessagesFts(db, inactivatedIds)
      })
    },

    async enqueueAgentMail(parentSessionId, text) {
      await withWrite(async () => {
        insertMail.run(parentSessionId, Date.now(), clipAgentMailBody(text))
      })
    },

    async peekAgentMail(parentSessionId) {
      const rows = selectMail.all(parentSessionId) as Array<{ id: number; body: string }>
      return rows.map((row) => row.body)
    },

    async drainAgentMail(parentSessionId) {
      return withWrite(async () =>
        beginImmediate(() => {
          const rows = selectMail.all(parentSessionId) as Array<{ id: number; body: string }>
          for (const row of rows) deleteMailByIds.run(row.id)
          return rows.map((row) => row.body)
        }),
      )
    },

    async acquireSessionLock(sessionId, opts) {
      await withWrite(async () => {
        beginImmediate(() => {
          const now = Date.now()
          const ttl = opts.ttlMs ?? SESSION_LOCK_TTL_MS
          deleteExpiredLock.run(sessionId, now)
          const row = selectLock.get(sessionId) as
            | { holder_id: string; holder_name: string | null; expires_at: number }
            | null
          if (row && row.holder_id !== opts.holderId) {
            throw new SessionLockError(sessionLockedMessage(row.holder_name ?? undefined, row.expires_at), {
              holderName: row.holder_name ?? undefined,
              expiresAt: row.expires_at,
            })
          }
          upsertLock.run(
            sessionId,
            opts.holderId,
            process.pid,
            opts.holderName,
            now,
            now + ttl,
          )
        })
      })
    },

    async renewSessionLock(sessionId, holderId, ttlMs) {
      await withWrite(async () => {
        beginImmediate(() => {
          const now = Date.now()
          const row = selectLock.get(sessionId) as
            | { holder_id: string; holder_name: string | null; expires_at: number }
            | null
          if (!row || row.holder_id !== holderId) {
            throw new SessionLockError(
              sessionLockedMessage(row?.holder_name ?? undefined, row?.expires_at ?? now),
              row
                ? { holderName: row.holder_name ?? undefined, expiresAt: row.expires_at }
                : undefined,
            )
          }
          updateLockExpiry.run(now + (ttlMs ?? SESSION_LOCK_TTL_MS), sessionId, holderId)
        })
      })
    },

    async releaseSessionLock(sessionId, holderId) {
      await withWrite(async () => {
        deleteLock.run(sessionId, holderId)
      })
    },

    withWrite,

    search(query, opts) {
      try {
        return searchMessages(db, query, opts)
      } catch {
        return []
      }
    },

    close() {
      db.close()
    },
  }

  sqliteStoreDbs.set(store, db)
  return store
}
