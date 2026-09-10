import { describe, expect, test } from 'bun:test'
import {
  PersistError,
  type Funding,
  type Message,
  type PermissionMode,
  type PersistErrorCode,
  type Provider,
  type SessionEngineOptions,
  type SessionStore,
} from '@ravenclaw/core'

const PERSIST_ERROR_CODES: PersistErrorCode[] = [
  'busy',
  'locked',
  'corrupt',
  'readonly',
  'unknown',
]

describe('PersistError', () => {
  test('constructs with each PersistErrorCode and exposes code + message', () => {
    for (const code of PERSIST_ERROR_CODES) {
      const message = `persist failed: ${code}`
      const err = new PersistError(code, message)
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(PersistError)
      expect(err.name).toBe('PersistError')
      expect(err.code).toBe(code)
      expect(err.message).toBe(message)
    }
  })
})

describe('Message', () => {
  test('constructs user, assistant (with tool_use), and tool variants', () => {
    const user: Message = {
      id: 'msg_user_1',
      role: 'user',
      blocks: [{ type: 'text', text: 'list the files' }],
      createdAt: 1,
    }
    expect(user.role).toBe('user')
    expect(user.blocks).toEqual([{ type: 'text', text: 'list the files' }])
    expect(user.id).toBe('msg_user_1')
    expect(user.createdAt).toBe(1)

    const assistant: Message = {
      id: 'msg_asst_1',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'I will list files' },
        { type: 'thinking', text: 'need Glob' },
        { type: 'tool_use', id: 'call_1', name: 'Glob', input: { pattern: '*' } },
      ],
      createdAt: 2,
      usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
    }
    expect(assistant.role).toBe('assistant')
    expect(assistant.blocks[2]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'Glob',
      input: { pattern: '*' },
    })
    expect(assistant.usage).toEqual({
      input: 10,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
    })

    const tool: Message = {
      id: 'msg_tool_1',
      role: 'tool',
      toolUseId: 'call_1',
      ok: true,
      blocks: [{ type: 'text', text: 'README.md' }],
      persistPath: undefined,
      createdAt: 3,
    }
    expect(tool.role).toBe('tool')
    expect(tool.toolUseId).toBe('call_1')
    expect(tool.ok).toBe(true)
    expect(tool.blocks).toEqual([{ type: 'text', text: 'README.md' }])
    expect(tool.createdAt).toBe(3)
  })
})

describe('Funding and PermissionMode', () => {
  test("Funding values are 'byok' | 'included'", () => {
    const values = ['byok', 'included'] as const satisfies readonly Funding[]
    expect(values).toEqual(['byok', 'included'])
  })

  test("PermissionMode values are 'default' | 'acceptEdits' | 'plan' | 'dontAsk'", () => {
    const values = [
      'default',
      'acceptEdits',
      'plan',
      'dontAsk',
    ] as const satisfies readonly PermissionMode[]
    expect(values).toEqual(['default', 'acceptEdits', 'plan', 'dontAsk'])
  })
})

describe('port shapes', () => {
  test('dummy objects satisfy Provider, SessionStore, and SessionEngineOptions', () => {
    const provider = {
      id: 'dummy',
      apiMode: 'openai_compat',
      profile(model: string) {
        return {
          id: model,
          contextWindow: 32_000,
          reserveOutputTokens: 3_200,
          inputUsdPerMTok: 0,
          outputUsdPerMTok: 0,
          cacheReadUsdPerMTok: 0,
          cacheWriteUsdPerMTok: 0,
          supportsThinking: false,
        }
      },
      async *stream() {
        yield { type: 'stop' as const, reason: null }
      },
    } satisfies Provider

    const store = {
      async createSession() {},
      async upsertSession() {},
      async listSessions() {
        return []
      },
      async loadSession() {
        return {
          session: {
            id: 'sess_1',
            createdAt: 0,
            updatedAt: 0,
            cwd: '/',
            model: 'dummy',
            permissionMode: 'default',
            compactGeneration: 0,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            funding: 'byok',
          },
          messages: [],
        }
      },
      async persistUser() {},
      async persistAssistant() {},
      async persistToolCalls() {},
      async persistToolResults() {},
      async setPermissionRules() {},
      async listPermissionRules() {
        return []
      },
      async recordCompact() {},
      async withWrite<T>(fn: () => Promise<T>) {
        return fn()
      },
    } satisfies SessionStore

    const options = {
      session: {
        id: 'sess_1',
        createdAt: 0,
        updatedAt: 0,
        cwd: '/',
        model: 'dummy',
        permissionMode: 'default',
        compactGeneration: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        funding: 'byok',
      },
      provider,
      store,
      tools: [],
      compact: {
        enabled: true,
        autoCompactBuffer: 13_000,
        blockingBufferWhenManual: 3_000,
        protectLastMessages: 20,
        keepRecentFiles: 5,
        maxCharsPerRestoredFile: 5_000,
        maxCharsRestoredFilesTotal: 50_000,
        maxCharsPerRestoredSkill: 5_000,
        maxCharsRestoredSkillsTotal: 25_000,
        maxConsecutiveFailures: 3,
        llmSummarize: false,
      },
      model: provider.profile('dummy'),
      maxRounds: 8,
      async askUser() {
        return 'deny' as const
      },
    } satisfies SessionEngineOptions

    expect(provider.id).toBe('dummy')
    expect(provider.apiMode).toBe('openai_compat')
    expect(options.session.funding).toBe('byok')
    expect(options.maxRounds).toBe(8)
  })
})
