import { describe, expect, test } from 'bun:test'
import {
  LOOP_MAX_TIMES,
  formatLoopStatus,
  parseLoopArg,
  startLoop,
  takeLoopTurn,
} from './slash'

describe('parseLoopArg', () => {
  test('empty is status', () => {
    expect(parseLoopArg()).toEqual({ action: 'status' })
    expect(parseLoopArg('  ')).toEqual({ action: 'status' })
  })

  test('stop aliases', () => {
    expect(parseLoopArg('stop')).toEqual({ action: 'stop' })
    expect(parseLoopArg('OFF')).toEqual({ action: 'stop' })
    expect(parseLoopArg('cancel')).toEqual({ action: 'stop' })
  })

  test('start with times and prompt', () => {
    expect(parseLoopArg('3 fix the tests')).toEqual({
      action: 'start',
      times: 3,
      prompt: 'fix the tests',
    })
  })

  test('rejects missing prompt and oversize', () => {
    expect(parseLoopArg('3').action).toBe('error')
    expect(parseLoopArg('0 go').action).toBe('error')
    expect(parseLoopArg(`${LOOP_MAX_TIMES + 1} go`).action).toBe('error')
    expect(parseLoopArg('forever')).toEqual({
      action: 'error',
      message: 'usage: /loop [stop|<n> [prompt]]',
    })
  })
})

describe('takeLoopTurn', () => {
  test('counts down and tags the prompt', () => {
    let state = startLoop(2, 'do it')
    const first = takeLoopTurn(state)
    expect(first.prompt).toBe('do it\n\n[loop 1/2]')
    expect(first.next?.remaining).toBe(1)
    const second = takeLoopTurn(first.next)
    expect(second.prompt).toBe('do it\n\n[loop 2/2]')
    expect(second.next).toBeNull()
  })

  test('formatLoopStatus', () => {
    expect(formatLoopStatus(null)).toBe('loop idle')
    expect(formatLoopStatus(startLoop(3, 'x'))).toBe('loop 0/3 remaining 3')
  })
})
