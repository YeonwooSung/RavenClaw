import { describe, expect, test } from 'bun:test'
import type { AgentDefinition, Tool } from '../types'
import { childToolNames, filterChildTools, resolveChildModel } from './definition'
import { commandRunnerAgent } from './command-runner'
import { fileFinderAgent } from './file-finder'
import { generalAgent } from './general'
import { rootAgent } from './root'

function stubTool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    parse() {
      return { ok: true, value: {} }
    },
    isConcurrencySafe() {
      return true
    },
    isReadOnly() {
      return true
    },
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute() {
      return name
    },
  }
}

describe('rootAgent', () => {
  test('shape: tools, spawnableAgents, maxRounds 80', () => {
    expect(rootAgent.id).toBe('root')
    expect(rootAgent.displayName).toBe('RavenClaw')
    expect(rootAgent.toolNames).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Edit',
      'Write',
      'Bash',
      'Skill',
      'Agent',
      'EnterPlanMode',
      'ExitPlanMode',
    ])
    expect(rootAgent.spawnableAgents).toEqual(['general', 'file-finder', 'command-runner'])
    expect(rootAgent.inheritParentSystemPrompt).toBe(false)
    expect(rootAgent.includeMessageHistory).toBe(false)
    expect(rootAgent.maxRounds).toBe(80)
    expect(rootAgent.outputMode).toBe('last_message')
    expect(rootAgent.model).toBeUndefined()
  })
})

describe('generalAgent', () => {
  test('shape: tools, spawnableAgents, maxRounds 30', () => {
    expect(generalAgent.id).toBe('general')
    expect(generalAgent.displayName).toBe('General')
    expect(generalAgent.toolNames).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Edit',
      'Write',
      'Bash',
      'Skill',
    ])
    expect(generalAgent.spawnableAgents).toEqual([])
    expect(generalAgent.inheritParentSystemPrompt).toBe(true)
    expect(generalAgent.includeMessageHistory).toBe(false)
    expect(generalAgent.maxRounds).toBe(30)
    expect(generalAgent.outputMode).toBe('last_message')
    expect(generalAgent.model).toBeUndefined()
  })
})

describe('fileFinderAgent', () => {
  test('shape: Read/Grep/Glob only, maxRounds 20', () => {
    expect(fileFinderAgent.id).toBe('file-finder')
    expect(fileFinderAgent.displayName).toBe('File Finder')
    expect(fileFinderAgent.toolNames).toEqual(['Read', 'Grep', 'Glob'])
    expect(fileFinderAgent.spawnableAgents).toEqual([])
    expect(fileFinderAgent.inheritParentSystemPrompt).toBe(true)
    expect(fileFinderAgent.includeMessageHistory).toBe(false)
    expect(fileFinderAgent.maxRounds).toBe(20)
    expect(fileFinderAgent.outputMode).toBe('last_message')
    expect(fileFinderAgent.model).toBeUndefined()
  })
})

describe('commandRunnerAgent', () => {
  test('shape: Read/Bash only, maxRounds 20', () => {
    expect(commandRunnerAgent.id).toBe('command-runner')
    expect(commandRunnerAgent.displayName).toBe('Command Runner')
    expect(commandRunnerAgent.toolNames).toEqual(['Read', 'Bash'])
    expect(commandRunnerAgent.spawnableAgents).toEqual([])
    expect(commandRunnerAgent.inheritParentSystemPrompt).toBe(true)
    expect(commandRunnerAgent.includeMessageHistory).toBe(false)
    expect(commandRunnerAgent.maxRounds).toBe(20)
    expect(commandRunnerAgent.outputMode).toBe('last_message')
    expect(commandRunnerAgent.model).toBeUndefined()
  })
})

describe('resolveChildModel', () => {
  const named: AgentDefinition = {
    ...generalAgent,
    model: 'helper-small',
  }

  test('defaults to parent.model when definition omits model', () => {
    expect(resolveChildModel({ model: 'parent-model', funding: 'byok' }, generalAgent)).toBe(
      'parent-model',
    )
  })

  test('uses definition.model when funding is not included', () => {
    expect(resolveChildModel({ model: 'parent-model', funding: 'byok' }, named)).toBe(
      'helper-small',
    )
  })

  test('ignores definition.model when funding is included', () => {
    expect(resolveChildModel({ model: 'parent-model', funding: 'included' }, named)).toBe(
      'parent-model',
    )
  })
})

describe('child tools', () => {
  test('childToolNames drops Agent and plan tools', () => {
    expect(childToolNames(rootAgent)).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Edit',
      'Write',
      'Bash',
      'Skill',
    ])
    expect(childToolNames(generalAgent)).toEqual(generalAgent.toolNames)
  })

  test('filterChildTools keeps only the definition allow-list from the parent pool', () => {
    const pool = [
      stubTool('Read'),
      stubTool('Agent'),
      stubTool('EnterPlanMode'),
      stubTool('ExitPlanMode'),
      stubTool('Edit'),
      stubTool('Unknown'),
    ]
    expect(filterChildTools(pool, generalAgent).map((tool) => tool.name)).toEqual([
      'Read',
      'Edit',
    ])
  })

  test('filterChildTools for specialists keeps only their allow-list', () => {
    const pool = [
      stubTool('Read'),
      stubTool('Grep'),
      stubTool('Glob'),
      stubTool('Edit'),
      stubTool('Write'),
      stubTool('Bash'),
      stubTool('Skill'),
      stubTool('Agent'),
      stubTool('EnterPlanMode'),
      stubTool('ExitPlanMode'),
    ]
    expect(filterChildTools(pool, fileFinderAgent).map((tool) => tool.name)).toEqual([
      'Read',
      'Grep',
      'Glob',
    ])
    expect(filterChildTools(pool, commandRunnerAgent).map((tool) => tool.name)).toEqual([
      'Read',
      'Bash',
    ])
  })
})
