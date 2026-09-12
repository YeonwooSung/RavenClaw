import { describe, expect, test } from 'bun:test'
import { gatewaySecret, parseListen, singleFlight } from './serve'

describe('parseListen', () => {
  test('defaults to loopback 8787', () => {
    expect(parseListen()).toEqual({ host: '127.0.0.1', port: 8787 })
    expect(parseListen('127.0.0.1:9000')).toEqual({ host: '127.0.0.1', port: 9000 })
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
  test('concurrent starts share one in-flight promise', async () => {
    const flights = new Map<string, Promise<number>>()
    let runs = 0
    const start = () =>
      new Promise<number>((resolve) => {
        runs += 1
        setTimeout(() => resolve(runs), 20)
      })
    const [a, b] = await Promise.all([
      singleFlight(flights, 's1', start),
      singleFlight(flights, 's1', start),
    ])
    expect(a).toBe(1)
    expect(b).toBe(1)
    expect(runs).toBe(1)
    expect(flights.size).toBe(0)
  })
})
