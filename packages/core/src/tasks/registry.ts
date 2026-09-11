import { readFileSync } from 'node:fs'

export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed'

export interface TaskSnapshot {
  id: string
  type: 'bash'
  command: string
  description: string
  status: TaskStatus
  outputFile: string
  startedAt: number
  endedAt?: number
  exitCode?: number
}

export interface RegisterTaskInput {
  command: string
  outputFile: string
  kill: () => void
}

export interface TaskRegistry {
  register(input: RegisterTaskInput): TaskSnapshot
  get(id: string): TaskSnapshot | undefined
  list(): TaskSnapshot[]
  readOutput(id: string): string | undefined
  complete(id: string, exitCode: number): TaskSnapshot | undefined
  kill(id: string): TaskSnapshot | undefined
  killAll(): TaskSnapshot[]
}

interface LiveTask extends TaskSnapshot {
  killProcess: () => void
}

export function createTaskRegistry(): TaskRegistry {
  const tasks = new Map<string, LiveTask>()

  return {
    register(input) {
      const id = nextTaskId()
      const task: LiveTask = {
        id,
        type: 'bash',
        command: input.command,
        description: summarizeCommand(input.command),
        status: 'running',
        outputFile: input.outputFile,
        startedAt: Date.now(),
        killProcess: input.kill,
      }
      tasks.set(id, task)
      return snapshotOf(task)
    },

    get(id) {
      const task = tasks.get(id)
      return task ? snapshotOf(task) : undefined
    },

    list() {
      return [...tasks.values()].map(snapshotOf)
    },

    readOutput(id) {
      const task = tasks.get(id)
      if (!task) return undefined
      try {
        return readFileSync(task.outputFile, 'utf8')
      } catch {
        return ''
      }
    },

    complete(id, exitCode) {
      const task = tasks.get(id)
      if (!task || task.status !== 'running') return task ? snapshotOf(task) : undefined
      task.status = exitCode === 0 ? 'completed' : 'failed'
      task.exitCode = exitCode
      task.endedAt = Date.now()
      return snapshotOf(task)
    },

    kill(id) {
      const task = tasks.get(id)
      if (!task) return undefined
      if (task.status === 'running') {
        try {
          task.killProcess()
        } catch {
          // already gone
        }
        task.status = 'killed'
        task.endedAt = Date.now()
      }
      return snapshotOf(task)
    },

    killAll() {
      const out: TaskSnapshot[] = []
      for (const task of tasks.values()) {
        if (task.status !== 'running') continue
        const killed = this.kill(task.id)
        if (killed) out.push(killed)
      }
      return out
    },
  }
}

export function formatTasksNotice(tasks: TaskSnapshot[]): string {
  if (tasks.length === 0) return 'no background tasks'
  return tasks
    .map((task) => {
      const exit = task.exitCode !== undefined ? `  exit ${task.exitCode}` : ''
      return `${task.id}  ${task.status}  ${task.description}${exit}`
    })
    .join('\n')
}

export function parseTasksArg(arg?: string): { action: 'list' } | { action: 'kill'; id: string } {
  if (arg === undefined) return { action: 'list' }
  const trimmed = arg.trim()
  if (trimmed === '') return { action: 'list' }
  const match = /^kill\s+(\S+)$/i.exec(trimmed)
  if (match?.[1]) return { action: 'kill', id: match[1] }
  return { action: 'list' }
}

function snapshotOf(task: LiveTask): TaskSnapshot {
  const out: TaskSnapshot = {
    id: task.id,
    type: task.type,
    command: task.command,
    description: task.description,
    status: task.status,
    outputFile: task.outputFile,
    startedAt: task.startedAt,
  }
  if (task.endedAt !== undefined) out.endedAt = task.endedAt
  if (task.exitCode !== undefined) out.exitCode = task.exitCode
  return out
}

function nextTaskId(): string {
  return `b_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
}

function summarizeCommand(command: string): string {
  const line = command.replace(/\s+/g, ' ').trim()
  if (line.length <= 60) return line
  return `${line.slice(0, 57)}...`
}
