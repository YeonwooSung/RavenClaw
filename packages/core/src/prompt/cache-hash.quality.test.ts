import { describe, expect, test } from 'bun:test'
import { buildSystemParts, type PromptBuildInput } from './builder'
import { hashSystemParts } from './cache'

describe('quality gate', () => {
  test('system-part hash is stable', () => {
    const input: PromptBuildInput = {
      cwd: '/workspace/demo',
      permissionMode: 'default',
      projectFilesText: 'frozen-project-text',
      git: { branch: 'main', head: 'deadbeef', dirty: false },
      locale: 'en-US',
      skills: [{ name: 'demo', description: 'stable skill' }],
    }
    const first = hashSystemParts(buildSystemParts(input))
    const second = hashSystemParts(buildSystemParts(input))
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)

    const cwdHash = hashSystemParts(
      buildSystemParts({ ...input, cwd: '/workspace/other' }),
    )
    const modeHash = hashSystemParts(
      buildSystemParts({ ...input, permissionMode: 'plan' }),
    )
    expect(cwdHash).not.toBe(first)
    expect(modeHash).not.toBe(first)
    expect(cwdHash).not.toBe(modeHash)
  })
})
