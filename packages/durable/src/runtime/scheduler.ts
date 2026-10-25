import type { DurableTaskRow, JsonObject, JsonValue } from '../storage/types.ts'

export const DEFAULT_RESTART_LIMIT = 5

export function reconcileTask(
  task: DurableTaskRow,
  limit: number,
): { task: DurableTaskRow; invoke: boolean } {
  if (task.status !== 'running') return { task, invoke: false }
  const restarts = task.restarts + 1
  const parked = restarts >= limit
  const next: DurableTaskRow = {
    id: task.id,
    name: task.name,
    conversationId: task.conversationId,
    status: 'pending',
    restarts,
    parked,
  }
  if (task.parentTaskId !== undefined) next.parentTaskId = task.parentTaskId
  if (task.nested === true) next.nested = true
  if (task.checkpoint !== undefined) next.checkpoint = task.checkpoint
  return { task: next, invoke: !parked }
}

export function evolveTask(
  task: DurableTaskRow,
  next: {
    status: DurableTaskRow['status']
    checkpoint?: JsonObject
    outcome?: NonNullable<DurableTaskRow['outcome']>
    parked?: boolean
  },
): DurableTaskRow {
  const terminal = next.status === 'terminal'
  const checkpoint = next.checkpoint !== undefined ? next.checkpoint : task.checkpoint
  const changed = !terminal && next.checkpoint !== undefined && stable(next.checkpoint) !== stable(task.checkpoint)
  const row: DurableTaskRow = {
    id: task.id,
    name: task.name,
    conversationId: task.conversationId,
    status: next.status,
    restarts: terminal || changed ? 0 : task.restarts,
    parked: next.parked !== undefined ? next.parked : task.parked,
  }
  if (task.parentTaskId !== undefined) row.parentTaskId = task.parentTaskId
  if (task.nested === true) row.nested = true
  if (!terminal && checkpoint !== undefined) row.checkpoint = checkpoint
  if (terminal && next.outcome !== undefined) row.outcome = next.outcome
  return row
}

export function holdPending(task: DurableTaskRow): DurableTaskRow {
  const row: DurableTaskRow = {
    id: task.id,
    name: task.name,
    conversationId: task.conversationId,
    status: 'pending',
    restarts: task.restarts,
    parked: task.parked,
  }
  if (task.parentTaskId !== undefined) row.parentTaskId = task.parentTaskId
  if (task.nested === true) row.nested = true
  if (task.checkpoint !== undefined) row.checkpoint = task.checkpoint
  return row
}

function stable(value: JsonValue | undefined): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: JsonValue | undefined): JsonValue | null {
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map((item) => sortValue(item) ?? null)
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {}
    for (const key of Object.keys(value).sort()) {
      const nested = value[key]
      out[key] = sortValue(nested) ?? null
    }
    return out
  }
  return value
}
