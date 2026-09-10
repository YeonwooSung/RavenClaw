import { describe, expect, test } from 'bun:test'
import {
  ACP_METHODS,
  AGENT_INFO,
  JSON_RPC_METHOD_NOT_FOUND,
  PROTOCOL_VERSION,
  extractPromptText,
  isRoundEnd,
  jsonRpcError,
  jsonRpcResult,
  parseIncoming,
  roundEndToStopReason,
  toSessionUpdate,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcRequest,
  type SessionCancelParams,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type SessionUpdate,
  type SessionUpdateParams,
} from './protocol'

describe('ACP request/response types', () => {
  test('initialize request and result advertise protocol v1', () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 0,
      method: ACP_METHODS.initialize,
      params: {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'zed', version: '1.0.0' },
      } satisfies InitializeParams,
    }
    const result: InitializeResult = {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      agentInfo: AGENT_INFO,
      authMethods: [],
    }
    expect(request.method).toBe('initialize')
    expect(result.protocolVersion).toBe(1)
    expect(result.agentInfo.name).toBe('ravenclaw')
  })

  test('session/new, session/prompt, and session/cancel envelopes', () => {
    const created: SessionNewResult = { sessionId: 'sess_1' }
    const newParams: SessionNewParams = { cwd: '/tmp/project', mcpServers: [] }
    const prompt: SessionPromptParams = {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'list files' }],
    }
    const promptResult: SessionPromptResult = { stopReason: 'end_turn' }
    const cancel: SessionCancelParams = { sessionId: created.sessionId }
    expect(newParams.cwd).toBe('/tmp/project')
    expect(prompt.prompt).toEqual([{ type: 'text', text: 'list files' }])
    expect(promptResult.stopReason).toBe('end_turn')
    expect(cancel.sessionId).toBe('sess_1')
  })

  test('session/update notifications cover text, tool call, tool result, and done', () => {
    const content: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hello' },
    }
    const toolCall: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'Bash',
      status: 'pending',
      rawInput: { command: 'ls' },
    }
    const toolResult: SessionUpdate = {
      sessionUpdate: 'tool_result',
      toolCallId: 'call_1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
    }
    const done: SessionUpdate = { sessionUpdate: 'done', stopReason: 'end_turn' }
    const params: SessionUpdateParams = { sessionId: 'sess_1', update: content }
    expect(params.update).toEqual(content)
    expect(toolCall.sessionUpdate).toBe('tool_call')
    expect(toolResult.sessionUpdate).toBe('tool_result')
    expect(done.stopReason).toBe('end_turn')
  })
})

describe('extractPromptText', () => {
  test('joins text content blocks and accepts a bare string', () => {
    expect(extractPromptText([{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }])).toBe(
      'Hello',
    )
    expect(extractPromptText('plain')).toBe('plain')
    expect(extractPromptText([{ type: 'image', mimeType: 'image/png' }])).toBe('')
    expect(extractPromptText(undefined)).toBe('')
  })
})

describe('RoundEnd mapping', () => {
  test('recognizes RoundEnd reasons and maps them to ACP stopReason', () => {
    expect(isRoundEnd({ reason: 'completed' })).toBe(true)
    expect(isRoundEnd({ reason: 'nope' })).toBe(false)
    expect(roundEndToStopReason({ reason: 'completed' })).toBe('end_turn')
    expect(roundEndToStopReason({ reason: 'aborted' })).toBe('cancelled')
    expect(roundEndToStopReason({ reason: 'max_rounds', round: 8 })).toBe('max_turn_requests')
    expect(roundEndToStopReason({ reason: 'context_full' })).toBe('max_tokens')
    expect(roundEndToStopReason({ reason: 'model_error', error: 'boom' })).toBe('refusal')
    expect(roundEndToStopReason({ reason: 'persist_failed', error: 'io' })).toBe('refusal')
    expect(roundEndToStopReason(undefined)).toBe('end_turn')
  })
})

describe('toSessionUpdate', () => {
  test('maps text_delta to session/update content', () => {
    expect(toSessionUpdate({ type: 'text_delta', text: 'Hi' })).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hi' },
    })
  })

  test('maps tool_call and tool_result stream events', () => {
    expect(toSessionUpdate({ type: 'tool_call', id: 'c1', name: 'Read', input: { path: 'a.ts' } })).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'Read',
      kind: 'other',
      status: 'pending',
      rawInput: { path: 'a.ts' },
    })
    expect(
      toSessionUpdate({
        type: 'tool_result',
        id: 'c1',
        result: { toolUseId: 'c1', ok: true, content: 'src/' },
      }),
    ).toEqual({
      sessionUpdate: 'tool_result',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'src/' } }],
    })
  })

  test('ignores unrelated stream events', () => {
    expect(toSessionUpdate({ type: 'round_start', round: 1 })).toBeUndefined()
    expect(toSessionUpdate({ type: 'round_end', end: { reason: 'completed' } })).toBeUndefined()
  })
})

describe('JSON-RPC helpers', () => {
  test('builds result and method-not-found error envelopes', () => {
    expect(jsonRpcResult(1, { ok: true })).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    expect(jsonRpcError(2, JSON_RPC_METHOD_NOT_FOUND, 'Method not found')).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32601, message: 'Method not found' },
    })
  })

  test('parseIncoming accepts objects and JSON strings', () => {
    const parsed = parseIncoming(
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: 1 } }),
    )
    expect(parsed).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: { protocolVersion: 1 },
    })
    expect(parseIncoming({ method: 'session/cancel', params: { sessionId: 's' } })).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 's' },
    })
    expect(parseIncoming('not-json')).toBeUndefined()
    expect(parseIncoming({})).toBeUndefined()
  })
})
