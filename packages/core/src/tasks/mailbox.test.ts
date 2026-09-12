import { describe, expect, test } from 'bun:test'
import { drainAgentMail, enqueueAgentMail, MAX_PARALLEL_CHILDREN } from './mailbox'

describe('agent mailbox', () => {
  test('enqueue then drain returns notices and clears the queue', () => {
    const id = `sess_mail_${crypto.randomUUID()}`
    expect(drainAgentMail(id)).toEqual([])
    enqueueAgentMail(id, 'one')
    enqueueAgentMail(id, 'two')
    expect(drainAgentMail(id)).toEqual(['one', 'two'])
    expect(drainAgentMail(id)).toEqual([])
  })

  test('sessions are isolated', () => {
    const a = `sess_a_${crypto.randomUUID()}`
    const b = `sess_b_${crypto.randomUUID()}`
    enqueueAgentMail(a, 'a-mail')
    enqueueAgentMail(b, 'b-mail')
    expect(drainAgentMail(a)).toEqual(['a-mail'])
    expect(drainAgentMail(b)).toEqual(['b-mail'])
  })

  test('MAX_PARALLEL_CHILDREN is 6', () => {
    expect(MAX_PARALLEL_CHILDREN).toBe(6)
  })
})
