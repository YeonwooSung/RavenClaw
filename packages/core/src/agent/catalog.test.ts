import { describe, expect, test } from 'bun:test'
import { agentCatalog, getAgentDefinition } from './catalog'
import { commandRunnerAgent } from './command-runner'
import { fileFinderAgent } from './file-finder'
import { generalAgent } from './general'

describe('agentCatalog', () => {
  test('includes general, file-finder, command-runner, reviewer, and researcher-web', () => {
    expect(agentCatalog().map((definition) => definition.id)).toEqual([
      'general',
      'file-finder',
      'command-runner',
      'reviewer',
      'researcher-web',
    ])
  })
})

describe('getAgentDefinition', () => {
  test('looks up spawnable definitions by id', () => {
    expect(getAgentDefinition('general')).toBe(generalAgent)
    expect(getAgentDefinition('file-finder')).toBe(fileFinderAgent)
    expect(getAgentDefinition('command-runner')).toBe(commandRunnerAgent)
    expect(getAgentDefinition('reviewer')?.id).toBe('reviewer')
    expect(getAgentDefinition('researcher-web')?.id).toBe('researcher-web')
  })

  test('returns undefined for unknown or non-spawnable ids', () => {
    expect(getAgentDefinition('nope')).toBeUndefined()
    expect(getAgentDefinition('root')).toBeUndefined()
  })
})
