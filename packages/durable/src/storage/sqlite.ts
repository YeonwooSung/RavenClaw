import { Database } from 'bun:sqlite'
import { copyStrict } from '../json.ts'
import type {
  DurableBatch,
  DurableConversationRow,
  DurableEntryRow,
  DurableStorage,
  DurableSubmissionRow,
  DurableTaskRow,
  JsonValue,
} from './types.ts'

const SCHEMA = 'ravenclaw-durable'
const VERSION = '1'

export async function openSqliteStorage(path: string): Promise<DurableStorage> {
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  migrate(db)
  return new SqliteStorage(db)
}

class SqliteStorage implements DurableStorage {
  constructor(private readonly db: Database) {}

  mintId(): number {
    const next = this.db.transaction(() => {
      const row = this.db.query('SELECT next_id FROM id_alloc').get() as { next_id: number } | null
      if (!row) throw new Error('id allocator is missing')
      this.db.run('UPDATE id_alloc SET next_id = ?', [row.next_id + 1])
      return row.next_id
    })
    return next()
  }

  commit(batch: DurableBatch): void {
    const conversations = (batch.conversations ?? []).map((row) => ({
      id: row.id,
      body: JSON.stringify(copyStrict(row)),
    }))
    const entries = (batch.entries ?? []).map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      body: JSON.stringify(copyStrict(row)),
    }))
    const tasks = (batch.tasks ?? []).map((row) => ({
      id: row.id,
      body: JSON.stringify(copyStrict(row)),
    }))
    const submissions = (batch.submissions ?? []).map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      requestId: row.requestId ?? null,
      body: JSON.stringify(copyStrict(row)),
    }))
    const documents = (batch.documents ?? []).map((row) => ({
      key: row.key,
      body: JSON.stringify(copyStrict(row.value)),
    }))
    const write = this.db.transaction(() => {
      const conversation = this.db.query(
        'INSERT INTO conversations (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body',
      )
      const entry = this.db.query('INSERT INTO entries (id, conversation_id, body) VALUES (?, ?, ?)')
      const task = this.db.query(
        'INSERT INTO tasks (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body',
      )
      const submission = this.db.query(
        `INSERT INTO submissions (id, conversation_id, request_id, body) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, request_id = excluded.request_id, body = excluded.body`,
      )
      const document = this.db.query(
        'INSERT INTO documents (key, body) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body',
      )
      for (const row of conversations) conversation.run(row.id, row.body)
      for (const row of entries) entry.run(row.id, row.conversationId, row.body)
      for (const row of tasks) task.run(row.id, row.body)
      for (const row of submissions) submission.run(row.id, row.conversationId, row.requestId, row.body)
      for (const row of documents) document.run(row.key, row.body)
    })
    write()
  }

  readConversation(id: number): DurableConversationRow | undefined {
    const row = this.db.query('SELECT body FROM conversations WHERE id = ?').get(id) as { body: string } | null
    return row ? decode<DurableConversationRow>(row.body) : undefined
  }

  readEntries(conversationId: number): DurableEntryRow[] {
    const rows = this.db
      .query('SELECT body FROM entries WHERE conversation_id = ? ORDER BY id')
      .all(conversationId) as { body: string }[]
    return rows.map((row) => decode<DurableEntryRow>(row.body))
  }

  readTask(id: number): DurableTaskRow | undefined {
    const row = this.db.query('SELECT body FROM tasks WHERE id = ?').get(id) as { body: string } | null
    return row ? decode<DurableTaskRow>(row.body) : undefined
  }

  readTasks(): DurableTaskRow[] {
    const rows = this.db.query('SELECT body FROM tasks ORDER BY id').all() as { body: string }[]
    return rows.map((row) => decode<DurableTaskRow>(row.body))
  }

  readSubmission(id: number): DurableSubmissionRow | undefined {
    const row = this.db.query('SELECT body FROM submissions WHERE id = ?').get(id) as { body: string } | null
    return row ? decode<DurableSubmissionRow>(row.body) : undefined
  }

  readSubmissionByRequest(conversationId: number, requestId: string): DurableSubmissionRow | undefined {
    const row = this.db
      .query('SELECT body FROM submissions WHERE conversation_id = ? AND request_id = ?')
      .get(conversationId, requestId) as { body: string } | null
    return row ? decode<DurableSubmissionRow>(row.body) : undefined
  }

  readDocument(key: string): JsonValue | undefined {
    const row = this.db.query('SELECT body FROM documents WHERE key = ?').get(key) as { body: string } | null
    return row ? decode<JsonValue>(row.body) : undefined
  }

  close(): void {
    this.db.close()
  }
}

function decode<T>(body: string): T {
  return copyStrict(JSON.parse(body) as unknown) as T
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      request_id TEXT,
      body TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS submissions_request
      ON submissions (conversation_id, request_id)
      WHERE request_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS documents (
      key TEXT PRIMARY KEY,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS id_alloc (
      next_id INTEGER NOT NULL
    );
  `)
  const schema = db.query("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | null
  if (!schema) {
    const init = db.transaction(() => {
      db.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['schema', SCHEMA])
      db.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['version', VERSION])
      db.run('INSERT INTO id_alloc (next_id) VALUES (?)', [2])
    })
    init()
    return
  }
  if (schema.value !== SCHEMA) throw new Error(`unknown durable schema ${schema.value}`)
  const version = db.query("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | null
  if (!version || version.value !== VERSION) {
    throw new Error(`unsupported durable schema version ${version?.value ?? 'missing'}`)
  }
}
