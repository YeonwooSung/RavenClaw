import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashSystemParts } from './cache'
import {
  applyPermissionMode,
  buildStablePrompt,
  buildSystemParts,
  type PromptBuildInput,
} from './builder'

const ENV_KEY = 'RAVENCLAW_HOME'

let savedHome: string | undefined
const tempDirs: string[] = []

beforeEach(() => {
  savedHome = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (savedHome === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedHome
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const GIT = { branch: 'main', head: 'abc123def456', dirty: false } as const

function input(overrides: Partial<PromptBuildInput> = {}): PromptBuildInput {
  return {
    cwd: '/workspace/demo',
    permissionMode: 'default',
    projectFilesText: 'project-instructions-body',
    git: GIT,
    locale: 'en-US',
    skills: [{ name: 'demo-skill', description: 'short skill' }],
    ...overrides,
  }
}

describe('buildSystemParts', () => {
  test('hashSystemParts is equal across two rounds with the same input', () => {
    const first = buildSystemParts(input())
    const second = buildSystemParts(input())
    expect(hashSystemParts(first)).toBe(hashSystemParts(second))
    expect(first).toEqual(second)
  })

  test('changing cwd or permissionMode changes the hash', () => {
    const baseParts = buildSystemParts(input())
    const modeParts = buildSystemParts(input({ permissionMode: 'plan' }))
    const base = hashSystemParts(baseParts)
    const cwdHash = hashSystemParts(buildSystemParts(input({ cwd: '/workspace/other' })))
    const modeHash = hashSystemParts(modeParts)
    expect(cwdHash).not.toBe(base)
    expect(modeHash).not.toBe(base)
    expect(cwdHash).not.toBe(modeHash)
    expect(baseParts[0]?.text).toBe(modeParts[0]?.text)
    expect(hashSystemParts(baseParts[0] ? [baseParts[0]] : [])).toBe(
      hashSystemParts(modeParts[0] ? [modeParts[0]] : []),
    )
  })

  test('stable hash is identical across default and plan; full hash moves with mode', () => {
    const def = buildSystemParts(input({ permissionMode: 'default' }))
    const plan = buildSystemParts(input({ permissionMode: 'plan' }))
    expect(def[0]?.text).toBe(plan[0]?.text)
    expect(def[0]?.text).not.toContain('Current permission mode:')
    expect(def[2]?.text).toContain('Current permission mode: default')
    expect(plan[2]?.text).toContain('Current permission mode: plan')
    expect(hashSystemParts(def[0] ? [def[0]] : [])).toBe(hashSystemParts(plan[0] ? [plan[0]] : []))
    expect(hashSystemParts(def)).not.toBe(hashSystemParts(plan))
  })

  test('applyPermissionMode rewrites volatile only', () => {
    const parts = buildSystemParts(input({ permissionMode: 'default' }))
    const next = applyPermissionMode(parts, 'dontAsk')
    expect(next[0]?.text).toBe(parts[0]?.text)
    expect(next[1]?.text).toBe(parts[1]?.text)
    expect(next[2]?.text).toContain('Current permission mode: dontAsk')
    expect(next[2]?.text).not.toContain('Current permission mode: default')
    expect(parts[2]?.text).toContain('Current permission mode: default')
  })

  test('three parts in stable/context/volatile order with cache breakpoints', () => {
    const parts = buildSystemParts(input())
    expect(parts).toHaveLength(3)
    expect(parts[0]?.tier).toBe('stable')
    expect(parts[0]?.cacheBreakpoint).toBe(true)
    expect(parts[1]?.tier).toBe('context')
    expect(parts[1]?.cacheBreakpoint).toBe(true)
    expect(parts[2]?.tier).toBe('volatile')
    expect(parts[2]?.cacheBreakpoint).toBeUndefined()
    expect(parts[2] && 'cacheBreakpoint' in parts[2]).toBe(false)
  })

  test('skills descriptions are truncated to 60 chars', () => {
    const long = 'abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    expect(long.length).toBeGreaterThan(60)
    const parts = buildSystemParts(
      input({ skills: [{ name: 'long-skill', description: long }] }),
    )
    const volatile = parts[2]?.text ?? ''
    expect(volatile).toContain(long.slice(0, 60))
    expect(volatile).not.toContain(long.slice(0, 61))
    expect(volatile).toContain('long-skill')
  })

  test('disabled skills are omitted from the volatile list', () => {
    const parts = buildSystemParts(
      input({
        skills: [
          { name: 'keep', description: 'still on' },
          { name: 'review', description: 'off', disabled: true },
        ],
      }),
    )
    const volatile = parts[2]?.text ?? ''
    expect(volatile).toContain('keep:')
    expect(volatile).not.toContain('review:')
  })

  test('effort is written into the volatile prompt', () => {
    const parts = buildSystemParts(input({ effort: 'high' }))
    expect(parts[2]?.text).toContain('thinking effort: high')
  })

  test('empty skills still emit a stable skills section', () => {
    const a = buildSystemParts(input({ skills: [] }))
    const b = buildSystemParts(input({ skills: [] }))
    expect(a[2]?.text).toBe(b[2]?.text)
    expect(a[2]?.text).toMatch(/skills/i)
  })

  test('omitted skills discover name and clipped description from disk', () => {
    const home = tempDir('ravenclaw-builder-home-')
    const cwd = tempDir('ravenclaw-builder-cwd-')
    process.env[ENV_KEY] = home
    const long =
      'abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    expect(long.length).toBeGreaterThan(60)
    mkdirSync(join(cwd, '.ravenclaw', 'skills', 'found-skill'), { recursive: true })
    writeFileSync(
      join(cwd, '.ravenclaw', 'skills', 'found-skill', 'SKILL.md'),
      ['---', 'name: found-skill', `description: ${long}`, '---', '', 'body'].join('\n'),
    )

    const parts = buildSystemParts({
      cwd,
      permissionMode: 'default',
      projectFilesText: 'project-instructions-body',
      git: GIT,
    })
    const volatile = parts[2]?.text ?? ''
    expect(volatile).toContain('found-skill')
    expect(volatile).toContain(long.slice(0, 60))
    expect(volatile).not.toContain(long.slice(0, 61))
    expect(volatile).toMatch(/Skills:/)
    expect(volatile).not.toContain('Skills: none')
  })

  test('explicit skills including empty skip filesystem discovery', () => {
    const home = tempDir('ravenclaw-builder-home-')
    const cwd = tempDir('ravenclaw-builder-cwd-')
    process.env[ENV_KEY] = home
    mkdirSync(join(cwd, '.ravenclaw', 'skills', 'disk-skill'), { recursive: true })
    writeFileSync(
      join(cwd, '.ravenclaw', 'skills', 'disk-skill', 'SKILL.md'),
      ['---', 'name: disk-skill', 'description: should not appear', '---', '', 'body'].join(
        '\n',
      ),
    )

    const empty = buildSystemParts(
      input({ cwd, projectFilesText: 'project-instructions-body', git: GIT, skills: [] }),
    )
    expect(empty[2]?.text).toContain('Skills: none')
    expect(empty[2]?.text).not.toContain('disk-skill')

    const explicit = buildSystemParts(
      input({
        cwd,
        projectFilesText: 'project-instructions-body',
        git: GIT,
        skills: [{ name: 'passed-skill', description: 'from caller' }],
      }),
    )
    expect(explicit[2]?.text).toContain('passed-skill')
    expect(explicit[2]?.text).toContain('from caller')
    expect(explicit[2]?.text).not.toContain('disk-skill')
  })

  test('omitted skills with no skill dirs still list builtins; empty list is none', () => {
    const home = tempDir('ravenclaw-builder-home-')
    const cwd = tempDir('ravenclaw-builder-cwd-')
    process.env[ENV_KEY] = home
    const base = {
      cwd,
      permissionMode: 'default' as const,
      projectFilesText: 'project-instructions-body',
      git: GIT,
    }
    const omitted = buildSystemParts(base)
    const empty = buildSystemParts({ ...base, skills: [] })
    expect(omitted[2]?.text).toContain('review:')
    expect(empty[2]?.text).toContain('Skills: none')
  })

  test('missing memory files leave the context hash unchanged', () => {
    const home = tempDir('ravenclaw-builder-home-')
    const cwd = tempDir('ravenclaw-builder-cwd-')
    process.env[ENV_KEY] = home
    const parts = buildSystemParts(
      input({ cwd, projectFilesText: 'project-instructions-body', git: GIT }),
    )
    const context = parts[1]?.text ?? ''
    expect(context).not.toContain('User memory:')
    expect(context).not.toContain('Agent memory:')
    expect(context).toBe(
      [
        'Project instructions:',
        'project-instructions-body',
        '',
        'Git snapshot:',
        'branch: main',
        'HEAD: abc123def456',
        'dirty: false',
      ].join('\n'),
    )
    expect(hashSystemParts(parts)).toBe(
      hashSystemParts(
        buildSystemParts(input({ cwd, projectFilesText: 'project-instructions-body', git: GIT })),
      ),
    )
  })

  test('USER.md and MEMORY.md appear in the context tier after project instructions', () => {
    const home = tempDir('ravenclaw-builder-home-')
    const cwd = tempDir('ravenclaw-builder-cwd-')
    process.env[ENV_KEY] = home
    mkdirSync(join(cwd, '.ravenclaw'))
    writeFileSync(join(home, 'USER.md'), 'HOME_USER')
    writeFileSync(join(home, 'MEMORY.md'), 'HOME_AGENT')
    writeFileSync(join(cwd, 'USER.md'), 'CWD_USER')
    writeFileSync(join(cwd, 'MEMORY.md'), 'CWD_AGENT')
    writeFileSync(join(cwd, '.ravenclaw', 'USER.md'), 'DOT_USER')
    writeFileSync(join(cwd, '.ravenclaw', 'MEMORY.md'), 'DOT_AGENT')

    const parts = buildSystemParts(
      input({ cwd, projectFilesText: 'project-instructions-body', git: GIT }),
    )
    const context = parts[1]?.text ?? ''
    expect(parts[1]?.tier).toBe('context')
    expect(context).toContain('User memory:')
    expect(context).toContain('Agent memory:')
    expect(context).toContain('HOME_USER')
    expect(context).toContain('CWD_USER')
    expect(context).toContain('DOT_USER')
    expect(context).toContain('HOME_AGENT')
    expect(context).toContain('CWD_AGENT')
    expect(context).toContain('DOT_AGENT')
    expect(context.indexOf('Project instructions:')).toBeLessThan(context.indexOf('project-instructions-body'))
    expect(context.indexOf('project-instructions-body')).toBeLessThan(context.indexOf('Project files:'))
    expect(context).toContain('USER.md')
    expect(context).toContain('MEMORY.md')
    expect(context.indexOf('Project files:')).toBeLessThan(context.indexOf('User memory:'))
    expect(context.indexOf('User memory:')).toBeLessThan(context.indexOf('HOME_USER'))
    expect(context.indexOf('HOME_USER')).toBeLessThan(context.indexOf('CWD_USER'))
    expect(context.indexOf('CWD_USER')).toBeLessThan(context.indexOf('DOT_USER'))
    expect(context.indexOf('DOT_USER')).toBeLessThan(context.indexOf('Agent memory:'))
    expect(context.indexOf('Agent memory:')).toBeLessThan(context.indexOf('HOME_AGENT'))
    expect(context.indexOf('HOME_AGENT')).toBeLessThan(context.indexOf('CWD_AGENT'))
    expect(context.indexOf('CWD_AGENT')).toBeLessThan(context.indexOf('DOT_AGENT'))
    expect(context.indexOf('DOT_AGENT')).toBeLessThan(context.indexOf('Git snapshot:'))
    expect(context).not.toContain('Claude Code')
    expect(context).not.toContain('Anthropic')
    expect(context).not.toContain('Hermes')
    expect(context).not.toContain('Freebuff')
  })

  test('nonempty file tree is appended after project instructions', () => {
    const cwd = tempDir('ravenclaw-builder-tree-')
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'README.md'), 'x\n')
    writeFileSync(join(cwd, 'src', 'foo.ts'), 'x\n')
    const parts = buildSystemParts(
      input({ cwd, projectFilesText: 'project-instructions-body', git: GIT }),
    )
    const context = parts[1]?.text ?? ''
    expect(context).toContain('Project files:')
    expect(context).toContain('README.md')
    expect(context).toContain('src/foo.ts')
    expect(context.indexOf('Project instructions:')).toBeLessThan(context.indexOf('project-instructions-body'))
    expect(context.indexOf('project-instructions-body')).toBeLessThan(context.indexOf('Project files:'))
    expect(context.indexOf('Project files:')).toBeLessThan(context.indexOf('Git snapshot:'))
    expect(context).toBe(
      [
        'Project instructions:',
        'project-instructions-body',
        '',
        'Project files:',
        'README.md',
        'src/foo.ts',
        '',
        'Git snapshot:',
        'branch: main',
        'HEAD: abc123def456',
        'dirty: false',
      ].join('\n'),
    )
  })

  test('coding posture is appended to the context tier', () => {
    const cwd = tempDir('ravenclaw-builder-posture-')
    writeFileSync(join(cwd, 'bun.lock'), '')
    writeFileSync(
      join(cwd, 'package.json'),
      `${JSON.stringify({ scripts: { test: 'echo', lint: 'echo' } })}\n`,
    )
    const parts = buildSystemParts(
      input({ cwd, projectFilesText: 'project-instructions-body', git: GIT }),
    )
    const context = parts[1]?.text ?? ''
    expect(context).toContain('Coding posture:')
    expect(context).toContain('package manager: bun')
    expect(context).toContain('verify: bun test')
    expect(context).toContain('verify: bun run lint')
    expect(context.indexOf('Git snapshot:')).toBeLessThan(context.indexOf('Coding posture:'))
    expect(parts[0]?.text).not.toContain('Coding posture:')
    expect(parts[2]?.text).not.toContain('Coding posture:')
  })

  test('builder loads user-global memory from RAVENCLAW_HOME', () => {
    const home = tempDir('ravenclaw-builder-home-')
    const cwd = tempDir('ravenclaw-builder-cwd-')
    process.env[ENV_KEY] = home
    writeFileSync(join(home, 'USER.md'), 'ENV_HOME_PREF')
    writeFileSync(join(home, 'MEMORY.md'), 'ENV_HOME_LESSON')
    const parts = buildSystemParts(
      input({ cwd, projectFilesText: 'project-instructions-body', git: GIT }),
    )
    const context = parts[1]?.text ?? ''
    expect(context).toContain('User memory:')
    expect(context).toContain('ENV_HOME_PREF')
    expect(context).toContain('Agent memory:')
    expect(context).toContain('ENV_HOME_LESSON')
  })
})

describe('buildStablePrompt', () => {
  test('identity names RavenClaw and omits vendor brand strings', () => {
    const text = buildStablePrompt()
    expect(text).toContain('RavenClaw')
    expect(text.toLowerCase()).toContain('coding agent')
    expect(text).toMatch(/tool/i)
    expect(text).toContain('default')
    expect(text).toContain('acceptEdits')
    expect(text).toContain('plan')
    expect(text).toContain('dontAsk')
    expect(text).not.toContain('Current permission mode:')
    expect(text).not.toContain('Claude Code')
    expect(text).not.toContain('Anthropic')
    expect(text).not.toContain('Hermes')
    expect(text).not.toContain('Freebuff')
  })

  test('stable tier text matches buildStablePrompt', () => {
    const parts = buildSystemParts(input({ permissionMode: 'acceptEdits' }))
    expect(parts[0]?.text).toBe(buildStablePrompt())
    expect(parts[2]?.text).toContain('Current permission mode: acceptEdits')
  })

  test('buildSystemParts walks project files with instructionFiles claude', () => {
    const cwd = tempDir('ravenclaw-builder-instr-')
    writeFileSync(join(cwd, 'AGENTS.md'), 'AGENTS_ONLY\n')
    writeFileSync(join(cwd, 'CLAUDE.md'), 'CLAUDE_ONLY\n')
    const parts = buildSystemParts({
      cwd,
      permissionMode: 'default',
      instructionFiles: 'claude',
      git: GIT,
    })
    const context = parts.find((part) => part.tier === 'context')?.text ?? ''
    expect(context).toContain('CLAUDE_ONLY')
    expect(context).not.toContain('AGENTS_ONLY')
  })
})
