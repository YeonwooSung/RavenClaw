import type { RoundEnd, SessionEngine, SessionRecord } from '../types'

export function lastEndWrittenThisTurn(
  before: RoundEnd | undefined,
  after: RoundEnd | undefined,
): RoundEnd | undefined {
  if (after == null || after === before) return undefined
  return after
}

export async function listOwnedPendingAsks(
  store:
    | {
        listPendingAsks?: (sessionId: string) => Promise<unknown[]>
        listSessions?: (filter: { parentSessionId: string }) => Promise<Array<{ id: string }>>
      }
    | undefined,
  sessionId: string,
): Promise<unknown[]> {
  if (!store?.listPendingAsks) return []
  const own = await store.listPendingAsks(sessionId)
  if (!store.listSessions) return own
  const children = await store.listSessions({ parentSessionId: sessionId })
  const nested: unknown[] = []
  for (const child of children) {
    nested.push(...(await store.listPendingAsks(child.id)))
  }
  return [...own, ...nested]
}

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
    const next: SessionRecord = { ...session, followup: trimmed, updatedAt: Date.now() }
    try {
      await store.upsertSession(next)
    } catch {
      return { ok: false, notice: 'follow-up persist failed' }
    }
    session.followup = trimmed
    session.updatedAt = next.updatedAt
    return { ok: true }
  }
  const next: SessionRecord = { ...session, updatedAt: Date.now() }
  delete next.followup
  await store.upsertSession(next)
  delete session.followup
  session.updatedAt = next.updatedAt
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

export async function runFollowupAfterSubmit(opts: {
  engine: {
    session: { lastEnd?: RoundEnd }
    submitMessage: SessionEngine['submitMessage']
    getFollowup: () => string | null
    clearFollowup: () => Promise<void>
    liveTurnId: () => string | null
  }
  store?: {
    listPendingAsks?: (sessionId: string) => Promise<unknown[]>
    listSessions?: (filter: { parentSessionId: string }) => Promise<Array<{ id: string }>>
  }
  sessionId: string
  beforeLastEnd: RoundEnd | undefined
  chain?: boolean
}): Promise<'ran' | 'cleared' | 'skipped'> {
  const lastEnd = lastEndWrittenThisTurn(opts.beforeLastEnd, opts.engine.session.lastEnd)
  if (!lastEnd) return 'skipped'
  return maybeRunFollowup({
    engine: opts.engine,
    listPendingAsks: () => listOwnedPendingAsks(opts.store, opts.sessionId),
    lastEnd,
    chain: opts.chain,
  })
}
