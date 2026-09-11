export const LOOP_MAX_TIMES = 20

export type LoopAction =
  | { action: 'status' }
  | { action: 'stop' }
  | { action: 'start'; times: number; prompt: string }
  | { action: 'error'; message: string }

export interface LoopState {
  remaining: number
  total: number
  prompt: string
}

export function parseLoopArg(arg?: string): LoopAction {
  if (arg === undefined || arg.trim() === '') return { action: 'status' }
  const trimmed = arg.trim()
  if (/^(stop|off|cancel)$/i.test(trimmed)) return { action: 'stop' }
  const match = /^(\d+)(?:\s+([\s\S]+))?$/.exec(trimmed)
  if (!match) {
    return { action: 'error', message: 'usage: /loop [stop|<n> [prompt]]' }
  }
  const times = Number(match[1])
  if (!Number.isInteger(times) || times < 1) {
    return { action: 'error', message: 'loop times must be a positive integer' }
  }
  if (times > LOOP_MAX_TIMES) {
    return { action: 'error', message: `loop times max is ${LOOP_MAX_TIMES}` }
  }
  const prompt = match[2]?.trim() ?? ''
  if (prompt === '') {
    return { action: 'error', message: 'usage: /loop <n> <prompt>' }
  }
  return { action: 'start', times, prompt }
}

export function startLoop(times: number, prompt: string): LoopState {
  return { remaining: times, total: times, prompt }
}

export function takeLoopTurn(state: LoopState | null): { next: LoopState | null; prompt?: string } {
  if (!state || state.remaining <= 0) return { next: null }
  const remaining = state.remaining - 1
  const next: LoopState | null =
    remaining <= 0 ? null : { remaining, total: state.total, prompt: state.prompt }
  const index = state.total - remaining
  return {
    next,
    prompt: `${state.prompt}\n\n[loop ${index}/${state.total}]`,
  }
}

export function formatLoopStatus(state: LoopState | null): string {
  if (!state || state.remaining <= 0) return 'loop idle'
  return `loop ${state.total - state.remaining}/${state.total} remaining ${state.remaining}`
}
