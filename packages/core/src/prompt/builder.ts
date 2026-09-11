import { execFileSync } from 'node:child_process'
import type { PermissionMode, SystemPart } from '../types'
import { discoverSkills } from '../tools/skill'
import { loadProjectFileTree } from './file-tree'
import { loadMemorySnapshot } from './memory'
import { loadProjectFiles } from './project-files'

const SKILL_DESC_MAX = 60

export interface PromptBuildInput {
  cwd: string
  permissionMode: PermissionMode
  locale?: string
  skills?: Array<{ name: string; description: string }>
  git?: { branch: string; head: string; dirty: boolean } | null
  /** Optional preloaded project text (tests). If omitted, load from cwd walk. */
  projectFilesText?: string
}

export function buildSystemParts(input: PromptBuildInput): SystemPart[] {
  const projectText =
    input.projectFilesText !== undefined ? input.projectFilesText : loadProjectFiles(input.cwd)
  const memoryText = loadMemorySnapshot(input.cwd)
  const fileTree = loadProjectFileTree(input.cwd)
  const git = resolveGit(input)
  return [
    { tier: 'stable', text: buildStablePrompt(input.permissionMode), cacheBreakpoint: true },
    {
      tier: 'context',
      text: buildContextPrompt(projectText, git, memoryText, fileTree),
      cacheBreakpoint: true,
    },
    { tier: 'volatile', text: buildVolatilePrompt(input) },
  ]
}

export function buildStablePrompt(permissionMode: PermissionMode): string {
  return [
    'RavenClaw is a coding agent. It uses tools to read, edit, and run commands in the workspace.',
    '',
    'Use tools to inspect and change the workspace instead of guessing. Read a file before editing it. Treat tool results as the source of truth.',
    '',
    'Permission modes control when RavenClaw asks before a tool runs:',
    '- default: ask before workspace changes and before commands that are not clearly read-only (ls/echo/pwd and git status/log/diff may proceed).',
    '- acceptEdits: in-workspace file edits may proceed without asking; other leftover asks still prompt.',
    '- plan: mutating tools are denied. Write a plan in text until plan mode ends.',
    '- dontAsk: leftover asks become denials except in-workspace Edit/Write and read-only tools. For unattended runs.',
    '',
    `Current permission mode: ${permissionMode}`,
  ].join('\n')
}

function buildContextPrompt(
  projectText: string,
  git: { branch: string; head: string; dirty: boolean } | null,
  memoryText: string,
  fileTree: string,
): string {
  const lines = ['Project instructions:']
  if (projectText.length > 0) {
    lines.push(projectText)
  }
  if (fileTree.length > 0) {
    if (lines.length > 1) lines.push('')
    lines.push('Project files:')
    lines.push(fileTree)
  }
  if (memoryText.length > 0) {
    if (lines.length > 1) lines.push('')
    lines.push(memoryText)
  }
  if (git !== null) {
    if (lines.length > 1) lines.push('')
    lines.push('Git snapshot:')
    lines.push(`branch: ${git.branch}`)
    lines.push(`HEAD: ${git.head}`)
    lines.push(`dirty: ${git.dirty ? 'true' : 'false'}`)
  }
  return lines.join('\n')
}

function buildVolatilePrompt(input: PromptBuildInput): string {
  const lines = [`cwd: ${input.cwd}`]
  if (input.locale !== undefined) {
    lines.push(`locale: ${input.locale}`)
  }
  lines.push('')
  const skills = input.skills !== undefined ? input.skills : discoverSkills(input.cwd)
  if (skills.length === 0) {
    lines.push('Skills: none')
  } else {
    lines.push('Skills:')
    for (const skill of skills) {
      lines.push(`- ${skill.name}: ${clipSkillDescription(skill.description)}`)
    }
  }
  return lines.join('\n')
}

function clipSkillDescription(description: string): string {
  return description.length <= SKILL_DESC_MAX ? description : description.slice(0, SKILL_DESC_MAX)
}

function resolveGit(
  input: PromptBuildInput,
): { branch: string; head: string; dirty: boolean } | null {
  if (input.git === null) return null
  if (input.git !== undefined) return input.git
  return tryGitSnapshot(input.cwd)
}

function tryGitSnapshot(cwd: string): { branch: string; head: string; dirty: boolean } | null {
  try {
    const opts = {
      cwd,
      encoding: 'utf8' as const,
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'] as const,
    }
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).trim()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim()
    const status = execFileSync('git', ['status', '--porcelain'], opts)
    return { branch, head, dirty: status.trim().length > 0 }
  } catch {
    return null
  }
}
