export const ROTATE_INTERVAL_MS = 60_000
export const IDLE_IMPRESSION_LIMIT = 3
export const ACTIVITY_WINDOW_MS = 30_000
export const ACCIDENTAL_CLICK_MS = 300

export type ClickKind = 'click' | 'accidental'

export interface RotationState {
  lastActivityAt: number | null
  lastImpressionAt: number | null
  lastCreativeId: string | null
  idleImpressions: number
  paused: boolean
}

let mountDedupe: { id: string; at: number } | null = null

export function createRotationState(): RotationState {
  return {
    lastActivityAt: null,
    lastImpressionAt: null,
    lastCreativeId: null,
    idleImpressions: 0,
    paused: false,
  }
}

export function resetRotationMounts(): void {
  mountDedupe = null
}

export function markActivity(state: RotationState, now: number): void {
  state.lastActivityAt = now
  state.paused = false
  state.idleImpressions = 0
}

export function isActive(state: RotationState, now: number): boolean {
  return state.lastActivityAt !== null && now - state.lastActivityAt <= ACTIVITY_WINDOW_MS
}

export function shouldRotate(state: RotationState, now: number): boolean {
  if (state.paused) return false
  if (state.lastImpressionAt === null) return false
  if (now - state.lastImpressionAt < ROTATE_INTERVAL_MS) return false
  return isActive(state, now)
}

export function recordImpression(state: RotationState, creativeId: string, now: number): boolean {
  if (isDuplicateImpression(state, creativeId, now)) {
    state.lastCreativeId = creativeId
    if (state.lastImpressionAt === null) state.lastImpressionAt = now
    return false
  }

  const idle = !isActive(state, now)
  if (idle) state.idleImpressions += 1
  else state.idleImpressions = 0
  if (state.idleImpressions >= IDLE_IMPRESSION_LIMIT) state.paused = true

  state.lastCreativeId = creativeId
  state.lastImpressionAt = now
  mountDedupe = { id: creativeId, at: now }
  return true
}

export function classifyClick(downAt: number, upAt: number): ClickKind {
  return upAt - downAt < ACCIDENTAL_CLICK_MS ? 'accidental' : 'click'
}

function isDuplicateImpression(state: RotationState, creativeId: string, now: number): boolean {
  if (
    state.lastCreativeId === creativeId &&
    state.lastImpressionAt !== null &&
    now - state.lastImpressionAt < ROTATE_INTERVAL_MS
  ) {
    return true
  }
  return (
    mountDedupe !== null &&
    mountDedupe.id === creativeId &&
    now - mountDedupe.at < ROTATE_INTERVAL_MS
  )
}
