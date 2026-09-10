import type { AgentDefinition } from '../types'

export const commandRunnerAgent: AgentDefinition = {
  id: 'command-runner',
  displayName: 'Command Runner',
  toolNames: ['Read', 'Bash'],
  spawnableAgents: [],
  inheritParentSystemPrompt: true,
  includeMessageHistory: false,
  maxRounds: 20,
  outputMode: 'last_message',
}
