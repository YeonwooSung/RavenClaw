import type { AgentDefinition } from '../types'

export const generalAgent: AgentDefinition = {
  id: 'general',
  displayName: 'General',
  toolNames: ['Read', 'Grep', 'Glob', 'ListDir', 'Edit', 'Write', 'ApplyPatch', 'Bash', 'Skill'],
  spawnableAgents: [],
  inheritParentSystemPrompt: true,
  includeMessageHistory: false,
  maxRounds: 30,
  outputMode: 'last_message',
}
