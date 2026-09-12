import { repairRoleAlternation } from '../loop/repair'
import type { AgentDefinition, Funding, Message, SystemPart, TokenUsage, Tool } from '../types'

export const CHILD_RESULT_CHAR_BOUND = 32_000

const NESTING_DENIED = new Set([
  'Agent',
  'EnterPlanMode',
  'ExitPlanMode',
  'CronCreate',
  'CronList',
  'CronDelete',
  'CronSetEnabled',
  'AskUser',
  'SetOutput',
  'EnterWorktree',
  'ExitWorktree',
  'AddDir',
  'TaskSteer',
])

export function resolveChildModel(
  parent: { model: string; funding: Funding; specialistModel?: string },
  definition: AgentDefinition,
): string {
  if (parent.funding === 'included') return parent.model
  return definition.model ?? parent.specialistModel ?? parent.model
}

export function childToolNames(definition: AgentDefinition): string[] {
  return definition.toolNames.filter((name) => !NESTING_DENIED.has(name))
}

export function filterChildTools(pool: Tool[], definition: AgentDefinition): Tool[] {
  const allow = new Set(childToolNames(definition))
  return pool.filter((tool) => allow.has(tool.name))
}

export function boundChildResult(
  text: string,
  max = CHILD_RESULT_CHAR_BOUND,
): string {
  return text.length > max ? text.slice(0, max) : text
}

export function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== 'assistant') continue
    let text = ''
    for (const block of msg.blocks) {
      if (block.type === 'text') text += block.text
    }
    return text
  }
  return ''
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

export function childSystemParts(
  definition: AgentDefinition,
  parentSystem?: SystemPart[],
): SystemPart[] | undefined {
  if (definition.inheritParentSystemPrompt) return parentSystem
  if (definition.systemPrompt !== undefined && definition.systemPrompt.length > 0) {
    return [{ tier: 'stable', text: definition.systemPrompt }]
  }
  return undefined
}

export function buildChildPreamble(
  definition: Pick<AgentDefinition, 'includeMessageHistory'>,
  parentMessages: Message[],
): Message[] {
  if (!definition.includeMessageHistory) return []
  return repairRoleAlternation(stripCurrentAgentToolUse(parentMessages))
}

export function buildChildMessages(
  definition: Pick<AgentDefinition, 'includeMessageHistory'>,
  parentMessages: Message[],
  user: Extract<Message, { role: 'user' }>,
): Message[] {
  return repairRoleAlternation([...buildChildPreamble(definition, parentMessages), user])
}

function stripCurrentAgentToolUse(messages: Message[]): Message[] {
  const out = messages.map(cloneMessage)
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i]
    if (!msg || msg.role !== 'assistant') continue
    const resultIds = new Set<string>()
    for (const row of out) {
      if (row.role === 'tool') resultIds.add(row.toolUseId)
    }
    const unpairedAgent = msg.blocks.filter(
      (block) => block.type === 'tool_use' && block.name === 'Agent' && !resultIds.has(block.id),
    )
    if (unpairedAgent.length === 0) continue
    const drop = new Set(
      unpairedAgent.flatMap((block) => (block.type === 'tool_use' ? [block.id] : [])),
    )
    const blocks = msg.blocks.filter((block) => !(block.type === 'tool_use' && drop.has(block.id)))
    if (blocks.length === 0) out.splice(i, 1)
    else out[i] = { ...msg, blocks }
    break
  }
  return out
}

function cloneMessage(message: Message): Message {
  if (message.role === 'assistant') {
    const copy: Extract<Message, { role: 'assistant' }> = {
      id: message.id,
      role: 'assistant',
      blocks: message.blocks.map((block) => ({ ...block })),
      createdAt: message.createdAt,
    }
    if (message.usage) copy.usage = { ...message.usage }
    return copy
  }
  if (message.role === 'tool') {
    const copy: Extract<Message, { role: 'tool' }> = {
      id: message.id,
      role: 'tool',
      toolUseId: message.toolUseId,
      ok: message.ok,
      blocks: message.blocks.map((block) => ({ ...block })),
      createdAt: message.createdAt,
    }
    if (message.persistPath !== undefined) copy.persistPath = message.persistPath
    return copy
  }
  return {
    id: message.id,
    role: 'user',
    blocks: message.blocks.map((block) => ({ ...block })),
    createdAt: message.createdAt,
  }
}
