import type { AgentDefinition } from '../types'

export const reviewerAgent: AgentDefinition = {
  id: 'reviewer',
  displayName: 'Reviewer',
  toolNames: [],
  spawnableAgents: [],
  inheritParentSystemPrompt: false,
  includeMessageHistory: true,
  maxRounds: 4,
  outputMode: 'last_message',
  systemPrompt: [
    "You review the conversation's recent edits.",
    'Findings first, severity, file paths.',
    'No tools. No secrets.',
    'If nothing to flag, say so in one line.',
  ].join('\n'),
}
