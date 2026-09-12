import { describe, expect, test } from 'bun:test'
import {
  ACP_METHODS,
  PROTOCOL_VERSION,
  createAcpServer,
  extractPromptText,
  isJsonRpcRequest,
  jsonRpcResult,
} from './index'

describe('acp public surface', () => {
  test('re-exports protocol constants and helpers', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(ACP_METHODS.initialize).toBe('initialize')
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' })).toBe(true)
    expect(jsonRpcResult(1, { ok: true })).toMatchObject({ id: 1, result: { ok: true } })
    expect(extractPromptText([{ type: 'text', text: 'hi' }])).toBe('hi')
    expect(typeof createAcpServer).toBe('function')
  })
})
