import type { AgentDefinition } from '../types'

export const commandRunnerAgent: AgentDefinition = {
  id: 'command-runner',
  displayName: 'Command Runner',
  toolNames: ['Read', 'Bash'],
  spawnableAgents: [],
  inheritParentSystemPrompt: false,
  includeMessageHistory: false,
  maxRounds: 2,
  outputMode: 'last_message',
  systemPrompt: [
    'You are a command-runner specialist.',
    'Run the given command with Bash and report the result.',
    'Include the output and exit code.',
    'Do not explore the repo or chain extra commands.',
  ].join('\n'),
}
