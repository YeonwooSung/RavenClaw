import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeToolPool } from '../mcp/tools'
import type { Tool, ToolContext, Turn } from '../types'
import {
  discoverSkills,
  filterToolsForTurn,
  parseSkillFrontmatter,
  skillTool,
} from './skill'

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

function writeSkill(
  root: string,
  name: string,
  markdown: string,
  extra?: { files?: Record<string, string | Buffer> },
): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), markdown)
  if (extra?.files) {
    for (const [rel, content] of Object.entries(extra.files)) {
      const path = join(dir, rel)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, content)
    }
  }
  return dir
}

function makeTurn(cwd: string): Turn {
  return {
    id: 'turn_1',
    sessionId: 'sess_1',
    messages: [],
    round: 1,
    maxRounds: 80,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd,
    model: 'dummy',
    readFiles: new Set(),
  }
}

function makeCtx(cwd: string, signal?: AbortSignal): ToolContext {
  const turn = makeTurn(cwd)
  return {
    turn,
    signal: signal ?? turn.abort.signal,
    onProgress() {},
  }
}

describe('parseSkillFrontmatter', () => {
  test('parses name, description, version, and allowed-tools and omits missing keys', () => {
    const full = parseSkillFrontmatter(
      [
        '---',
        'name: demo',
        'description: A short demo skill',
        'version: 1.2.0',
        'allowed-tools: Read, Grep',
        '---',
        '',
        'Body text',
      ].join('\n'),
    )
    expect(full).toEqual({
      name: 'demo',
      description: 'A short demo skill',
      version: '1.2.0',
      allowedTools: ['Read', 'Grep'],
    })

    const empty = parseSkillFrontmatter('# just a body\n')
    expect(empty).toEqual({})
    expect('name' in empty).toBe(false)
    expect('description' in empty).toBe(false)
    expect('version' in empty).toBe(false)
    expect('allowedTools' in empty).toBe(false)
  })

  test('empty allowed-tools is omitted so it cannot deny every tool', () => {
    const bracket = parseSkillFrontmatter(
      ['---', 'name: empty', 'allowed-tools: []', '---', '', 'body'].join('\n'),
    )
    expect('allowedTools' in bracket).toBe(false)

    const bare = parseSkillFrontmatter(
      ['---', 'name: empty', 'allowed-tools:', '---', '', 'body'].join('\n'),
    )
    expect('allowedTools' in bare).toBe(false)
  })
})

describe('discoverSkills', () => {
  test('finds user and project skills and lets the project override the same name', () => {
    const home = tempDir('ravenclaw-skill-home-')
    const cwd = tempDir('ravenclaw-skill-cwd-')
    process.env[ENV_KEY] = home

    writeSkill(
      join(home, 'skills'),
      'user-only',
      ['---', 'name: user-only', 'description: From the user dir', '---', '', 'user body'].join(
        '\n',
      ),
    )
    writeSkill(
      join(home, 'skills'),
      'shared',
      ['---', 'name: shared', 'description: User copy of shared', '---', '', 'user shared'].join(
        '\n',
      ),
    )
    writeSkill(
      join(cwd, '.ravenclaw', 'skills'),
      'project-only',
      [
        '---',
        'name: project-only',
        'description: From the project dir',
        '---',
        '',
        'project body',
      ].join('\n'),
    )
    const projectShared = writeSkill(
      join(cwd, '.ravenclaw', 'skills'),
      'shared',
      [
        '---',
        'name: shared',
        'description: Project copy of shared',
        '---',
        '',
        'project shared',
      ].join('\n'),
    )

    const found = discoverSkills(cwd, home, { includeBuiltin: false })
    const byName = new Map(found.map((skill) => [skill.name, skill]))

    expect(byName.get('user-only')).toMatchObject({
      name: 'user-only',
      description: 'From the user dir',
      dir: join(home, 'skills', 'user-only'),
      source: 'user',
    })
    expect(byName.get('project-only')).toMatchObject({
      name: 'project-only',
      description: 'From the project dir',
      dir: join(cwd, '.ravenclaw', 'skills', 'project-only'),
      source: 'project',
    })
    expect(byName.get('shared')).toMatchObject({
      name: 'shared',
      description: 'Project copy of shared',
      dir: projectShared,
      source: 'project',
    })
    expect(found).toHaveLength(3)
  })
})

