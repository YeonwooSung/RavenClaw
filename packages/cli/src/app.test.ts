import { describe, expect, test } from 'bun:test'

describe('app module', () => {
  test('exports App', async () => {
    const mod = await import('./app')
    expect(typeof mod.App).toBe('function')
  })
})
