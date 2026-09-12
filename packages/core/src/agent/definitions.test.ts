import { describe, expect, test } from 'bun:test'
import { commandRunnerAgent } from './command-runner'
import { fileFinderAgent } from './file-finder'
import { generalAgent } from './general'
import { researcherWebAgent } from './researcher-web'
import { reviewerAgent } from './reviewer'
import { rootAgent } from './root'

describe('builtin agent definitions', () => {
  test('root lists spawnable specialists and no vendor brand strings', () => {
    expect(rootAgent.id).toBe('root')
    expect(rootAgent.spawnableAgents).toEqual([
      'general',
      'file-finder',
      'command-runner',
      'reviewer',
      'researcher-web',
    ])
    expect(rootAgent.toolNames).toContain('Read')
    expect(rootAgent.toolNames).toContain('Agent')
    expect(JSON.stringify(rootAgent)).not.toMatch(/claude|hermes|freebuff/i)
  })

  test('general inherits parent system and can edit', () => {
    expect(generalAgent.inheritParentSystemPrompt).toBe(true)
    expect(generalAgent.toolNames).toContain('Edit')
    expect(generalAgent.spawnableAgents).toEqual([])
  })

  test('file-finder is read-only search', () => {
    expect(fileFinderAgent.toolNames).toEqual(['Read', 'Grep', 'Glob'])
    expect(fileFinderAgent.systemPrompt).toContain('path — reason')
    expect(fileFinderAgent.includeMessageHistory).toBe(false)
  })

  test('command-runner is Read+Bash only', () => {
    expect(commandRunnerAgent.toolNames).toEqual(['Read', 'Bash'])
    expect(commandRunnerAgent.maxRounds).toBe(2)
    expect(commandRunnerAgent.systemPrompt).toContain('Do not explore')
  })

  test('reviewer has no tools and keeps parent history', () => {
    expect(reviewerAgent.toolNames).toEqual([])
    expect(reviewerAgent.includeMessageHistory).toBe(true)
    expect(reviewerAgent.systemPrompt).toContain('No tools')
  })

  test('researcher-web uses WebSearch and Fetch', () => {
    expect(researcherWebAgent.toolNames).toEqual(['WebSearch', 'Fetch'])
    expect(researcherWebAgent.systemPrompt).toContain('Fetch at least 3')
  })
})