describe('Skill', () => {
  test('is a concurrency-safe read-only tool that allows by mode', async () => {
    expect(skillTool.name).toBe('Skill')
    expect(skillTool.isConcurrencySafe({ name: 'demo' })).toBe(true)
    expect(skillTool.isReadOnly({ name: 'demo' })).toBe(true)
    const decision = await skillTool.checkPermissions({ name: 'demo' }, makeCtx('/tmp'))
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('level 1 returns the body and sets a turn-scoped allowed-tools list', async () => {
    const home = tempDir('ravenclaw-skill-home-')
    const cwd = tempDir('ravenclaw-skill-cwd-')
    process.env[ENV_KEY] = home
    writeSkill(
      join(cwd, '.ravenclaw', 'skills'),
      'demo',
      [
        '---',
        'name: demo',
        'description: Demo skill',
        'allowed-tools: Read, Grep',
        '---',
        '',
        'Use this when reviewing code.',
      ].join('\n'),
    )

    const ctx = makeCtx(cwd)
    const out = await skillTool.execute({ name: 'demo' }, ctx)
    expect(out.startsWith('This skill suggests: Read, Grep.')).toBe(true)
    expect(out).toContain('Use this when reviewing code.')
    expect(out).not.toMatch(/^---/m)
    expect(ctx.turn.skillAllowedTools).toEqual(['Read', 'Grep'])

    expect(skillTool).not.toHaveProperty('allowedTools')
    expect(skillTool).not.toHaveProperty('restrictTools')
    expect(skillTool).not.toHaveProperty('applyAllowedTools')
    expect(skillTool).not.toHaveProperty('setTools')
  })

  test('level 1 caps the body at 20000 characters with a truncation note', async () => {
    const home = tempDir('ravenclaw-skill-home-')
    const cwd = tempDir('ravenclaw-skill-cwd-')
    process.env[ENV_KEY] = home
    const body = 'x'.repeat(25_000)
    writeSkill(
      join(cwd, '.ravenclaw', 'skills'),
      'huge',
      ['---', 'name: huge', 'description: Big body', '---', '', body].join('\n'),
    )

    const out = await skillTool.execute({ name: 'huge' }, makeCtx(cwd))
    expect(out.length).toBeGreaterThan(20_000)
    expect(out).toContain('x'.repeat(20_000))
    expect(out).not.toContain('x'.repeat(20_001))
    expect(out).toMatch(/truncat/i)
    expect(out).toMatch(/20000/)
  })

  test('level 2 reads a reference file under the skill directory', async () => {
    const home = tempDir('ravenclaw-skill-home-')
    const cwd = tempDir('ravenclaw-skill-cwd-')
    process.env[ENV_KEY] = home
    writeSkill(
      join(cwd, '.ravenclaw', 'skills'),
      'demo',
      ['---', 'name: demo', 'description: Demo skill', '---', '', 'index body'].join('\n'),
      { files: { 'references/foo.md': '# Foo reference\nDetails here.\n' } },
    )

    const out = await skillTool.execute({ name: 'demo', path: 'references/foo.md' }, makeCtx(cwd))
    expect(out).toContain('# Foo reference')
    expect(out).toContain('Details here.')
    expect(out).not.toContain('index body')
  })

  test('level 2 rejects ../escape and a symlink that leaves the skill dir', async () => {
    const home = tempDir('ravenclaw-skill-home-')
    const cwd = tempDir('ravenclaw-skill-cwd-')
    process.env[ENV_KEY] = home
    const secret = join(cwd, 'secret.txt')
    writeFileSync(secret, 'SECRET_OUTSIDE_CONTENTS\n')
    const skillDir = writeSkill(
      join(cwd, '.ravenclaw', 'skills'),
      'demo',
      ['---', 'name: demo', 'description: Demo skill', '---', '', 'index body'].join('\n'),
    )
    symlinkSync(secret, join(skillDir, 'leak.md'))

    const escaped = await skillTool.execute({ name: 'demo', path: '../escape' }, makeCtx(cwd))
    expect(typeof escaped).toBe('string')
    expect(escaped.toLowerCase()).toMatch(/escape|path/)
    expect(escaped).not.toContain('SECRET_OUTSIDE_CONTENTS')

    const linked = await skillTool.execute({ name: 'demo', path: 'leak.md' }, makeCtx(cwd))
    expect(typeof linked).toBe('string')
    expect(linked.toLowerCase()).toMatch(/escape|path/)
    expect(linked).not.toContain('SECRET_OUTSIDE_CONTENTS')
  })

  test('level 2 returns a short error for a binary reference', async () => {
    const home = tempDir('ravenclaw-skill-home-')
    const cwd = tempDir('ravenclaw-skill-cwd-')
    process.env[ENV_KEY] = home
    writeSkill(
      join(cwd, '.ravenclaw', 'skills'),
      'demo',
      ['---', 'name: demo', 'description: Demo skill', '---', '', 'index body'].join('\n'),
      { files: { 'references/blob.bin': Buffer.from([0x00, 0x01, 0x02, 0xff]) } },
    )

    const out = await skillTool.execute(
      { name: 'demo', path: 'references/blob.bin' },
      makeCtx(cwd),
    )
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).toContain('binary')
    expect(out.length).toBeLessThan(200)
    expect(out).not.toContain('index body')
  })

  test('level 1 without allowed-tools leaves the turn pool unset', async () => {
    const home = tempDir('ravenclaw-skill-home-')
    const cwd = tempDir('ravenclaw-skill-cwd-')
    process.env[ENV_KEY] = home
    writeSkill(
      join(cwd, '.ravenclaw', 'skills'),
      'plain',
      ['---', 'name: plain', 'description: No tools', '---', '', 'plain body'].join('\n'),
    )
    const ctx = makeCtx(cwd)
    await skillTool.execute({ name: 'plain' }, ctx)
    expect(ctx.turn.skillAllowedTools).toBeUndefined()
  })

  test('empty allowed-tools does not mutate the turn pool', async () => {
    const home = tempDir('ravenclaw-skill-home-')
    const cwd = tempDir('ravenclaw-skill-cwd-')
    process.env[ENV_KEY] = home
    writeSkill(
      join(cwd, '.ravenclaw', 'skills'),
      'empty',
      ['---', 'name: empty', 'description: Empty list', 'allowed-tools: []', '---', '', 'empty body'].join(
        '\n',
      ),
    )
    writeSkill(
      join(cwd, '.ravenclaw', 'skills'),
      'narrow',
      [
        '---',
        'name: narrow',
        'description: Narrow list',
        'allowed-tools: Read, Grep',
        '---',
        '',
        'narrow body',
      ].join('\n'),
    )

    const unset = makeCtx(cwd)
    const emptyOut = await skillTool.execute({ name: 'empty' }, unset)
    expect(emptyOut).toContain('empty body')
    expect(emptyOut).not.toMatch(/This skill suggests/)
    expect(unset.turn.skillAllowedTools).toBeUndefined()

    const already = makeCtx(cwd)
    await skillTool.execute({ name: 'narrow' }, already)
    expect(already.turn.skillAllowedTools).toEqual(['Read', 'Grep'])
    await skillTool.execute({ name: 'empty' }, already)
    expect(already.turn.skillAllowedTools).toEqual(['Read', 'Grep'])
  })

  test('a second skill intersects allowed-tools and cannot widen', async () => {
    const home = tempDir('ravenclaw-skill-home-')
    const cwd = tempDir('ravenclaw-skill-cwd-')
    process.env[ENV_KEY] = home
    writeSkill(
      join(cwd, '.ravenclaw', 'skills'),
      'first',
      [
        '---',
        'name: first',
        'description: First skill',
        'allowed-tools: Read, Grep, Edit',
        '---',
        '',
        'first body',
      ].join('\n'),
    )
    writeSkill(
      join(cwd, '.ravenclaw', 'skills'),
      'second',
      [
        '---',
        'name: second',
        'description: Second skill',
        'allowed-tools: Grep, Write, Skill, Agent',
        '---',
        '',
        'second body',
      ].join('\n'),
    )

    const ctx = makeCtx(cwd)
    await skillTool.execute({ name: 'first' }, ctx)
    expect(ctx.turn.skillAllowedTools).toEqual(['Read', 'Grep', 'Edit'])
    await skillTool.execute({ name: 'second' }, ctx)
    expect(ctx.turn.skillAllowedTools).toEqual(['Grep'])
    expect(ctx.turn.skillAllowedTools).not.toContain('Write')
    expect(ctx.turn.skillAllowedTools).not.toContain('Skill')
    expect(ctx.turn.skillAllowedTools).not.toContain('Agent')
  })

  test('unknown skill name returns an error string', async () => {
    const home = tempDir('ravenclaw-skill-home-')
    const cwd = tempDir('ravenclaw-skill-cwd-')
    process.env[ENV_KEY] = home

    const out = await skillTool.execute({ name: 'missing' }, makeCtx(cwd))
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).toContain('unknown')
    expect(out).toContain('missing')
  })
})

