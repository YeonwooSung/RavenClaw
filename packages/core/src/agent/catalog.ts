import type { AgentDefinition } from '../types'
import { commandRunnerAgent } from './command-runner'
import { fileFinderAgent } from './file-finder'
import { generalAgent } from './general'
import { loadDiskAgents } from './load'
import { researcherWebAgent } from './researcher-web'
import { reviewerAgent } from './reviewer'

const CATALOG: AgentDefinition[] = [
  generalAgent,
  fileFinderAgent,
  commandRunnerAgent,
  reviewerAgent,
  researcherWebAgent,
]

export function agentCatalog(cwd?: string): AgentDefinition[] {
  if (cwd === undefined) return CATALOG
  const extra = loadDiskAgents(cwd).filter((agent) => !CATALOG.some((row) => row.id === agent.id))
  return [...CATALOG, ...extra]
}

export function getAgentDefinition(id: string, cwd?: string): AgentDefinition | undefined {
  return agentCatalog(cwd).find((definition) => definition.id === id)
}
