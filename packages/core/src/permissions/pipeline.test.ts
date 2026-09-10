import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  Tool,
  ToolContext,
  Turn,
} from '../types'
import { decidePermission } from './pipeline'

function makeTurn(over: Partial<Turn> = {}): Turn {
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
    cwd: '/tmp/proj',
    model: 'dummy',
    readFiles: new Set(),
    ...over,
  }
}

function makeCtx(over: Partial<Turn> = {}): ToolContext {
  const turn = makeTurn(over)
  return { turn, signal: turn.abort.signal, onProgress() {} }
}

function mockTool(opts: {
  name?: string
  readOnly?: boolean
  check?: PermissionDecision | ((input: unknown) => PermissionDecision)
}): Tool {
  return {
    name: opts.name ?? 'Echo',
    description: 'mock',
    inputSchema: { type: 'object' },
    parse(input: unknown) {
      return { ok: true as const, value: input }
    },
    isConcurrencySafe() {
      return opts.readOnly ?? true
    },
    isReadOnly() {
      return opts.readOnly ?? true
    },
    async checkPermissions(input: unknown) {
      if (typeof opts.check === 'function') return opts.check(input)
      return opts.check ?? { behavior: 'allow', reason: 'mode' }
    },
    async execute() {
      return 'ok'
    },
  }
}

const emptyRules = { session: [] as PermissionRule[], user: [] as PermissionRule[], project: [] as PermissionRule[] }

function rule(
  over: Partial<PermissionRule> & Pick<PermissionRule, 'tool' | 'behavior'>,
): PermissionRule {
  return {
    id: over.id ?? crypto.randomUUID(),
    sessionId: over.sessionId ?? 'sess_1',
    tool: over.tool,
    spec: over.spec ?? {},
    behavior: over.behavior,
  }
}

async function decide(opts: {
  tool?: Tool
  name?: string
  input?: unknown
  mode?: PermissionMode
  cwd?: string
  rules?: typeof emptyRules
}): Promise<PermissionDecision> {
  const tool = opts.tool ?? mockTool({ name: opts.name })
  const name = opts.name ?? tool.name
  return decidePermission({
    tool,
    name,
    input: opts.input ?? {},
    ctx: makeCtx({
      cwd: opts.cwd ?? '/tmp/proj',
      permissionMode: opts.mode ?? 'default',
    }),
    mode: opts.mode ?? 'default',
    rules: opts.rules ?? emptyRules,
  })
}

