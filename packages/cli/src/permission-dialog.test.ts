import { describe, expect, test } from 'bun:test'
import { keyToPermission, permissionAskChildLabel, type PermissionAsk } from './permission-dialog'

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

test('keyToPermission maps i to ignored and keeps y/n/a', () => {
  expect(keyToPermission('i')).toBe('ignored')
  expect(keyToPermission('I')).toBe('ignored')
  expect(keyToPermission('y')).toBe('allow')
  expect(keyToPermission('n')).toBe('deny')
  expect(keyToPermission('a')).toBe('allow_always')
  expect(keyToPermission('skip')).toBeUndefined()
  expect(keyToPermission('escape')).toBeUndefined()
})
