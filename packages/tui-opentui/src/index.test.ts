import { describe, expect, test } from 'bun:test'
import { composerLine, createOpenTuiView, permissionPromptLines } from './index'

describe('tui-opentui public surface', () => {
  test('re-exports render helpers', () => {
    expect(typeof composerLine).toBe('function')
    expect(typeof createOpenTuiView).toBe('function')
    expect(typeof permissionPromptLines).toBe('function')
    expect(composerLine('hi')).toContain('hi')
  })
})
