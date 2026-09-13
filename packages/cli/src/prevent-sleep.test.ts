import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createPreventSleep } from './prevent-sleep'

function fakeChild(): ChildProcess & { kills: number } {
  const child = new EventEmitter() as ChildProcess & { kills: number }
  child.kills = 0
  child.kill = (() => {
    child.kills += 1
    child.emit('exit', 0, null)
    return true
  }) as ChildProcess['kill']
  return child
}

describe('prevent-sleep', () => {
  test('is a no-op off macOS', () => {
    let spawned = 0
    const ctl = createPreventSleep({
      platform: 'linux',
      spawn: () => {
        spawned += 1
        return fakeChild()
      },
    })
    ctl.start()
    ctl.stop()
    expect(spawned).toBe(0)
  })

  test('starts caffeinate -i -t 300 once while referenced', () => {
    const spawned: string[][] = []
    const children: Array<ReturnType<typeof fakeChild>> = []
    const ctl = createPreventSleep({
      platform: 'darwin',
      spawn: (_cmd, args) => {
        spawned.push([...args])
        const child = fakeChild()
        children.push(child)
        return child
      },
    })
    ctl.start()
    ctl.start()
    expect(spawned).toEqual([['-i', '-t', '300']])
    ctl.stop()
    expect(children[0]?.kills).toBe(0)
    ctl.stop()
    expect(children[0]?.kills).toBe(1)
  })

  test('restarts before the caffeinate timeout expires', () => {
    const spawned: number[] = []
    const timers: Array<() => void> = []
    const ctl = createPreventSleep({
      platform: 'darwin',
      spawn: () => {
        spawned.push(1)
        return fakeChild()
      },
      setTimeout: ((fn: () => void) => {
        timers.push(fn)
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      clearTimeout: () => {},
    })
    ctl.start()
    expect(spawned).toHaveLength(1)
    expect(timers).toHaveLength(1)
    timers[0]?.()
    expect(spawned).toHaveLength(2)
    ctl.stop()
  })
})
