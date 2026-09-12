import { describe, expect, test } from 'bun:test'
import { abortTurn, isAbortError, isAborted, nextOrAbort } from './abort'

describe('isAborted', () => {
  test('reads the signal flag', () => {
    const ctrl = new AbortController()
    expect(isAborted(ctrl.signal)).toBe(false)
    ctrl.abort()
    expect(isAborted(ctrl.signal)).toBe(true)
  })
})

describe('isAbortError', () => {
  test('accepts AbortError and DOMException names only', () => {
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError('aborted')).toBe(false)
    expect(isAbortError(new Error('no'))).toBe(false)
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
    expect(isAbortError(Object.assign(new Error('x'), { name: 'DOMException' }))).toBe(true)
  })
})

describe('abortTurn', () => {
  test('aborts once and is idempotent', () => {
    const ctrl = new AbortController()
    abortTurn(ctrl)
    expect(ctrl.signal.aborted).toBe(true)
    abortTurn(ctrl)
    expect(ctrl.signal.aborted).toBe(true)
  })
})

describe('nextOrAbort', () => {
  test('returns aborted if the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const iter = {
      next: async () => {
        throw new Error('should not be called')
      },
    }
    expect(await nextOrAbort(iter, ctrl.signal)).toBe('aborted')
  })

  test('resolves the iterator result when it wins', async () => {
    const ctrl = new AbortController()
    const iter = {
      next: async () => ({ done: true as const, value: undefined }),
    }
    expect(await nextOrAbort(iter, ctrl.signal)).toEqual({ done: true, value: undefined })
  })

  test('returns aborted when the signal fires first', async () => {
    const ctrl = new AbortController()
    const iter = {
      next: () =>
        new Promise<IteratorResult<string>>((resolve) => {
          setTimeout(() => resolve({ done: false, value: 'late' }), 50)
        }),
    }
    const pending = nextOrAbort(iter, ctrl.signal)
    ctrl.abort()
    expect(await pending).toBe('aborted')
  })

  test('rejects when the iterator rejects', async () => {
    const ctrl = new AbortController()
    const iter = {
      next: async () => {
        throw new Error('boom')
      },
    }
    await expect(nextOrAbort(iter, ctrl.signal)).rejects.toThrow('boom')
  })
})
