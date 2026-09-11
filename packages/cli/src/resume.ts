import type { SessionRecord } from '@ravenclaw/core'

export function formatResumeSessionLine(session: SessionRecord): string {
  const label =
    session.title !== undefined && session.title !== '' ? session.title : session.model
  return `${session.id.slice(0, 8)}  ${label}  ${session.updatedAt}`
}
