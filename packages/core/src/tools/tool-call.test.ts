import { describe, expect, test } from 'bun:test'
import { decidePermission } from '../permissions/pipeline'
import type { PermissionRuleSet } from '../permissions/types'
import type { ToolContext, Turn } from '../types'
import { toolCallTool } from './tool-call'

const emptyRules: PermissionRuleSet = {
  session: [],
  project: [],
  user: [],
}

function makeCtx(): ToolContext {
  const turn: Turn = {
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
    cwd: '/tmp',
    model: 'dummy',
    readFiles: new Set(),
  }
  return { turn, signal: turn.abort.signal, onProgress() {} }
}

describe('ToolCall', () => {
  test('is an unsafe leftover-ask bridge that is not read-only', async () => {
    expect(toolCallTool.name).toBe('ToolCall')
    expect(toolCallTool.isConcurrencySafe({ name: 'mcp_ping', arguments: {} })).toBe(false)
    expect(toolCallTool.isReadOnly({ name: 'mcp_ping', arguments: {} })).toBe(false)
    const decision = await toolCallTool.checkPermissions(
      { name: 'mcp_ping', arguments: {} },
      makeCtx(),
    )
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message.length).toBeGreaterThan(0)
      expect(decision.saveAs).toBe('session')
    }
  })

  test('default mode leftover ask stays ask', async () => {
    const decision = await decidePermission({
      name: 'ToolCall',
      input: { name: 'mcp_ping', arguments: {} },
      tool: toolCallTool,
      ctx: makeCtx(),
      mode: 'default',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('ask')
  })

  test('parse requires name and an arguments object', () => {
    expect(toolCallTool.parse({ name: 'mcp_ping', arguments: {} }).ok).toBe(true)
    expect(toolCallTool.parse({ name: 'mcp_ping', arguments: { q: 1 } }).ok).toBe(true)
    expect(toolCallTool.parse({}).ok).toBe(false)
    expect(toolCallTool.parse({ name: 'mcp_ping' }).ok).toBe(false)
    expect(toolCallTool.parse({ name: '', arguments: {} }).ok).toBe(false)
    expect(toolCallTool.parse({ name: 'mcp_ping', arguments: 'x' }).ok).toBe(false)
  })
})
