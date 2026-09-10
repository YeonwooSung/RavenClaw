import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { safetyCheck } from './safety'

describe('safetyCheck', () => {
  test('denies a write-like path under .git/', () => {
    const decision = safetyCheck('Write', { path: '.git/config', content: 'x' }, '/tmp/proj')
    expect(decision?.behavior).toBe('deny')
    expect(decision?.reason).toBe('safety')
  })

  test('denies Edit of a nested .git path', () => {
    const decision = safetyCheck(
      'Edit',
      { path: 'vendor/.git/hooks/pre-commit', old_string: 'a', new_string: 'b' },
      '/tmp/proj',
    )
    expect(decision?.behavior).toBe('deny')
  })

  test('does not deny .env writes', () => {
    expect(safetyCheck('Write', { path: '.env', content: 'A=1' }, '/tmp/proj')).toBeUndefined()
    expect(safetyCheck('Write', { path: 'app/.env', content: 'A=1' }, '/tmp/proj')).toBeUndefined()
  })

  test('denies credential globs', () => {
    expect(safetyCheck('Write', { path: '.ssh/id_rsa', content: 'k' }, '/tmp/proj')?.behavior).toBe(
      'deny',
    )
    expect(safetyCheck('Write', { path: 'certs/prod.pem', content: 'k' }, '/tmp/proj')?.behavior).toBe(
      'deny',
    )
  })

  test('denies shell rc writes', () => {
    expect(safetyCheck('Write', { path: join(homedir(), '.bashrc'), content: 'x' }, '/tmp')?.behavior).toBe(
      'deny',
    )
    expect(safetyCheck('Write', { path: join(homedir(), '.zshrc'), content: 'x' }, '/tmp')?.behavior).toBe(
      'deny',
    )
  })

  test('misses ordinary in-tree writes and read-only tools', () => {
    expect(safetyCheck('Write', { path: 'src/app.ts', content: 'x' }, '/tmp/proj')).toBeUndefined()
    expect(safetyCheck('Read', { path: '.git/config' }, '/tmp/proj')).toBeUndefined()
    expect(safetyCheck('Bash', { command: 'echo hi' }, '/tmp/proj')).toBeUndefined()
  })
})
