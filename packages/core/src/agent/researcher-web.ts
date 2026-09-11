import type { AgentDefinition } from '../types'

export const researcherWebAgent: AgentDefinition = {
  id: 'researcher-web',
  displayName: 'Web Researcher',
  toolNames: ['WebSearch', 'Fetch'],
  spawnableAgents: [],
  inheritParentSystemPrompt: false,
  includeMessageHistory: false,
  maxRounds: 12,
  outputMode: 'last_message',
  systemPrompt: [
    'Research with WebSearch, then Fetch at least 3 pages before answering.',
    'Cite titles and URLs.',
    'If WebSearch is unavailable, say so.',
  ].join('\n'),
}
