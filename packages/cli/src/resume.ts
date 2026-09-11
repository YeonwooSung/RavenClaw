import { createSqliteStore, ravenclawHome, type SessionRecord } from '@ravenclaw/core'
import { join } from 'node:path'

export function formatResumeSessionLine(session: SessionRecord): string {
  const label =
    session.title !== undefined && session.title !== '' ? session.title : session.model
  return `${session.id.slice(0, 8)}  ${label}  ${session.updatedAt}`
}

export async function listCliSessions(opts?: {
  home?: string
  cwd?: string
  limit?: number
}): Promise<SessionRecord[]> {
  const home = opts?.home ?? ravenclawHome()
  const store = createSqliteStore(join(home, 'state.db')) as ReturnType<
    typeof createSqliteStore
  > & { close(): void }
  try {
    return await store.listSessions({
      cwd: opts?.cwd ?? process.cwd(),
      parentSessionId: null,
      limit: opts?.limit ?? 20,
    })
  } finally {
    store.close()
  }
}
