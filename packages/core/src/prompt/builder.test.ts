import { describe, expect, test } from 'bun:test'
import type { PermissionMode } from '../types'
import { hashSystemParts } from './cache'
import { buildStablePrompt, buildSystemParts, type PromptBuildInput } from './builder'

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
    const base = hashSystemParts(buildSystemParts(input()))
    const cwdHash = hashSystemParts(buildSystemParts(input({ cwd: '/workspace/other' })))
    const modeHash = hashSystemParts(
      buildSystemParts(input({ permissionMode: 'plan' })),
    )
    expect(cwdHash).not.toBe(base)
    expect(modeHash).not.toBe(base)
    expect(cwdHash).not.toBe(modeHash)
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

  test('empty skills still emit a stable skills section', () => {
    const a = buildSystemParts(input({ skills: [] }))
    const b = buildSystemParts(input({ skills: [] }))
    expect(a[2]?.text).toBe(b[2]?.text)
    expect(a[2]?.text).toMatch(/skills/i)
  })
})

describe('buildStablePrompt', () => {
  test('identity names RavenClaw and omits vendor brand strings', () => {
    const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'dontAsk']
    for (const mode of modes) {
      const text = buildStablePrompt(mode)
      expect(text).toContain('RavenClaw')
      expect(text.toLowerCase()).toContain('coding agent')
      expect(text).toMatch(/tool/i)
      expect(text).toContain('default')
      expect(text).toContain('acceptEdits')
      expect(text).toContain('plan')
      expect(text).toContain('dontAsk')
      expect(text).toContain(mode)
      expect(text).not.toContain('Claude Code')
      expect(text).not.toContain('Anthropic')
      expect(text).not.toContain('Hermes')
      expect(text).not.toContain('Freebuff')
    }
  })

  test('stable tier text matches buildStablePrompt', () => {
    const parts = buildSystemParts(input({ permissionMode: 'acceptEdits' }))
    expect(parts[0]?.text).toBe(buildStablePrompt('acceptEdits'))
  })
})
