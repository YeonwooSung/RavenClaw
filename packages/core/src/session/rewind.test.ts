import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionEngine } from '../loop/session-engine'
import type {
  CompactPolicy,
  Message,
  ModelProfile,
  Provider,
  ProviderChunk,
  SessionRecord,
  SessionStore,
  StreamEvent,
} from '../types'
import { enterSessionWorktree, exitSessionWorktree } from '../tools/session-worktree'
import { createFileHistory } from './file-history'
import { createMemoryStore } from './memory-store'
import { dropLastUserTurn, formatRewindNotice, rewindLastTurn, rewindToCheckpoint } from './rewind'
import { createSqliteStore } from './sqlite-store'

function user(id: string, text: string, createdAt: number): Message {
  return { id, role: 'user', blocks: [{ type: 'text', text }], createdAt }
}

function assistant(id: string, text: string, createdAt: number): Message {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], createdAt }
}

function tool(id: string, toolUseId: string, text: string, createdAt: number): Message {
  return { id, role: 'tool', toolUseId, ok: true, blocks: [{ type: 'text', text }], createdAt }
}

describe('dropLastUserTurn', () => {
  test('keeps earlier history and drops the last user plus assistant and tool after it', () => {
    const messages: Message[] = [
      user('u1', 'first', 1),
      assistant('a1', 'ok', 2),
      tool('t1', 'call-1', 'done', 3),
      user('u2', 'second', 4),
      assistant('a2', 'working', 5),
      tool('t2', 'call-2', 'patched', 6),
    ]
    const next = dropLastUserTurn(messages)
    expect(next.map((msg) => msg.id)).toEqual(['u1', 'a1', 't1'])
    expect(messages).toHaveLength(6)
  })

  test('drops a trailing user with no reply', () => {
    const messages: Message[] = [user('u1', 'first', 1), assistant('a1', 'ok', 2), user('u2', 'again', 3)]
    expect(dropLastUserTurn(messages).map((msg) => msg.id)).toEqual(['u1', 'a1'])
  })

  test('returns the same array when there is no user turn', () => {
    const messages: Message[] = [assistant('a1', 'orphan', 1)]
    expect(dropLastUserTurn(messages)).toBe(messages)
    expect(dropLastUserTurn([])).toEqual([])
  })
})

describe('formatRewindNotice', () => {
  test('describes blocked, empty, and combined file plus message rewinds', () => {
    expect(formatRewindNotice({ restored: [], removed: [], blocked: true }, 0)).toBe(
      'a turn is in progress',
    )
    expect(formatRewindNotice({ restored: [], removed: [] }, 0)).toBe('nothing to rewind')
    expect(formatRewindNotice({ restored: [], removed: [] }, 1)).toBe('dropped 1 message')
    expect(formatRewindNotice({ restored: ['a'], removed: ['b'] }, 3)).toBe(
      'undo: restored 1, removed 1; dropped 3 messages',
    )
  })
})

