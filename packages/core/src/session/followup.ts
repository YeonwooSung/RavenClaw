import type { SessionRecord } from '../types'

export function followupNotice(text: string | null): string {
  return text == null || text === '' ? 'no follow-up' : text
}

export async function writeFollowup(
  session: SessionRecord,
  store: { upsertSession(session: SessionRecord): Promise<void> },
  text: string | null,
): Promise<{ ok: true } | { ok: false; notice: string }> {
  if (text !== null) {
    const trimmed = text.trim()
    if (trimmed === '') return { ok: false, notice: 'follow-up text required' }
    session.followup = trimmed
  } else {
    delete session.followup
  }
  session.updatedAt = Date.now()
  await store.upsertSession(session)
  return { ok: true }
}
