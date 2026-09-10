import type { AgentDefinition } from '../types'

export const fileFinderAgent: AgentDefinition = {
  id: 'file-finder',
  displayName: 'File Finder',
  toolNames: ['Read', 'Grep', 'Glob'],
  spawnableAgents: [],
  inheritParentSystemPrompt: true,
  includeMessageHistory: false,
  maxRounds: 20,
  outputMode: 'last_message',
}
