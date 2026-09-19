import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ravenclawHome } from '../home'

export interface FileSnapshot {
  path: string
  existed: boolean
  backupPath?: string
}

export interface UndoResult {
  restored: string[]
  removed: string[]
  blocked?: boolean
}

export interface FileHistory {
  beginTurn(): void
  endTurn(): void
  snapshot(absPath: string): void
  undo(): UndoResult
  pendingCount(): number
  peekLast?(): { open: boolean } | undefined
  /** Snapshots recorded on the current (this-turn) generation. */
  turnWriteCount(): number
  /** Drop in-process generations. Does not undo files or delete backups. */
  reset(): void
}

interface Generation {
  open: boolean
  rows: FileSnapshot[]
}

export function createFileHistory(sessionId: string, home = ravenclawHome()): FileHistory {
  const root = join(home, 'file-history', sessionId)
  const generations: Generation[] = []
  let current: Generation | undefined
  let seq = 0

  return {
    beginTurn() {
      if (current) current.open = false
      current = { open: true, rows: [] }
      generations.push(current)
    },

    endTurn() {
      if (current) current.open = false
    },

    snapshot(absPath) {
      if (!current || !current.open) {
        current = { open: true, rows: [] }
        generations.push(current)
      }
      if (current.rows.some((row) => row.path === absPath)) return
      mkdirSync(root, { recursive: true })
      if (!existsSync(absPath)) {
        current.rows.push({ path: absPath, existed: false })
        return
      }
      seq += 1
      const backupPath = join(root, `${String(seq).padStart(4, '0')}`)
      copyFileSync(absPath, backupPath)
      current.rows.push({ path: absPath, existed: true, backupPath })
    },

    undo() {
      const idx = lastUndoableIndex(generations)
      if (idx < 0) {
        const blocked = generations.some((gen) => gen.open && gen.rows.length > 0)
        return blocked ? { restored: [], removed: [], blocked: true } : { restored: [], removed: [] }
      }
      const generation = generations[idx]
      if (!generation) return { restored: [], removed: [] }
      const leftover: FileSnapshot[] = []
      const restored: string[] = []
      const removed: string[] = []
      for (let i = generation.rows.length - 1; i >= 0; i--) {
        const row = generation.rows[i]
        if (!row) continue
        if (!row.existed) {
          try {
            if (existsSync(row.path)) unlinkSync(row.path)
            removed.push(row.path)
          } catch {
            leftover.unshift(row)
          }
          continue
        }
        if (row.backupPath && existsSync(row.backupPath)) {
          try {
            mkdirSync(dirname(row.path), { recursive: true })
            writeFileSync(row.path, readFileSync(row.backupPath))
            restored.push(row.path)
          } catch {
            leftover.unshift(row)
          }
        } else {
          leftover.unshift(row)
        }
      }
      generation.rows = leftover
      if (leftover.length === 0) {
        generations.splice(idx, 1)
        if (current === generation) current = generations[generations.length - 1]
      }
      return { restored, removed }
    },

    pendingCount() {
      return generations.reduce((sum, gen) => sum + gen.rows.length, 0)
    },

    turnWriteCount() {
      return current ? current.rows.length : 0
    },

    peekLast() {
      const gen = generations[generations.length - 1]
      if (!gen) return undefined
      return { open: gen.open }
    },

    reset() {
      generations.length = 0
      current = undefined
    },
  }
}

export function formatUndoNotice(result: UndoResult): string {
  const n = result.restored.length + result.removed.length
  if (n === 0) return result.blocked === true ? 'undo after the turn finishes' : 'nothing to undo'
  const parts: string[] = []
  if (result.restored.length > 0) parts.push(`restored ${result.restored.length}`)
  if (result.removed.length > 0) parts.push(`removed ${result.removed.length}`)
  return `undo: ${parts.join(', ')}`
}

function lastUndoableIndex(generations: Generation[]): number {
  for (let i = generations.length - 1; i >= 0; i--) {
    const gen = generations[i]
    if (gen && !gen.open && gen.rows.length > 0) return i
  }
  return -1
}
