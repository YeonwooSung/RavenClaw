import { describe, expect, test } from 'bun:test'
import { INCOMPLETE_TEXT } from '../loop/pairing'
import type { AgentDefinition, Message, Tool } from '../types'
import {
  addTokenUsage,
  buildChildMessages,
  childSystemParts,
  childToolNames,
  filterChildTools,
  resolveChildModel,
} from './definition'
import { commandRunnerAgent } from './command-runner'
import { fileFinderAgent } from './file-finder'
import { generalAgent } from './general'
import { researcherWebAgent } from './researcher-web'
import { reviewerAgent } from './reviewer'
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
      'ListDir',
      'ReadSubtree',
      'Edit',
      'Write',
      'ApplyPatch',
      'NotebookEdit',
      'Bash',
      'Skill',
      'Fetch',
      'WebSearch',
      'TodoWrite',
      'TaskOutput',
      'TaskStop',
      'AskUser',
      'SetOutput',
      'AddDir',
      'ToolSearch',
      'ToolCall',
      'LSP',
      'EnterWorktree',
      'ExitWorktree',
      'CronCreate',
      'CronList',
      'CronDelete',
      'CronSetEnabled',
      'Agent',
      'EnterPlanMode',
      'ExitPlanMode',
    ])
    expect(rootAgent.spawnableAgents).toEqual([
      'general',
      'file-finder',
      'command-runner',
      'reviewer',
      'researcher-web',
    ])
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
      'ListDir',
      'Edit',
      'Write',
      'ApplyPatch',
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
  test('shape: Read/Grep/Glob only, maxRounds 8, own system prompt', () => {
    expect(fileFinderAgent.id).toBe('file-finder')
    expect(fileFinderAgent.displayName).toBe('File Finder')
    expect(fileFinderAgent.toolNames).toEqual(['Read', 'Grep', 'Glob'])
    expect(fileFinderAgent.spawnableAgents).toEqual([])
    expect(fileFinderAgent.inheritParentSystemPrompt).toBe(false)
    expect(fileFinderAgent.includeMessageHistory).toBe(false)
    expect(fileFinderAgent.maxRounds).toBe(8)
    expect(fileFinderAgent.outputMode).toBe('last_message')
    expect(fileFinderAgent.model).toBeUndefined()
    const prompt = fileFinderAgent.systemPrompt ?? ''
    const lines = prompt.split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(8)
    expect(lines.length).toBeLessThanOrEqual(15)
    expect(prompt).toMatch(/path\s+—\s+reason/)
    expect(prompt).toMatch(/Glob/)
    expect(prompt).toMatch(/Grep/)
    expect(prompt).toMatch(/Read/)
  })
})

describe('reviewerAgent', () => {
  test('shape: no tools, includes history, maxRounds 4', () => {
    expect(reviewerAgent.id).toBe('reviewer')
    expect(reviewerAgent.displayName).toBe('Reviewer')
    expect(reviewerAgent.toolNames).toEqual([])
    expect(reviewerAgent.spawnableAgents).toEqual([])
    expect(reviewerAgent.inheritParentSystemPrompt).toBe(false)
    expect(reviewerAgent.includeMessageHistory).toBe(true)
    expect(reviewerAgent.maxRounds).toBe(4)
    expect(reviewerAgent.outputMode).toBe('last_message')
    expect(reviewerAgent.model).toBeUndefined()
    const prompt = reviewerAgent.systemPrompt ?? ''
    expect(prompt).toMatch(/review/i)
    expect(prompt).toMatch(/findings/i)
    expect(prompt).toMatch(/no tools/i)
  })
})

