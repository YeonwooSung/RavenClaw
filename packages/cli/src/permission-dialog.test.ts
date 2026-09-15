import { describe, expect, test } from 'bun:test'
import { permissionAskChildLabel, type PermissionAsk } from './permission-dialog'

function ask(over: Partial<PermissionAsk> = {}): PermissionAsk {
  return {
    type: 'permission_ask',
    id: 'call_1',
    tool: 'Bash',
    input: { command: 'ls' },
    message: 'child bash?',
    ...over,
  }
}

describe('permissionAskChildLabel', () => {
  test('labels leftover-ask with child <id> when childSessionId is set', () => {
    expect(permissionAskChildLabel(ask({ childSessionId: 'sess_child' }))).toBe(
      'child sess_child',
    )
  })

  test('omits the child label for a parent leftover-ask', () => {
    expect(permissionAskChildLabel(ask())).toBeUndefined()
  })
})
