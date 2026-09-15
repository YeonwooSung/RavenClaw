import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { applyMigrations } from './schema'
import { deletePendingAskRow, listPendingAskRows, upsertPendingAskRow } from './pending-asks'

test('upsert and list pending asks by session', async () => {
  const db = new Database(':memory:')
  applyMigrations(db)
  upsertPendingAskRow(db, {
    callId: 'call_1',
    sessionId: 's1',
    kind: 'leftover',
    tool: 'Bash',
    message: 'Run this command?',
    input: { command: 'ls' },
    createdAt: 1,
  })
  expect(listPendingAskRows(db, 's1')).toHaveLength(1)
  expect(listPendingAskRows(db, 's2')).toHaveLength(0)
  deletePendingAskRow(db, 'call_1')
  expect(listPendingAskRows(db, 's1')).toHaveLength(0)
})
