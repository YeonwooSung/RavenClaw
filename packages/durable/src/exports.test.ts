import { expect, test } from 'bun:test'
import { DurableBusy, DurableClosed, DurableFault, openDurable, openMemoryStorage, openSqliteStorage } from '@ravenclaw/durable'

test('the package barrel exports the runtime surface', () => {
  expect(typeof openDurable).toBe('function')
  expect(typeof openMemoryStorage).toBe('function')
  expect(typeof openSqliteStorage).toBe('function')
  expect(new DurableBusy().code).toBe('busy')
  expect(new DurableClosed().code).toBe('closed')
  expect(new DurableFault('x').code).toBe('fault')
})
