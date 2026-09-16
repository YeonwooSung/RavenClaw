import { describe, expect, test } from 'bun:test'
import {
  PersistError,
  SessionLockError,
  defaultConfig,
  defaultModelId,
  getModelProfile,
  ravenclawHome,
  reserveOutputTokens,
  sessionLockedMessage,
  type ApiMode,
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

describe('SessionLockError', () => {
  test('includes holder name and expiry in the message', () => {
    const expiresAt = Date.parse('2026-09-12T00:00:00.000Z')
    const err = new SessionLockError(sessionLockedMessage('serve', expiresAt), {
      holderName: 'serve',
      expiresAt,
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SessionLockError')
    expect(err.holderName).toBe('serve')
    expect(err.expiresAt).toBe(expiresAt)
    expect(err.message).toBe('session locked by serve until 2026-09-12T00:00:00.000Z')
  })

  test('names slack holder slack, not serve', () => {
    const expiresAt = Date.parse('2026-09-12T00:00:00.000Z')
    const err = new SessionLockError(sessionLockedMessage('slack', expiresAt), {
      holderName: 'slack',
      expiresAt,
    })
    expect(err.holderName).toBe('slack')
    expect(err.message).toBe('session locked by slack until 2026-09-12T00:00:00.000Z')
    expect(err.message).not.toContain('serve')
  })
})

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

    const imageTool: Message = {
      id: 'msg_tool_img',
      role: 'tool',
      toolUseId: 'call_img',
      ok: true,
      blocks: [
        { type: 'text', text: '[image image/png]' },
        { type: 'image', mediaType: 'image/png', data: 'abc' },
      ],
      createdAt: 4,
    }
    expect(imageTool.blocks[1]).toEqual({
      type: 'image',
      mediaType: 'image/png',
      data: 'abc',
    })
  })
})

describe('ApiMode', () => {
  test("includes openai_compat, anthropic_messages, and openai_responses", () => {
    const values = [
      'openai_compat',
      'anthropic_messages',
      'openai_responses',
    ] as const satisfies readonly ApiMode[]
    expect(values).toEqual(['openai_compat', 'anthropic_messages', 'openai_responses'])
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
      async updateSessionTodos() {},
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
            todos: [{ text: 'ship', status: 'pending' }],
          },
          messages: [],
        }
      },
      async deleteSession() {},
      async upsertPendingAsk() {},
      async listPendingAsks() {
        return []
      },
      async getPendingAsk() {
        return undefined
      },
      async deletePendingAsk() {},
      async persistUser() {},
      async persistAssistant() {},
      async persistToolCalls() {},
      async persistToolResults() {},
      async setPermissionRules() {},
      async listPermissionRules() {
        return []
      },
      async recordCompact() {},
      async enqueueAgentMail() {},
      async peekAgentMail() {
        return []
      },
      async drainAgentMail() {
        return []
      },
      async acquireSessionLock() {},
      async renewSessionLock() {},
      async releaseSessionLock() {},
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
        todos: [{ text: 'ship', status: 'pending' }],
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

describe('package root re-exports PR3 APIs', () => {
  test('home, config, and ModelProfile are importable from @ravenclaw/core', () => {
    expect(ravenclawHome().endsWith('.ravenclaw')).toBe(true)
    expect(defaultConfig().ads.feedUrl).toBe('')
    expect(defaultConfig().model).toBe(defaultModelId('anthropic'))
    expect(reserveOutputTokens(200_000)).toBe(20_000)
    expect(getModelProfile('missing').contextWindow).toBe(32_000)
  })
})
