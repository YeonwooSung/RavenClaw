import type { RoundEnd, SessionEngine, SessionRecord } from '../types'

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

const RUN_REASONS = new Set(['completed', 'hook_stopped', 'max_rounds', 'context_full'])
const CLEAR_REASONS = new Set([
  'cancelled',
  'aborted',
  'model_error',
  'persist_failed',
  'results_persist_failed',
])

export async function maybeRunFollowup(opts: {
  engine: {
    submitMessage: SessionEngine['submitMessage']
    getFollowup: () => string | null
    clearFollowup: () => Promise<void>
    liveTurnId: () => string | null
  }
  listPendingAsks: () => Promise<unknown[]>
  lastEnd: RoundEnd
  chain?: boolean
}): Promise<'ran' | 'cleared' | 'skipped'> {
  if (opts.chain === true) return 'skipped'
  if (opts.engine.liveTurnId() !== null) return 'skipped'
  const text = opts.engine.getFollowup()
  if (text == null) return 'skipped'
  if (CLEAR_REASONS.has(opts.lastEnd.reason)) {
    await opts.engine.clearFollowup()
    return 'cleared'
  }
  if (!RUN_REASONS.has(opts.lastEnd.reason)) return 'skipped'
  if ((await opts.listPendingAsks()).length > 0) return 'skipped'
  try {
    await opts.engine.clearFollowup()
  } catch {
    return 'skipped'
  }
  const gen = opts.engine.submitMessage({ text, turnPolicy: 'queue' })
  while (true) {
    const next = await gen.next()
    if (next.done) return 'ran'
  }
}
