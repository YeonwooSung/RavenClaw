/**
 * Live-children counter for one Agent tool instance. The root builds one Agent
 * tool and hands the same instance to nested children, so every foreground
 * batch member, background agent, and nested child in that tree shares it.
 */
export interface AgentBudget {
  readonly running: number
  /** Reserve `count` slots, all or none. Returns false when they do not fit. */
  tryReserve(count: number): boolean
  release(count: number): void
}

export function createAgentBudget(cap: number): AgentBudget {
  let running = 0
  return {
    get running() {
      return running
    },
    tryReserve(count) {
      if (running + count > cap) return false
      running += count
      return true
    },
    release(count) {
      running = Math.max(0, running - count)
    },
  }
}
