import { describe, expect, test } from 'bun:test'
import {
  askUserTextToElicitContent,
  mcpElicitToAskUser,
  parseMcpElicitParams,
  runMcpElicit,
} from './elicitation'
import type { McpElicitParams } from './types'

const confirm: McpElicitParams = {
  message: 'Continue?',
  requestedSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean', title: 'OK' } },
    required: ['ok'],
  },
}

describe('parseMcpElicitParams', () => {
  test('accepts form schema and rejects url mode', () => {
    expect(
      parseMcpElicitParams({
        mode: 'form',
        message: 'Continue?',
        requestedSchema: confirm.requestedSchema,
      }),
    ).toEqual(confirm)
    expect(
      parseMcpElicitParams({
        mode: 'url',
        message: 'Open',
        url: 'https://example.com',
        requestedSchema: confirm.requestedSchema,
      }),
    ).toBeUndefined()
    expect(parseMcpElicitParams({ requestedSchema: { type: 'object', properties: {} } })).toBeUndefined()
  })
})

describe('mcpElicitToAskUser', () => {
  test('maps boolean, enum, and free-text fields', () => {
    const input = mcpElicitToAskUser({
      message: 'Fill in',
      requestedSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          color: { type: 'string', enum: ['red', 'blue'], title: 'Color' },
          name: { type: 'string', title: 'Name' },
        },
      },
    })
    expect(input.questions[0]).toMatchObject({
      header: 'Fill in',
      options: [{ label: 'Yes' }, { label: 'No' }],
    })
    expect(input.questions[1]).toMatchObject({
      question: 'Color',
      options: [{ label: 'red' }, { label: 'blue' }],
    })
    expect(input.questions[2]).toMatchObject({ question: 'Name', freeText: true })
  })
})

describe('askUserTextToElicitContent', () => {
  test('converts Q-lines and cancels on required miss', () => {
    expect(askUserTextToElicitContent(confirm, 'Q1: Yes')).toEqual({
      action: 'accept',
      content: { ok: true },
    })
    expect(askUserTextToElicitContent(confirm, 'Q1: No')).toEqual({
      action: 'accept',
      content: { ok: false },
    })
    expect(askUserTextToElicitContent(confirm, '')).toEqual({ action: 'cancel' })
  })
})

describe('runMcpElicit', () => {
  test('cancels without a host, on url mode, and on timeout', async () => {
    expect(await runMcpElicit({ requestedSchema: confirm.requestedSchema }, undefined)).toEqual({
      action: 'cancel',
    })
    expect(
      await runMcpElicit(
        { mode: 'url', url: 'https://example.com', requestedSchema: confirm.requestedSchema },
        async () => ({ action: 'accept', content: { ok: true } }),
      ),
    ).toEqual({ action: 'cancel' })
    const result = await runMcpElicit(
      { requestedSchema: confirm.requestedSchema },
      () => new Promise(() => {}),
      20,
    )
    expect(result).toEqual({ action: 'cancel' })
  })

  test('returns the host accept payload', async () => {
    const result = await runMcpElicit({ requestedSchema: confirm.requestedSchema }, async () => ({
      action: 'accept',
      content: { ok: true },
    }))
    expect(result).toEqual({ action: 'accept', content: { ok: true } })
  })
})
