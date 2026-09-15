import { describe, expect, test } from 'bun:test'
import {
  gatewaySecret,
  MAILBOX_POLL_MS,
  parseListen,
  singleFlight,
  startMailboxPoller,
  tickMailbox,
  type MailboxLiveEngine,
} from './serve'

describe('parseListen', () => {
  test('defaults to loopback 8787', () => {
    expect(parseListen()).toEqual({ host: '127.0.0.1', port: 8787 })
    expect(parseListen('127.0.0.1:9000')).toEqual({ host: '127.0.0.1', port: 9000 })
  })

  test('parses localhost and ::1 loopback hosts', () => {
    expect(parseListen('localhost:9001')).toEqual({ host: 'localhost', port: 9001 })
    expect(parseListen('::1:8787')).toEqual({ host: '::1', port: 8787 })
  })
})

describe('gatewaySecret', () => {
  test('prefers GATEWAY_SECRET', () => {
    expect(gatewaySecret({ GATEWAY_SECRET: 'a', RAVEN_SERVE_SECRET: 'b' })).toBe('a')
    expect(gatewaySecret({ RAVEN_SERVE_SECRET: 'b' })).toBe('b')
    expect(gatewaySecret({})).toBe('')
  })
})

describe('singleFlight', () => {
  test('serializes starts for the same key (second waits, then runs)', async () => {
    const flights = new Map<string, Promise<number>>()
    let runs = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const start = () =>
      new Promise<number>((resolve) => {
        runs += 1
        const n = runs
        if (n === 1) void held.then(() => resolve(n))
        else resolve(n)
      })
    const first = singleFlight(flights, 's1', start)
    const second = singleFlight(flights, 's1', start)
    expect(runs).toBe(1)
    expect(flights.size).toBe(1)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(1)
    expect(b).toBe(2)
    expect(runs).toBe(2)
    expect(flights.size).toBe(0)
  })
})

function liveEngine(opts: {
  id: string
  peek: () => Promise<string[]> | string[]
  onSubmit?: (text: string) => Promise<void>
}): { runtime: MailboxLiveEngine; submitted: string[] } {
  const submitted: string[] = []
  return {
    submitted,
    runtime: {
      engine: {
        session: { id: opts.id },
        async *submitMessage(input) {
          const text = typeof input === 'string' ? input : (input.text ?? '')
          submitted.push(text)
          await opts.onSubmit?.(text)
        },
      },
      store: {
        async peekAgentMail() {
          return await opts.peek()
        },
      },
    },
  }
}

describe('tickMailbox', () => {
  test('peek empty does not submit', async () => {
    const { runtime, submitted } = liveEngine({ id: 's1', peek: () => [] })
    const flights = new Map<string, Promise<unknown>>()
    await tickMailbox(new Map([['s1', runtime]]), flights)
    expect(submitted).toEqual([])
    expect(flights.size).toBe(0)
  })

  test('peek nonempty submits [mailbox] via singleFlight', async () => {
    const { runtime, submitted } = liveEngine({ id: 's1', peek: () => ['child done'] })
    const flights = new Map<string, Promise<unknown>>()
    await tickMailbox(new Map([['s1', runtime]]), flights)
    expect(submitted).toEqual(['[mailbox]'])
    expect(flights.size).toBe(0)
  })

  test('overlapping ticks do not double-submit', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let began!: () => void
    const submitBegan = new Promise<void>((resolve) => {
      began = resolve
    })
    let secondPeeked!: () => void
    const sawSecondPeek = new Promise<void>((resolve) => {
      secondPeeked = resolve
    })
    let peeks = 0
    let submits = 0
    const { runtime, submitted } = liveEngine({
      id: 's1',
      peek: () => {
        peeks += 1
        if (peeks === 2) secondPeeked()
        return ['still here']
      },
      onSubmit: async () => {
        submits += 1
        began()
        await held
      },
    })
    const engines = new Map([['s1', runtime]])
    const flights = new Map<string, Promise<unknown>>()
    const first = tickMailbox(engines, flights)
    await submitBegan
    expect(submits).toBe(1)
    expect(flights.size).toBe(1)
    const second = tickMailbox(engines, flights)
    await sawSecondPeek
    await Promise.resolve()
    expect(submits).toBe(1)
    expect(flights.size).toBe(1)
    release()
    await Promise.all([first, second])
    expect(submitted).toEqual(['[mailbox]'])
    expect(submits).toBe(1)
    expect(flights.size).toBe(0)
  })

  test('existing turnFlights entry for s1 waits and does not start a second submit', async () => {
    let release!: () => void
    let waited = false
    const held = new Promise<void>((resolve) => {
      release = resolve
    }).then(() => {
      waited = true
    })
    const { runtime, submitted } = liveEngine({ id: 's1', peek: () => ['child done'] })
    const turnFlights = new Map<string, Promise<unknown>>([['s1', held]])
    const tick = tickMailbox(new Map([['s1', runtime]]), turnFlights)
    await Promise.resolve()
    expect(submitted).toEqual([])
    expect(waited).toBe(false)
    release()
    await tick
    expect(waited).toBe(true)
    expect(submitted).toEqual([])
  })
})

describe('startMailboxPoller', () => {
  test('polls every 15s and stop clears the interval', () => {
    expect(MAILBOX_POLL_MS).toBe(15_000)
    const scheduled: number[] = []
    let cleared = 0
    const handle = { id: 7 }
    const stop = startMailboxPoller(new Map(), new Map(), {
      setIntervalFn: (fn, ms) => {
        scheduled.push(ms)
        expect(typeof fn).toBe('function')
        return handle
      },
      clearIntervalFn: (id) => {
        expect(id).toBe(handle)
        cleared += 1
      },
    })
    expect(scheduled).toEqual([15_000])
    stop()
    expect(cleared).toBe(1)
  })
})
