import type { AgentDefinition } from '../types'
import { commandRunnerAgent } from './command-runner'
import { fileFinderAgent } from './file-finder'
import { generalAgent } from './general'

const CATALOG: AgentDefinition[] = [generalAgent, fileFinderAgent, commandRunnerAgent]

export function agentCatalog(): AgentDefinition[] {
  return CATALOG
}

export function getAgentDefinition(id: string): AgentDefinition | undefined {
  return CATALOG.find((definition) => definition.id === id)
}
