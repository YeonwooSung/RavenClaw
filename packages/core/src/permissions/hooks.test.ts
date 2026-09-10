import { describe, expect, test } from 'bun:test'
import { runPermissionHooks, type PermissionHook } from './hooks'

const info = { name: 'Bash', input: { command: 'ls' } }

describe('runPermissionHooks', () => {
  test('first deny wins even after an earlier allow', async () => {
    const hooks: PermissionHook[] = [
      () => ({ behavior: 'allow', reason: 'mode' }),
      () => ({ behavior: 'deny', reason: 'user', message: 'blocked' }),
      () => ({ behavior: 'allow', reason: 'mode' }),
    ]
    expect(await runPermissionHooks(hooks, info)).toEqual({
      behavior: 'deny',
      reason: 'hook',
      message: 'blocked',
    })
  })

  test('first deny wins when it is the first decision', async () => {
    const hooks: PermissionHook[] = [
      () => ({ behavior: 'deny', reason: 'user', message: 'no' }),
      () => ({ behavior: 'allow', reason: 'mode' }),
    ]
    expect(await runPermissionHooks(hooks, info)).toEqual({
      behavior: 'deny',
      reason: 'hook',
      message: 'no',
    })
  })

  test('first allow is noted when no hook denies', async () => {
    const hooks: PermissionHook[] = [
      () => undefined,
      () => ({ behavior: 'allow', reason: 'user' }),
      () => ({ behavior: 'allow', reason: 'mode' }),
    ]
    expect(await runPermissionHooks(hooks, info)).toEqual({
      behavior: 'allow',
      reason: 'hook',
    })
  })

  test('void, ask, and empty lists fall through', async () => {
    expect(await runPermissionHooks([], info)).toBeUndefined()
    expect(await runPermissionHooks([() => undefined, () => undefined], info)).toBeUndefined()
    expect(
      await runPermissionHooks([() => ({ behavior: 'ask', message: 'maybe' })], info),
    ).toBeUndefined()
  })

  test('awaits async hooks', async () => {
    const hooks: PermissionHook[] = [
      async () => {
        await Promise.resolve()
        return { behavior: 'allow', reason: 'mode' }
      },
    ]
    expect(await runPermissionHooks(hooks, info)).toEqual({
      behavior: 'allow',
      reason: 'hook',
    })
  })
})
