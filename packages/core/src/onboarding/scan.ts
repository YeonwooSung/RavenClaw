import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { agentCatalog } from '../agent/catalog'
import type { McpConfig } from '../config'
import { listConfiguredHookEvents } from '../hooks/lifecycle'
import { discoverSkills } from '../tools/skill'
import type { Message, SessionRecord, SessionStore } from '../types'

export const ONBOARDING_USAGE_DAYS = 30

const PROJECT_FILE_KINDS = ['AGENTS.md', 'RAVEN.md', 'CLAUDE.md'] as const
const SLASH_RE = /^\/([A-Za-z][\w-]*)/
const DAY_MS = 24 * 60 * 60 * 1000
const GIT_TIMEOUT_MS = 5_000

type ProjectFileKind = (typeof PROJECT_FILE_KINDS)[number]

export type OnboardingScan = {
  teamName: string
  projectFiles: { relPath: string; kind: ProjectFileKind }[]
  skills: { name: string; source: 'builtin' | 'user' | 'project'; disabled?: boolean; stale?: boolean }[]
  agents: { id: string; displayName: string }[]
  hookEvents: string[]
  mcpServers: { name: string; transport: string }[]
  usage: {
    label: string
    days: number
    sessionCount: number
    slashCounts: { name: string; count: number }[]
  }
  missing: string[]
}

export async function scanTeamOnboarding(opts: {
  cwd: string
  home: string
  store: SessionStore
  mcp: McpConfig
  now?: () => number
}): Promise<OnboardingScan> {
  const projectFiles = listProjectFiles(opts.cwd)
  const teamName =
    headingFromProjectFiles(opts.cwd) ?? teamNameFromGit(opts.cwd) ?? 'this workspace'
  const skills = discoverSkills(opts.cwd, opts.home).map((skill) => {
    const row: OnboardingScan['skills'][number] = { name: skill.name, source: skill.source }
    if (skill.disabled) row.disabled = true
    if (skill.stale) row.stale = true
    return row
  })
  const agents = agentCatalog(opts.cwd).map((agent) => ({
    id: agent.id,
    displayName: agent.displayName,
  }))
  const hookEvents = listConfiguredHookEvents(opts.cwd, opts.home)
  const mcpServers = opts.mcp.servers.map((server) => ({
    name: server.name,
    transport: server.type ?? 'stdio',
  }))

  const now = (opts.now ?? Date.now)()
  const cutoff = now - ONBOARDING_USAGE_DAYS * DAY_MS
  const sessions = (await opts.store.listSessions({ cwd: opts.cwd, parentSessionId: null })).filter(
    (session) => session.updatedAt >= cutoff,
  )
  const slashCounts = await countSlashCommands(opts.store, sessions)

  const missing: string[] = []
  if (projectFiles.length === 0) missing.push('no AGENTS.md/RAVEN.md/CLAUDE.md in cwd')
  if (mcpServers.length === 0) missing.push('no MCP servers in config')
  if (!skills.some((skill) => skill.source === 'project')) missing.push('no project skills')

  return {
    teamName,
    projectFiles,
    skills,
    agents,
    hookEvents,
    mcpServers,
    usage: {
      label: `your last ${ONBOARDING_USAGE_DAYS} days in this workspace`,
      days: ONBOARDING_USAGE_DAYS,
      sessionCount: sessions.length,
      slashCounts,
    },
    missing,
  }
}

function listProjectFiles(cwd: string): OnboardingScan['projectFiles'] {
  const files: OnboardingScan['projectFiles'] = []
  for (const kind of PROJECT_FILE_KINDS) {
    if (!isFile(join(cwd, kind))) continue
    files.push({ relPath: kind, kind })
  }
  return files
}

function headingFromProjectFiles(cwd: string): string | undefined {
  for (const kind of PROJECT_FILE_KINDS) {
    const heading = firstHeading(readUtf8(join(cwd, kind)))
    if (heading !== undefined) return heading
  }
  return undefined
}

function firstHeading(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const match = /^#\s+(.+)$/m.exec(text)
  const title = match?.[1]?.trim()
  return title && title.length > 0 ? title : undefined
}

function teamNameFromGit(cwd: string): string | undefined {
  const r = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
  })
  if (r.status !== 0) return undefined
  const url = r.stdout.trim()
  if (url.length === 0) return undefined
  const stripped = url.replace(/\/+$/, '').replace(/\.git$/, '')
  const name = basename(stripped.includes(':') ? stripped.slice(stripped.lastIndexOf(':') + 1) : stripped)
  return name.length > 0 ? name : undefined
}

async function countSlashCommands(
  store: SessionStore,
  sessions: SessionRecord[],
): Promise<OnboardingScan['usage']['slashCounts']> {
  const loadMessages = resolveLoadMessages(store)
  if (loadMessages === undefined) return []

  const counts = new Map<string, number>()
  for (const session of sessions) {
    let messages: Message[]
    try {
      messages = await loadMessages(session.id)
    } catch {
      continue
    }
    for (const message of messages) {
      if (message.role !== 'user') continue
      // loadSession joins consecutive user rows; count each matching line.
      for (const line of userText(message).split(/\r?\n/)) {
        const match = SLASH_RE.exec(line.trim())
        const name = match?.[1]
        if (name === undefined || name === 'team-onboarding') continue
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    }
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, 8)
}

function resolveLoadMessages(
  store: SessionStore,
): ((sessionId: string) => Promise<Message[]>) | undefined {
  const extra = store as SessionStore & {
    loadMessages?: (sessionId: string) => Promise<Message[]>
  }
  if (typeof extra.loadMessages === 'function') {
    return (sessionId) => extra.loadMessages!(sessionId)
  }
  if (typeof store.loadSession === 'function') {
    return async (sessionId) => (await store.loadSession(sessionId)).messages
  }
  return undefined
}

function userText(message: Extract<Message, { role: 'user' }>): string {
  return message.blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function readUtf8(path: string): string | undefined {
  if (!isFile(path)) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}
