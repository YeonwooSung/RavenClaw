import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const AGENTS_STARTER = `# AGENTS.md

Project instructions for RavenClaw. Loaded into the agent context.

## Commands

- Test: \`bun test\`
- CLI: \`bun run raven --help\`

## Notes

- Keep changes scoped to the request.
- Do not commit secrets.
`

export function initProject(cwd: string): { path: string; created: boolean } {
  const path = join(cwd, 'AGENTS.md')
  if (existsSync(path)) return { path, created: false }
  mkdirSync(cwd, { recursive: true })
  writeFileSync(path, AGENTS_STARTER, 'utf8')
  return { path, created: true }
}