function namedTool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: {},
    parse(input: unknown) {
      return { ok: true as const, value: input }
    },
    isConcurrencySafe() {
      return true
    },
    isReadOnly() {
      return true
    },
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute() {
      return name
    },
  }
}

describe('filterToolsForTurn', () => {
  const pool = [
    namedTool('Read'),
    namedTool('Grep'),
    namedTool('Edit'),
    namedTool('Write'),
    namedTool('Bash'),
    namedTool('Skill'),
    namedTool('Agent'),
    namedTool('EnterPlanMode'),
    namedTool('ExitPlanMode'),
  ]

  test('returns the same tools when the turn has no skill allow list', () => {
    const turn = makeTurn('/tmp')
    expect(filterToolsForTurn(pool, turn)).toBe(pool)
  })

  test('keeps listed builtins plus Skill, plan tools, Agent, and ToolCall/ToolSearch', () => {
    const turn = makeTurn('/tmp')
    turn.skillAllowedTools = ['Read', 'Grep']
    expect(filterToolsForTurn(pool, turn).map((tool) => tool.name)).toEqual([
      'Read',
      'Grep',
      'Skill',
      'Agent',
      'EnterPlanMode',
      'ExitPlanMode',
    ])
    const withBridge = [...pool, namedTool('ToolCall'), namedTool('ToolSearch')]
    expect(filterToolsForTurn(withBridge, turn).map((tool) => tool.name)).toEqual([
      'Read',
      'Grep',
      'Skill',
      'Agent',
      'EnterPlanMode',
      'ExitPlanMode',
      'ToolCall',
      'ToolSearch',
    ])
  })

  test('does not mutate the input tool array', () => {
    const turn = makeTurn('/tmp')
    turn.skillAllowedTools = ['Read']
    const before = pool.map((tool) => tool.name)
    filterToolsForTurn(pool, turn)
    expect(pool.map((tool) => tool.name)).toEqual(before)
  })

  test('drops tools whose isEnabled is false', () => {
    const gated = namedTool('Gated')
    gated.isEnabled = () => false
    const on = namedTool('On')
    on.isEnabled = () => true
    const turn = makeTurn('/tmp')
    expect(filterToolsForTurn([gated, on, namedTool('Plain')], turn).map((tool) => tool.name)).toEqual([
      'On',
      'Plain',
    ])
  })

  test('skill allow list cannot restore a tool whose isEnabled is false', () => {
    const gated = namedTool('Read')
    gated.isEnabled = () => false
    const turn = makeTurn('/tmp')
    turn.skillAllowedTools = ['Read']
    expect(
      filterToolsForTurn([gated, namedTool('Skill'), namedTool('Write')], turn).map((tool) => tool.name),
    ).toEqual(['Skill'])
  })

  test('keeps remaining builtins as a contiguous sorted prefix ahead of surviving MCP tools', () => {
    const builtins = [
      namedTool('Write'),
      namedTool('Read'),
      namedTool('Grep'),
      namedTool('Bash'),
      namedTool('Skill'),
      namedTool('Agent'),
      namedTool('EnterPlanMode'),
      namedTool('ExitPlanMode'),
      namedTool('Edit'),
      namedTool('Glob'),
    ]
    const mcp = [namedTool('zeta'), namedTool('alpha'), namedTool('mcp_read')]
    const merged = mergeToolPool(builtins, mcp)
    expect(merged.map((tool) => tool.name)).toEqual([
      'Agent',
      'Bash',
      'Edit',
      'EnterPlanMode',
      'ExitPlanMode',
      'Glob',
      'Grep',
      'Read',
      'Skill',
      'Write',
      'alpha',
      'mcp_read',
      'zeta',
    ])

    const turn = makeTurn('/tmp')
    turn.skillAllowedTools = ['Read', 'Grep', 'zeta', 'alpha']
    const names = filterToolsForTurn(merged, turn).map((tool) => tool.name)
    const builtinNames = new Set(builtins.map((tool) => tool.name))
    const prefix = names.filter((name) => builtinNames.has(name))
    const suffix = names.filter((name) => !builtinNames.has(name))

    expect(names.slice(0, prefix.length)).toEqual(prefix)
    expect(prefix).toEqual([...prefix].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    expect(suffix).toEqual([...suffix].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    expect(names).toEqual([
      'Agent',
      'EnterPlanMode',
      'ExitPlanMode',
      'Grep',
      'Read',
      'Skill',
      'alpha',
      'zeta',
    ])
    expect(names).not.toContain('Edit')
    expect(names).not.toContain('Write')
    expect(names).not.toContain('Bash')
    expect(names).not.toContain('mcp_read')
  })
})