describe('rewindLastTurn', () => {
  test('undoes the last closed generation and drops that user turn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-rewind-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-rewind-cwd-'))
    const existing = join(cwd, 'a.txt')
    const created = join(cwd, 'b.txt')
    writeFileSync(existing, 'old\n')
    const history = createFileHistory('sess_rewind', home)
    history.beginTurn()
    history.snapshot(existing)
    writeFileSync(existing, 'new\n')
    history.snapshot(created)
    writeFileSync(created, 'fresh\n')
    history.endTurn()

    const messages: Message[] = [
      user('u1', 'first', 1),
      assistant('a1', 'ok', 2),
      user('u2', 'edit files', 3),
      assistant('a2', 'patched', 4),
      tool('t2', 'edit-1', 'wrote', 5),
    ]
    const result = await rewindLastTurn({ fileHistory: history, messages })
    expect(result.ok).toBe(true)
    expect(result.messages.map((msg) => msg.id)).toEqual(['u1', 'a1'])
    expect(readFileSync(existing, 'utf8')).toBe('old\n')
    expect(result.notice).toContain('restored 1')
    expect(result.notice).toContain('removed 1')
    expect(result.notice).toContain('dropped 3 messages')
  })

  test('does not drop messages while a generation is open', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-rewind-open-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-rewind-open-cwd-'))
    const live = join(cwd, 'live.txt')
    writeFileSync(live, 'old\n')
    const history = createFileHistory('sess_open', home)
    history.beginTurn()
    history.snapshot(live)
    writeFileSync(live, 'new\n')

    const messages: Message[] = [user('u1', 'edit', 1), assistant('a1', 'working', 2)]
    const result = await rewindLastTurn({ fileHistory: history, messages })
    expect(result.ok).toBe(false)
    expect(result.notice).toBe('a turn is in progress')
    expect(result.messages).toBe(messages)
    expect(readFileSync(live, 'utf8')).toBe('new\n')
  })

  test('refuses while a later generation is open even if a prior turn can undo', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-rewind-prior-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-rewind-prior-cwd-'))
    const prior = join(cwd, 'prior.txt')
    const live = join(cwd, 'live.txt')
    writeFileSync(prior, 'old-prior\n')
    writeFileSync(live, 'old-live\n')
    const history = createFileHistory('sess_prior', home)
    history.beginTurn()
    history.snapshot(prior)
    writeFileSync(prior, 'new-prior\n')
    history.endTurn()
    history.beginTurn()
    history.snapshot(live)
    writeFileSync(live, 'new-live\n')

    const messages: Message[] = [
      user('u1', 'first', 1),
      assistant('a1', 'ok', 2),
      user('u2', 'second', 3),
    ]
    const result = await rewindLastTurn({ fileHistory: history, messages })
    expect(result.ok).toBe(false)
    expect(result.notice).toBe('a turn is in progress')
    expect(result.messages).toBe(messages)
    expect(readFileSync(prior, 'utf8')).toBe('new-prior\n')
    expect(readFileSync(live, 'utf8')).toBe('new-live\n')
  })

  test('inactivates dropped messages before undoing files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-rewind-store-'))
    const history = createFileHistory('sess_store', home)
    history.beginTurn()
    history.endTurn()
    const messages: Message[] = [user('u1', 'keep', 1), assistant('a1', 'ok', 2), user('u2', 'drop', 3)]
    const inactivated: string[] = []
    const store = {
      async recordCompact(_sessionId: string, _generation: number, _summary: string, ids: string[]) {
        inactivated.push(...ids)
      },
    } as SessionStore
    const result = await rewindLastTurn({
      fileHistory: history,
      messages,
      store,
      sessionId: 'sess_store',
      generation: 1,
    })
    expect(result.ok).toBe(true)
    expect(result.messages.map((msg) => msg.id)).toEqual(['u1', 'a1'])
    expect(inactivated).toEqual(['u2'])
  })

  test('does not undo files when persist fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-rewind-fail-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-rewind-fail-cwd-'))
    const path = join(cwd, 'keep.txt')
    writeFileSync(path, 'old\n')
    const history = createFileHistory('sess_fail', home)
    history.beginTurn()
    history.snapshot(path)
    writeFileSync(path, 'new\n')
    history.endTurn()
    const messages: Message[] = [user('u1', 'edit', 1), assistant('a1', 'ok', 2)]
    const store = {
      async recordCompact() {
        throw new Error('disk full')
      },
    } as unknown as SessionStore
    const result = await rewindLastTurn({
      fileHistory: history,
      messages,
      store,
      sessionId: 'sess_fail',
    })
    expect(result.ok).toBe(false)
    expect(result.notice).toBe('rewind persist failed')
    expect(readFileSync(path, 'utf8')).toBe('new\n')
  })
})

