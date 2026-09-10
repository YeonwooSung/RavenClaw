import type { AgentDefinition } from '../types'

export const rootAgent: AgentDefinition = {
  id: 'root',
  displayName: 'RavenClaw',
  toolNames: [
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
  ],
  spawnableAgents: ['general'],
  inheritParentSystemPrompt: false,
  includeMessageHistory: false,
  maxRounds: 80,
  outputMode: 'last_message',
}
