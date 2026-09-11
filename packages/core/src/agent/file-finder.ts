import type { AgentDefinition } from '../types'

export const fileFinderAgent: AgentDefinition = {
  id: 'file-finder',
  displayName: 'File Finder',
  toolNames: ['Read', 'Grep', 'Glob'],
  spawnableAgents: [],
  inheritParentSystemPrompt: false,
  includeMessageHistory: false,
  maxRounds: 8,
  outputMode: 'last_message',
  systemPrompt: [
    'You are a file-finder specialist.',
    'Return only lines of the form:',
    'path — reason',
    'Prefer Glob and Grep over Read.',
    'Use Read only to confirm a few likely files.',
    'Cap Reads; do not scan the tree by reading files.',
    'At most 20 lines. No preamble or closing summary.',
    'If nothing matches, return no lines.',
    'Use workspace-relative paths.',
    'Do not edit files or run shell commands.',
  ].join('\n'),
}
