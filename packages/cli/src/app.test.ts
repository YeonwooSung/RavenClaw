import { describe, expect, test } from 'bun:test'
import type { StreamEvent } from '@ravenclaw/core'
import { replayPendingAsksTo } from './app'

describe('app module', () => {
  test('exports App', async () => {
    const mod = await import('./app')
    expect(typeof mod.App).toBe('function')
  })

  test('first-paint replay abort is caught and still applies permission_ask', async () => {
    const events: StreamEvent[] = []
    async function* replay() {
      yield {
        type: 'permission_ask' as const,
        id: 'call_1',
        tool: 'Bash',
        input: { command: 'ls' },
        message: 'Run ls?',
      }
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    const message = await replayPendingAsksTo(() => replay(), (event) => {
      events.push(event)
    })
    expect(message).toBe('aborted')
    expect(events.some((event) => event.type === 'permission_ask' && event.id === 'call_1')).toBe(
      true,
    )
  })
})