describe('rewindToCheckpoint', () => {
  const tempDirs: string[] = []
  const sessionIds: string[] = []
  let seq = 0

  afterEach(() => {
    while (sessionIds.length > 0) {
      const id = sessionIds.pop()
      if (id) exitSessionWorktree(id, 'remove', true)
    }
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

  function nextSession(): string {
    const id = `sess_rewind_job_${Date.now()}_${seq++}`
    sessionIds.push(id)
    return id
  }

  function initGitRepo(dir: string): void {
    const run = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
      expect(result.status).toBe(0)
    }
    run(['init'])
    run(['config', 'user.email', 'test@example.com'])
    run(['config', 'user.name', 'Test'])
    run(['config', 'commit.gpgsign', 'false'])
    run(['commit', '--allow-empty', '-m', 'init'])
  }

  function git(cwd: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(result.status).toBe(0)
    return result.stdout.trim()
  }

  function defaultModel(id = 'dummy'): ModelProfile {
    return {
      id,
      contextWindow: 32_000,
      reserveOutputTokens: 3_200,
      inputUsdPerMTok: 0,
      outputUsdPerMTok: 0,
      cacheReadUsdPerMTok: 0,
      cacheWriteUsdPerMTok: 0,
      supportsThinking: false,
    }
  }

  function defaultCompact(over: Partial<CompactPolicy> = {}): CompactPolicy {
    return {
      enabled: true,
      autoCompactBuffer: 13_000,
      blockingBufferWhenManual: 3_000,
      protectLastMessages: 2,
      keepRecentFiles: 5,
      maxCharsPerRestoredFile: 5_000,
      maxCharsRestoredFilesTotal: 50_000,
      maxCharsPerRestoredSkill: 5_000,
      maxCharsRestoredSkillsTotal: 25_000,
      maxConsecutiveFailures: 3,
      llmSummarize: false,
      ...over,
    }
  }

  function createFakeProvider(scripts: ProviderChunk[][]): Provider {
    const queue = [...scripts]
    return {
      id: 'fake',
      apiMode: 'openai_compat',
      profile(model: string) {
        return defaultModel(model)
      },
      async *stream(_req, signal) {
        const script = queue.shift() ?? [{ type: 'stop' as const, reason: null }]
        for (const chunk of script) {
          if (signal.aborted) return
          yield chunk
        }
      },
    }
  }

  async function drain(gen: AsyncGenerator<StreamEvent, import('../types').RoundEnd>) {
    const events: StreamEvent[] = []
    while (true) {
      const next = await gen.next()
      if (next.done) return { events, result: next.value }
      events.push(next.value)
    }
  }

  function sessionRecord(over: Partial<SessionRecord> = {}): SessionRecord {
    return {
      id: 'sess_rewind_job',
      createdAt: 1,
      updatedAt: 1,
      cwd: '/tmp',
      model: 'dummy',
      permissionMode: 'default',
      compactGeneration: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      funding: 'byok',
      ...over,
    }
  }

  test('two committed turns, rewind once: HEAD is the first checkpoint sha and todos match', async () => {
    // enter job, write+commit turn1 with todos [a], write+commit turn2 with todos [a,b]
    // rewindLast → HEAD === turn1 sha, session.todos === [a], last user/assistant of turn2 gone
    const cwd = tempDir('ravenclaw-rewind-ckpt-')
    initGitRepo(cwd)
    const id = nextSession()
    const entered = enterSessionWorktree(id, cwd)
    expect(entered.ok).toBe(true)
    expect(entered.job).toBeDefined()
    const job = entered.job!
    const store = createMemoryStore()
    const sess = sessionRecord({
      id,
      cwd: job.worktreePath,
      job,
      jobAutoCommit: true,
      todos: [{ text: 'a', status: 'pending' }],
    })
    await store.createSession(sess)
    const engine = createSessionEngine({
      session: sess,
      provider: createFakeProvider([
        [
          { type: 'text_delta', text: 'one' },
          { type: 'stop', reason: 'end' },
        ],
        [
          { type: 'text_delta', text: 'two' },
          { type: 'stop', reason: 'end' },
        ],
      ]),
      store,
      tools: [],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 8,
      bare: true,
      async askUser() {
        return 'deny'
      },
    })

    writeFileSync(join(job.worktreePath, 't1.txt'), 'turn1\n')
    const first = await drain(engine.submitMessage('first'))
    expect(first.result).toEqual({ reason: 'completed' })
    const turn1Sha = git(job.worktreePath, ['rev-parse', 'HEAD'])

    engine.session.todos = [
      { text: 'a', status: 'pending' },
      { text: 'b', status: 'pending' },
    ]
    writeFileSync(join(job.worktreePath, 't2.txt'), 'turn2\n')
    const second = await drain(engine.submitMessage('second'))
    expect(second.result).toEqual({ reason: 'completed' })
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).not.toBe(turn1Sha)

    const result = await engine.rewindLast()
    expect(result.ok).toBe(true)
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(turn1Sha)
    expect(engine.session.todos).toEqual([{ text: 'a', status: 'pending' }])
    const loaded = await store.loadSession(id)
    expect(loaded.session.todos).toEqual([{ text: 'a', status: 'pending' }])
    expect(loaded.messages.map((msg) => msg.role)).toEqual(['user', 'assistant'])
    const userText = loaded.messages[0]?.blocks[0]
    expect(userText && userText.type === 'text' ? userText.text : undefined).toBe('first')
  })

  test('rewinds to baseCommitSha when no earlier checkpoint remains', async () => {
    const cwd = tempDir('ravenclaw-rewind-base-')
    initGitRepo(cwd)
    const id = nextSession()
    const entered = enterSessionWorktree(id, cwd)
    expect(entered.ok).toBe(true)
    const job = entered.job!
    writeFileSync(join(job.worktreePath, 'extra.txt'), 'later\n')
    const commit = spawnSync('git', ['add', '-A'], { cwd: job.worktreePath, encoding: 'utf8' })
    expect(commit.status).toBe(0)
    expect(spawnSync('git', ['commit', '-m', 'later'], { cwd: job.worktreePath, encoding: 'utf8' }).status).toBe(0)
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).not.toBe(job.baseCommitSha)

    const store = createMemoryStore()
    const sess = sessionRecord({
      id,
      cwd: job.worktreePath,
      job,
      todos: [{ text: 'gone', status: 'pending' }],
    })
    await store.createSession(sess)
    const messages: Message[] = [
      user('u1', 'only', 1),
      assistant('a1', 'ok', 2),
    ]
    await store.persistUser(id, messages[0] as Extract<Message, { role: 'user' }>)
    await store.persistAssistant(id, messages[1] as Extract<Message, { role: 'assistant' }>)

    const result = await rewindToCheckpoint({ session: sess, messages, store })
    expect(result.ok).toBe(true)
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(job.baseCommitSha)
    expect(sess.todos).toEqual([])
    expect(result.messages).toEqual([])
  })

  test('reset failure does not inactivate messages and returns originals', async () => {
    const cwd = tempDir('ravenclaw-rewind-reset-fail-')
    initGitRepo(cwd)
    const id = nextSession()
    const entered = enterSessionWorktree(id, cwd)
    expect(entered.ok).toBe(true)
    const job = entered.job!
    job.baseCommitSha = 'not-a-real-commit-sha'
    const store = createMemoryStore()
    const sess = sessionRecord({
      id,
      cwd: job.worktreePath,
      job,
      todos: [{ text: 'keep', status: 'pending' }],
    })
    await store.createSession(sess)
    const messages: Message[] = [user('u1', 'only', 1), assistant('a1', 'ok', 2)]
    await store.persistUser(id, messages[0] as Extract<Message, { role: 'user' }>)
    await store.persistAssistant(id, messages[1] as Extract<Message, { role: 'assistant' }>)
    const inactivated: string[] = []
    const orig = store.recordCompact.bind(store)
    store.recordCompact = async (sessionId, generation, summary, ids) => {
      inactivated.push(...ids)
      return orig(sessionId, generation, summary, ids)
    }

    const headBefore = git(job.worktreePath, ['rev-parse', 'HEAD'])
    const result = await rewindToCheckpoint({ session: sess, messages, store })
    expect(result.ok).toBe(false)
    expect(result.notice.startsWith('rewind reset failed:')).toBe(true)
    expect(result.messages).toBe(messages)
    expect(inactivated).toEqual([])
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(sess.todos).toEqual([{ text: 'keep', status: 'pending' }])
    expect(sess.jobError?.startsWith('rewind reset failed:')).toBe(true)
    const loaded = await store.loadSession(id)
    expect(loaded.messages.map((msg) => msg.id)).toEqual(['u1', 'a1'])
    expect(loaded.session.jobError?.startsWith('rewind reset failed:')).toBe(true)
  })

  test('successful rewind clears session.jobError', async () => {
    const cwd = tempDir('ravenclaw-rewind-clear-err-')
    initGitRepo(cwd)
    const id = nextSession()
    const entered = enterSessionWorktree(id, cwd)
    expect(entered.ok).toBe(true)
    const job = entered.job!
    writeFileSync(join(job.worktreePath, 'extra.txt'), 'later\n')
    expect(spawnSync('git', ['add', '-A'], { cwd: job.worktreePath, encoding: 'utf8' }).status).toBe(0)
    expect(
      spawnSync('git', ['commit', '-m', 'later'], { cwd: job.worktreePath, encoding: 'utf8' }).status,
    ).toBe(0)
    const store = createMemoryStore()
    const sess = sessionRecord({
      id,
      cwd: job.worktreePath,
      job,
      jobError: 'prior rewind fail',
      todos: [{ text: 'gone', status: 'pending' }],
    })
    await store.createSession(sess)
    const messages: Message[] = [user('u1', 'only', 1), assistant('a1', 'ok', 2)]
    await store.persistUser(id, messages[0] as Extract<Message, { role: 'user' }>)
    await store.persistAssistant(id, messages[1] as Extract<Message, { role: 'assistant' }>)

    const result = await rewindToCheckpoint({ session: sess, messages, store })
    expect(result.ok).toBe(true)
    expect(sess.jobError).toBeUndefined()
    const loaded = await store.loadSession(id)
    expect(loaded.session.jobError).toBeUndefined()
  })

  test('persistAssistant and persistToolCalls write checkpoint_json', async () => {
    const dir = tempDir('ravenclaw-ckpt-sql-')
    const store = createSqliteStore(join(dir, 'state.db')) as SessionStore & { close(): void }
    const sess = sessionRecord({ id: 's1' })
    await store.createSession(sess)
    const textOnly: Extract<Message, { role: 'assistant' }> = {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'ok' }],
      createdAt: 1,
      checkpoint: {
        commitSha: 'abc123',
        todoSnapshot: [{ text: 'a', status: 'pending' }],
        dirty: false,
      },
    }
    await store.persistAssistant('s1', textOnly)
    const withTools: Extract<Message, { role: 'assistant' }> = {
      id: 'a2',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'c1', name: 'Echo', input: {} }],
      createdAt: 2,
    }
    await store.persistToolCalls('s1', withTools)
    withTools.checkpoint = {
      commitSha: 'def456',
      todoSnapshot: [{ text: 'b', status: 'done' }],
      dirty: true,
    }
    await store.persistToolCalls('s1', withTools)
    const loaded = await store.loadSession('s1')
    const asst1 = loaded.messages.find((msg) => msg.id === 'a1')
    const asst2 = loaded.messages.find((msg) => msg.id === 'a2')
    expect(asst1 && asst1.role === 'assistant' ? asst1.checkpoint : undefined).toEqual(
      textOnly.checkpoint,
    )
    expect(asst2 && asst2.role === 'assistant' ? asst2.checkpoint : undefined).toEqual(
      withTools.checkpoint,
    )
    store.close()
  })
})
