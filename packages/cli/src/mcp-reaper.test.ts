import { describe, expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import {
  createMcpReaper,
  encodeReaperOp,
  killProcessGroup,
  parseReaperOp,
  reapProcessGroups,
  runReaperFromStdin,
} from './mcp-reaper'

describe('parseReaperOp', () => {
  test('accepts add/del and rejects junk', () => {
    expect(parseReaperOp('{"op":"add","pgid":42}')).toEqual({ op: 'add', pgid: 42 })
    expect(parseReaperOp('  {"op":"del","pgid":7} \n')).toEqual({ op: 'del', pgid: 7 })
    expect(parseReaperOp('{"op":"add","pgid":0}')).toBeUndefined()
    expect(parseReaperOp('{"op":"noop","pgid":1}')).toBeUndefined()
    expect(parseReaperOp('not-json')).toBeUndefined()
    expect(parseReaperOp('')).toBeUndefined()
  })
})

describe('reapProcessGroups', () => {
  test('sends TERM then KILL after the grace period', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const sleeps: number[] = []
    await reapProcessGroups([11, 11, 12], {
      kill(pid, signal) {
        signals.push({ pid, signal })
      },
      async sleep(ms) {
        sleeps.push(ms)
      },
      graceMs: 30,
    })
    const term = process.platform === 'win32' ? [11, 12] : [-11, -12]
    const kill = term
    expect(signals).toEqual([
      { pid: term[0]!, signal: 'SIGTERM' },
      { pid: term[1]!, signal: 'SIGTERM' },
      { pid: kill[0]!, signal: 'SIGKILL' },
      { pid: kill[1]!, signal: 'SIGKILL' },
    ])
    expect(sleeps).toEqual([30])
  })

  test('empty set does not sleep or kill', async () => {
    let killed = 0
    let slept = 0
    await reapProcessGroups([], {
      kill() {
        killed += 1
      },
      async sleep() {
        slept += 1
      },
    })
    expect(killed).toBe(0)
    expect(slept).toBe(0)
  })
})

describe('killProcessGroup', () => {
  test('retries the raw pid when the group kill throws', () => {
    const seen: number[] = []
    killProcessGroup(9, 'SIGTERM', (pid) => {
      seen.push(pid)
      if (pid < 0) throw new Error('no group')
    })
    if (process.platform === 'win32') {
      expect(seen).toEqual([9])
    } else {
      expect(seen).toEqual([-9, 9])
    }
  })
})

describe('runReaperFromStdin', () => {
  test('adds, deletes, and reaps the remainder on EOF', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const body = [
      encodeReaperOp({ op: 'add', pgid: 3 }),
      encodeReaperOp({ op: 'add', pgid: 4 }),
      encodeReaperOp({ op: 'del', pgid: 3 }),
    ].join('')
    await runReaperFromStdin(Readable.from([body]), {
      kill(pid, signal) {
        signals.push({ pid, signal })
      },
      async sleep() {},
    })
    const target = process.platform === 'win32' ? 4 : -4
    expect(signals).toEqual([
      { pid: target, signal: 'SIGTERM' },
      { pid: target, signal: 'SIGKILL' },
    ])
  })
})

describe('createMcpReaper', () => {
  test('writes add/del and ends the sink; lazy until register', () => {
    const writes: string[] = []
    let ended = false
    let started = 0
    const reaper = createMcpReaper({
      start() {
        started += 1
        return {
          write(line) {
            writes.push(line)
          },
          end() {
            ended = true
          },
        }
      },
    })
    reaper.unregister(1)
    reaper.close()
    expect(started).toBe(0)
    reaper.register(8)
    reaper.register(0)
    reaper.unregister(8)
    reaper.close()
    expect(started).toBe(1)
    expect(writes).toEqual([encodeReaperOp({ op: 'add', pgid: 8 }), encodeReaperOp({ op: 'del', pgid: 8 })])
    expect(ended).toBe(true)
  })
})
