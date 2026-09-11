import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSkillDisabled, loadDisabledSkills, setSkillDisabled } from './disable'

describe('disabled skills', () => {
  test('round-trips enable and disable', () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-skill-off-'))
    expect(loadDisabledSkills(home)).toEqual([])
    expect(setSkillDisabled('review', true, home)).toEqual(['review'])
    expect(isSkillDisabled('review', home)).toBe(true)
    expect(setSkillDisabled('review', false, home)).toEqual([])
    expect(isSkillDisabled('review', home)).toBe(false)
  })
})