describe('decidePermission', () => {
  test('acceptEdits does not promote a checkPermissions deny (path escape)', async () => {
    const tool = mockTool({
      name: 'Edit',
      readOnly: false,
      check: { behavior: 'deny', reason: 'safety', message: 'path escape' },
    })
    const decision = await decide({
      tool,
      name: 'Edit',
      input: { path: '../secret.txt', old_string: 'a', new_string: 'b' },
      mode: 'acceptEdits',
    })
    expect(decision).toEqual({ behavior: 'deny', reason: 'safety', message: 'path escape' })
  })

  test('dontAsk + checkPermissions allow stays allow', async () => {
    const tool = mockTool({
      name: 'Echo',
      check: { behavior: 'allow', reason: 'mode' },
    })
    const decision = await decide({ tool, name: 'Echo', mode: 'dontAsk' })
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('dontAsk rewrites leftover ask to deny', async () => {
    const tool = mockTool({
      name: 'Bash',
      readOnly: false,
      check: { behavior: 'ask', message: 'dangerous' },
    })
    const decision = await decide({
      tool,
      name: 'Bash',
      input: { command: 'rm -rf /' },
      mode: 'dontAsk',
    })
    expect(decision.behavior).toBe('deny')
    if (decision.behavior === 'deny') expect(decision.reason).toBe('mode')
  })

  test('ExitPlanMode stays allow in dontAsk and plan', async () => {
    const tool = mockTool({
      name: 'ExitPlanMode',
      readOnly: true,
      check: { behavior: 'allow', reason: 'mode' },
    })
    expect((await decide({ tool, name: 'ExitPlanMode', mode: 'dontAsk' })).behavior).toBe('allow')
    expect((await decide({ tool, name: 'ExitPlanMode', mode: 'plan' })).behavior).toBe('allow')
  })

  test('plan denies mutating Edit even when checkPermissions allows', async () => {
    const tool = mockTool({
      name: 'Edit',
      readOnly: false,
      check: { behavior: 'allow', reason: 'mode' },
    })
    const decision = await decide({
      tool,
      name: 'Edit',
      input: { path: 'a.txt', old_string: 'a', new_string: 'b' },
      mode: 'plan',
    })
    expect(decision.behavior).toBe('deny')
    if (decision.behavior === 'deny') expect(decision.reason).toBe('mode')
  })

  test('plan allows read-only tools', async () => {
    const tool = mockTool({
      name: 'Read',
      readOnly: true,
      check: { behavior: 'allow', reason: 'mode' },
    })
    const decision = await decide({
      tool,
      name: 'Read',
      input: { path: 'a.txt' },
      mode: 'plan',
    })
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('session deny beats later allow and is not promoted', async () => {
    const tool = mockTool({
      name: 'Write',
      readOnly: false,
      check: { behavior: 'allow', reason: 'mode' },
    })
    const decision = await decide({
      tool,
      name: 'Write',
      input: { path: 'a.txt', content: 'x' },
      mode: 'acceptEdits',
      rules: {
        session: [rule({ tool: 'Write', behavior: 'deny' })],
        user: [rule({ tool: 'Write', behavior: 'allow' })],
        project: [rule({ tool: '*', behavior: 'allow' })],
      },
    })
    expect(decision.behavior).toBe('deny')
    if (decision.behavior === 'deny') expect(decision.reason).toBe('rule')
  })

  test('allow rules promote leftover ask with session > user > project', async () => {
    const tool = mockTool({
      name: 'Bash',
      readOnly: false,
      check: { behavior: 'ask', message: 'confirm' },
    })
    const decision = await decide({
      tool,
      name: 'Bash',
      input: { command: 'ls' },
      mode: 'default',
      rules: {
        session: [],
        user: [],
        project: [rule({ tool: 'Bash', spec: 'ls', behavior: 'allow' })],
      },
    })
    expect(decision).toEqual({ behavior: 'allow', reason: 'rule' })
  })

  test('acceptEdits promotes leftover ask for in-tree Edit/Write only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ravenclaw-perm-tree-'))
    mkdirSync(join(root, 'src'))
    const edit = mockTool({
      name: 'Edit',
      readOnly: false,
      check: { behavior: 'ask', message: 'edit?' },
    })
    const inTree = await decide({
      tool: edit,
      name: 'Edit',
      input: { path: 'src/a.ts', old_string: 'a', new_string: 'b' },
      mode: 'acceptEdits',
      cwd: root,
    })
    expect(inTree).toEqual({ behavior: 'allow', reason: 'mode' })

    const outOfTree = await decide({
      tool: edit,
      name: 'Edit',
      input: { path: '../outside.txt', old_string: 'a', new_string: 'b' },
      mode: 'acceptEdits',
      cwd: root,
    })
    expect(outOfTree.behavior).toBe('ask')

    const bash = mockTool({
      name: 'Bash',
      readOnly: false,
      check: { behavior: 'ask', message: 'bash?' },
    })
    const bashAsk = await decide({
      tool: bash,
      name: 'Bash',
      input: { command: 'echo hi' },
      mode: 'acceptEdits',
      cwd: root,
    })
    expect(bashAsk.behavior).toBe('ask')
  })

  test('acceptEdits does not treat a symlink escape as in-tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ravenclaw-perm-link-'))
    const outside = mkdtempSync(join(tmpdir(), 'ravenclaw-perm-out-'))
    symlinkSync(outside, join(root, 'escape'))
    const write = mockTool({
      name: 'Write',
      readOnly: false,
      check: { behavior: 'ask', message: 'write?' },
    })
    const decision = await decide({
      tool: write,
      name: 'Write',
      input: { path: 'escape/secret.txt', content: 'x' },
      mode: 'acceptEdits',
      cwd: root,
    })
    expect(decision.behavior).toBe('ask')
  })

  test('safetyCheck can deny after checkPermissions allows', async () => {
    const tool = mockTool({
      name: 'Write',
      readOnly: false,
      check: { behavior: 'allow', reason: 'mode' },
    })
    const decision = await decide({
      tool,
      name: 'Write',
      input: { path: '.git/config', content: 'x' },
      mode: 'acceptEdits',
    })
    expect(decision.behavior).toBe('deny')
    if (decision.behavior === 'deny') expect(decision.reason).toBe('safety')
  })

  test('default leftover ask stays ask', async () => {
    const tool = mockTool({
      name: 'Bash',
      readOnly: false,
      check: { behavior: 'ask', message: 'run this?' },
    })
    const decision = await decide({
      tool,
      name: 'Bash',
      input: { command: 'echo hi' },
      mode: 'default',
    })
    expect(decision).toEqual({ behavior: 'ask', message: 'run this?' })
  })
})
