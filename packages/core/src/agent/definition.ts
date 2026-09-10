import type { AgentDefinition, Funding, Message, Tool } from '../types'

export const CHILD_RESULT_CHAR_BOUND = 32_000

const NESTING_DENIED = new Set(['Agent', 'EnterPlanMode', 'ExitPlanMode'])

export function resolveChildModel(
  parent: { model: string; funding: Funding },
  definition: AgentDefinition,
): string {
  if (parent.funding === 'included') return parent.model
  return definition.model ?? parent.model
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