describe('researcherWebAgent', () => {
  test('shape: WebSearch and Fetch, maxRounds 12, own system prompt', () => {
    expect(researcherWebAgent.id).toBe('researcher-web')
    expect(researcherWebAgent.displayName).toBe('Web Researcher')
    expect(researcherWebAgent.toolNames).toEqual(['WebSearch', 'Fetch'])
    expect(researcherWebAgent.spawnableAgents).toEqual([])
    expect(researcherWebAgent.inheritParentSystemPrompt).toBe(false)
    expect(researcherWebAgent.includeMessageHistory).toBe(false)
    expect(researcherWebAgent.maxRounds).toBe(12)
    expect(researcherWebAgent.outputMode).toBe('last_message')
    expect(researcherWebAgent.model).toBeUndefined()
    const prompt = researcherWebAgent.systemPrompt ?? ''
    expect(prompt).toMatch(/WebSearch/)
    expect(prompt).toMatch(/Fetch/)
    expect(prompt).toMatch(/3/)
  })
})

describe('commandRunnerAgent', () => {
  test('shape: Read/Bash only, maxRounds 2, own system prompt', () => {
    expect(commandRunnerAgent.id).toBe('command-runner')
    expect(commandRunnerAgent.displayName).toBe('Command Runner')
    expect(commandRunnerAgent.toolNames).toEqual(['Read', 'Bash'])
    expect(commandRunnerAgent.spawnableAgents).toEqual([])
    expect(commandRunnerAgent.inheritParentSystemPrompt).toBe(false)
    expect(commandRunnerAgent.includeMessageHistory).toBe(false)
    expect(commandRunnerAgent.maxRounds).toBe(2)
    expect(commandRunnerAgent.outputMode).toBe('last_message')
    expect(commandRunnerAgent.model).toBeUndefined()
    const prompt = commandRunnerAgent.systemPrompt ?? ''
    expect(prompt.length).toBeGreaterThan(0)
    expect(prompt).toMatch(/command/i)
    expect(prompt).toMatch(/report/i)
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
  test('childToolNames drops Agent, plan, cron, AskUser, and SetOutput', () => {
    expect(childToolNames(rootAgent)).toEqual([
      'Read',
      'Grep',
      'Glob',
      'ListDir',
      'ReadSubtree',
      'Edit',
      'Write',
      'ApplyPatch',
      'NotebookEdit',
      'Bash',
      'Skill',
      'Fetch',
      'WebSearch',
      'TodoWrite',
      'TaskOutput',
      'TaskStop',
      'ToolSearch',
      'ToolCall',
      'LSP',
    ])
    expect(childToolNames(rootAgent)).not.toContain('CronCreate')
    expect(childToolNames(rootAgent)).not.toContain('CronList')
    expect(childToolNames(rootAgent)).not.toContain('CronDelete')
    expect(childToolNames(rootAgent)).not.toContain('CronSetEnabled')
    expect(childToolNames(rootAgent)).not.toContain('AskUser')
    expect(childToolNames(rootAgent)).not.toContain('SetOutput')
    expect(childToolNames(rootAgent)).not.toContain('AddDir')
    expect(childToolNames(rootAgent)).not.toContain('EnterWorktree')
    expect(childToolNames(rootAgent)).not.toContain('ExitWorktree')
    expect(childToolNames(generalAgent)).toEqual(generalAgent.toolNames)

    const withRootOnly: AgentDefinition = {
      ...rootAgent,
      toolNames: [...rootAgent.toolNames, 'AskUser', 'SetOutput'],
    }
    expect(childToolNames(withRootOnly)).not.toContain('AskUser')
    expect(childToolNames(withRootOnly)).not.toContain('SetOutput')
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
    expect(filterChildTools(pool, reviewerAgent).map((tool) => tool.name)).toEqual([])
    expect(
      filterChildTools([...pool, stubTool('WebSearch'), stubTool('Fetch')], researcherWebAgent).map(
        (tool) => tool.name,
      ),
    ).toEqual(['WebSearch', 'Fetch'])
  })
})

describe('childSystemParts', () => {
  const parent = [{ tier: 'stable' as const, text: 'PARENT_SYSTEM' }]

  test('inheritParentSystemPrompt uses parent system', () => {
    expect(childSystemParts(generalAgent, parent)).toEqual(parent)
    expect(childSystemParts(generalAgent, undefined)).toBeUndefined()
  })

  test('own systemPrompt is a single SystemPart when inherit is false', () => {
    const parts = childSystemParts(fileFinderAgent, parent)
    expect(parts).toEqual([{ tier: 'stable', text: fileFinderAgent.systemPrompt }])
    const runner = childSystemParts(commandRunnerAgent, parent)
    expect(runner).toEqual([{ tier: 'stable', text: commandRunnerAgent.systemPrompt }])
  })

  test('inherit false without systemPrompt yields undefined', () => {
    const bare: AgentDefinition = {
      ...fileFinderAgent,
      systemPrompt: undefined,
    }
    expect(childSystemParts(bare, parent)).toBeUndefined()
  })
})

describe('buildChildMessages', () => {
  const childUser: Extract<Message, { role: 'user' }> = {
    id: 'child_user',
    role: 'user',
    blocks: [{ type: 'text', text: 'child goal' }],
    createdAt: 9,
  }

  test('default catalog omits parent history', () => {
    const parent: Message[] = [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'PARENT_SECRET' }],
        createdAt: 1,
      },
    ]
    expect(buildChildMessages(fileFinderAgent, parent, childUser)).toEqual([childUser])
    expect(buildChildMessages(generalAgent, parent, childUser)).toEqual([childUser])
  })

  test('includeMessageHistory copies parent messages and drops the current Agent tool_use', () => {
    const parent: Message[] = [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'PARENT_SECRET' }],
        createdAt: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'delegating' },
          { type: 'tool_use', id: 'call_agent', name: 'Agent', input: { prompt: 'child goal' } },
        ],
        createdAt: 2,
      },
    ]
    const definition: AgentDefinition = { ...generalAgent, includeMessageHistory: true }
    const messages = buildChildMessages(definition, parent, childUser)
    expect(messages.some((msg) => msg.role === 'user' && msg.blocks[0]?.type === 'text' && msg.blocks[0].text.includes('PARENT_SECRET'))).toBe(true)
    expect(messages[messages.length - 1]).toEqual(childUser)
    expect(
      messages.some(
        (msg) =>
          msg.role === 'assistant' &&
          msg.blocks.some((block) => block.type === 'tool_use' && block.id === 'call_agent'),
      ),
    ).toBe(false)
    expect(parent[1]).toEqual({
      id: 'a1',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'delegating' },
        { type: 'tool_use', id: 'call_agent', name: 'Agent', input: { prompt: 'child goal' } },
      ],
      createdAt: 2,
    })
  })

  test('includeMessageHistory repairs unpaired sibling tool_use after dropping Agent', () => {
    const parent: Message[] = [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'go' }],
        createdAt: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        blocks: [
          { type: 'tool_use', id: 'call_read', name: 'Read', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'call_agent', name: 'Agent', input: { prompt: 'child' } },
        ],
        createdAt: 2,
      },
    ]
    const definition: AgentDefinition = { ...generalAgent, includeMessageHistory: true }
    const messages = buildChildMessages(definition, parent, childUser)
    const readResult = messages.find(
      (msg): msg is Extract<Message, { role: 'tool' }> =>
        msg.role === 'tool' && msg.toolUseId === 'call_read',
    )
    expect(readResult?.ok).toBe(false)
    expect(readResult?.blocks[0]?.text).toBe(INCOMPLETE_TEXT)
    expect(messages.some((msg) => msg.role === 'tool' && msg.toolUseId === 'call_agent')).toBe(
      false,
    )
  })
})

describe('addTokenUsage', () => {
  test('sums child usage into parent totals', () => {
    expect(
      addTokenUsage(
        { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 },
        { input: 5, output: 3, cacheRead: 1, cacheWrite: 7 },
      ),
    ).toEqual({ input: 15, output: 7, cacheRead: 3, cacheWrite: 8 })
  })
})
