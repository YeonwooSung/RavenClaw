import { afterEach, describe, expect, mock, test } from 'bun:test'

const fork = mock(
  async (opts: { text: string }): Promise<{ ok: boolean; text: string; path?: string }> => {
    if (opts.text === 'fail') return { ok: false, text: 'provider down' }
    if (opts.text === 'empty') return { ok: true, text: '' }
    return { ok: true, text: 'ok', path: '/tmp/.ravenclaw/MEMORY.md' }
  },
)

mock.module('@ravenclaw/core', () => ({
  forkMemoryReview: fork,
}))

const { runSessionReview } = await import('./review')

afterEach(() => {
  fork.mockClear()
})

describe('runSessionReview', () => {
  function runtime() {
    return {
      provider: { id: 'fake' },
      store: {},
      engine: { session: { cwd: '/tmp' } },
      config: { profile: { id: 'm' }, compact: { enabled: true, llmSummarize: false } },
    } as never
  }

  test('returns the written path when the fork succeeds', async () => {
    expect(await runSessionReview(runtime(), 'summarize')).toBe('wrote /tmp/.ravenclaw/MEMORY.md')
    expect(fork).toHaveBeenCalledTimes(1)
  })

  test('surfaces a fork failure', async () => {
    expect(await runSessionReview(runtime(), 'fail')).toBe('review failed: provider down')
  })

  test('reports when no memory file was written', async () => {
    expect(await runSessionReview(runtime(), 'empty')).toBe('review produced no memory to write')
  })
})
