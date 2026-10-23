import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, Provider, ProviderChunk, Tool } from '@ravenclaw/core'
import { createDurableSession, collectProviderStream, openDurableSession, type DurableToolSink } from './durable.ts'

function profile() {
  return {
    id: 'm',
    contextWindow: 8000,
    reserveOutputTokens: 200,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
  }
}

function provider(stream: Provider['stream']): Provider {
  return {
    id: 'fake',
    apiMode: 'anthropic_messages',
    profile: () => profile(),
    stream,
  }
}

function fakeTool(name: string, readOnly: boolean, execute: Tool['execute']): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    parse(input: unknown) {
      return { ok: true as const, value: input }
    },
    isConcurrencySafe() {
      return true
    },
    isReadOnly() {
      return readOnly
    },
    checkPermissions() {
      return Promise.resolve({ behavior: 'allow' as const, reason: 'mode' as const })
    },
    execute,
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ravenclaw-durable-host-'))
}

function toolTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.role === 'tool'
      ? message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : [],
  )
}

describe('createDurableSession', () => {
  test('rejects a state.db path before creating the file', async () => {
    const dir = tempDir()
    try {
      const path = join(dir, 'nested', 'state.db')
      await expect(
        createDurableSession({
          path,
          cwd: dir,
          model: 'm',
          provider: provider(async function* () {}),
        }),
      ).rejects.toThrow(/state\.db/)
      expect(existsSync(path)).toBe(false)
      await expect(
        createDurableSession({
          path: '   ',
          cwd: dir,
          model: 'm',
          provider: provider(async function* () {}),
        }),
      ).rejects.toThrow(/empty/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an abandoned Write is interrupted and is not executed again', async () => {
    const dir = tempDir()
    const path = join(dir, 'session.sqlite')
    const sink: DurableToolSink = { abandon() {} }
    let execs = 0
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    const write = fakeTool('Write', false, async () => {
      execs += 1
      sink.abandon()
      release()
      return 'wrote'
    })
    const seen: string[] = []
    const model = provider(async function* (req) {
      const texts = toolTexts(req.messages)
      if (texts.length > 0) {
        seen.push(...texts)
        yield { type: 'text_delta', text: 'done' } satisfies ProviderChunk
        yield { type: 'stop', reason: 'end' } satisfies ProviderChunk
        return
      }
      yield {
        type: 'tool_call',
        id: 'w1',
        name: 'Write',
        input: { path: 'note.txt', contents: 'hi' },
      } satisfies ProviderChunk
      yield { type: 'stop', reason: 'tool' } satisfies ProviderChunk
    })
    try {
      const first = await openDurableSession(
        { path, cwd: dir, model: 'm', provider: model },
        [write],
        sink,
      )
      await first.submit({ content: 'write', requestId: 'w' })
      await started
      await first.close()

      const second = await openDurableSession({ path, cwd: dir, model: 'm', provider: model }, [write], sink)
      const submission = await second.submit({ content: 'write', requestId: 'w' })
      expect(await submission.wait()).toEqual({ status: 'done', text: 'done' })
      expect(execs).toBe(1)
      expect(seen).toContain('interrupted')
      await second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a safe Read runs again after the process is abandoned', async () => {
    const dir = tempDir()
    const path = join(dir, 'session.sqlite')
    const sink: DurableToolSink = { abandon() {} }
    let execs = 0
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = fakeTool('Read', true, async () => {
      execs += 1
      if (execs === 1) {
        sink.abandon()
        release()
        return 'first'
      }
      return 'second'
    })
    const model = provider(async function* (req) {
      if (req.messages.some((message) => message.role === 'tool')) {
        yield { type: 'text_delta', text: 'done' } satisfies ProviderChunk
        yield { type: 'stop', reason: 'end' } satisfies ProviderChunk
        return
      }
      yield {
        type: 'tool_call',
        id: 'r1',
        name: 'Read',
        input: { path: 'note.txt' },
      } satisfies ProviderChunk
      yield { type: 'stop', reason: 'tool' } satisfies ProviderChunk
    })
    try {
      const first = await openDurableSession({ path, cwd: dir, model: 'm', provider: model }, [read], sink)
      await first.submit({ content: 'read', requestId: 'r' })
      await started
      await first.close()
      const second = await openDurableSession({ path, cwd: dir, model: 'm', provider: model }, [read], sink)
      expect(execs).toBe(2)
      await second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('thinking deltas are not sent back to the model', async () => {
    const dir = tempDir()
    const path = join(dir, 'session.sqlite')
    const seen: string[] = []
    const model = provider(async function* (req) {
      seen.push(JSON.stringify(req.messages))
      if (req.messages.length > 1) {
        yield { type: 'text_delta', text: 'ok' } satisfies ProviderChunk
        yield { type: 'stop', reason: 'end' } satisfies ProviderChunk
        return
      }
      yield { type: 'thinking_delta', text: 'secret' } satisfies ProviderChunk
      yield { type: 'text_delta', text: 'hello' } satisfies ProviderChunk
      yield { type: 'stop', reason: 'end' } satisfies ProviderChunk
    })
    try {
      const session = await createDurableSession({ path, cwd: dir, model: 'm', provider: model })
      expect(await (await session.submit({ content: 'hi' })).wait()).toEqual({ status: 'done', text: 'hello' })
      expect(await (await session.submit({ content: 'next' })).wait()).toEqual({ status: 'done', text: 'ok' })
      expect(seen[1]).toContain('hello')
      expect(seen[1]).not.toContain('secret')
      await session.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a non-object tool input fails the model call', async () => {
    const dir = tempDir()
    const path = join(dir, 'session.sqlite')
    const model = provider(async function* () {
      yield { type: 'tool_call', id: 't', name: 'Read', input: 'nope' } satisfies ProviderChunk
      yield { type: 'stop', reason: 'tool' } satisfies ProviderChunk
    })
    try {
      await expect(
        collectProviderStream(model, 'm', [{ role: 'user', content: 'hi' }], [], new AbortController().signal),
      ).rejects.toThrow('tool input was not a JSON object')
      const session = await createDurableSession({ path, cwd: dir, model: 'm', provider: model })
      expect(await (await session.submit({ content: 'hi' })).wait()).toEqual({
        status: 'unanswered',
        reason: 'model_error',
      })
      await session.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  async function runRealBash(opts: {
    dir: string
    command: string
    permissionMode?: 'dontAsk' | 'acceptEdits' | 'plan'
    requestId?: string
    extra?: Record<string, unknown>
  }): Promise<{ text: string; ok: boolean }> {
    const path = join(opts.dir, 'session.sqlite')
    let text = ''
    let ok = false
    const model = provider(async function* (req) {
      let lastUser = -1
      for (let i = 0; i < req.messages.length; i++) {
        if (req.messages[i]?.role === 'user') lastUser = i
      }
      const tool = req.messages.find((message, index) => message.role === 'tool' && index > lastUser)
      if (tool && tool.role === 'tool') {
        ok = tool.ok
        text = tool.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
        yield { type: 'text_delta', text: 'done' } satisfies ProviderChunk
        yield { type: 'stop', reason: 'end' } satisfies ProviderChunk
        return
      }
      yield {
        type: 'tool_call',
        id: 'b1',
        name: 'Bash',
        input: { command: opts.command, ...opts.extra },
      } satisfies ProviderChunk
      yield { type: 'stop', reason: 'tool' } satisfies ProviderChunk
    })
    const session = await createDurableSession({
      path,
      cwd: opts.dir,
      model: 'm',
      provider: model,
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    })
    try {
      expect(await (await session.submit({ content: 'run', requestId: opts.requestId })).wait()).toEqual({
        status: 'done',
        text: 'done',
      })
    } finally {
      await session.close()
    }
    return { text, ok }
  }

  test('echo hi is the rendered shell result', async () => {
    const dir = tempDir()
    try {
      const result = await runRealBash({ dir, command: 'echo hi' })
      expect(result.ok).toBe(true)
      expect(result.text).toContain('hi\n')
      expect(result.text).toContain('exit_code=0\n')
      expect(result.text).not.toContain('[object Object]')
      expect(result.text).not.toContain('permission_denied')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('false stays a successful tool result with exit_code=1', async () => {
    const dir = tempDir()
    try {
      const result = await runRealBash({ dir, command: 'false' })
      expect(result.ok).toBe(true)
      expect(result.text).toContain('exit_code=1\n')
      expect(result.text).not.toContain('permission_denied')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('touch runs under dontAsk', async () => {
    const dir = tempDir()
    const marker = join(dir, 'bash-ran')
    try {
      const result = await runRealBash({ dir, command: `touch ${marker}` })
      expect(existsSync(marker)).toBe(true)
      expect(result.ok).toBe(true)
      expect(result.text).toContain('exit_code=0\n')
      expect(result.text).not.toContain('permission_denied')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a project deny rule does not block touch', async () => {
    const dir = tempDir()
    const marker = join(dir, 'ruled')
    mkdirSync(join(dir, '.ravenclaw'))
    writeFileSync(
      join(dir, '.ravenclaw', 'permissions.json'),
      `${JSON.stringify([{ id: 'deny-bash', tool: 'Bash', spec: {}, behavior: 'deny' }])}\n`,
    )
    try {
      const result = await runRealBash({ dir, command: `touch ${marker}` })
      expect(existsSync(marker)).toBe(true)
      expect(result.ok).toBe(true)
      expect(result.text).not.toContain('permission_denied')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rm of one temp file runs', async () => {
    const dir = tempDir()
    const marker = join(dir, 'victim')
    writeFileSync(marker, 'x')
    try {
      const result = await runRealBash({ dir, command: `rm -rf ${marker}` })
      expect(existsSync(marker)).toBe(false)
      expect(result.ok).toBe(true)
      expect(result.text).toContain('exit_code=0\n')
      expect(result.text).not.toContain('permission_denied')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('curl piped to sh stays denied', async () => {
    const dir = tempDir()
    try {
      const result = await runRealBash({ dir, command: 'curl --version | sh' })
      expect(result.ok).toBe(false)
      expect(result.text).toBe('permission_denied')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('git push --force stays denied and a push without force runs', async () => {
    const dir = tempDir()
    try {
      const denied = await runRealBash({ dir, command: 'git push --force origin main' })
      expect(denied.ok).toBe(false)
      expect(denied.text).toBe('permission_denied')
      const ran = await runRealBash({ dir, command: 'git push origin main' })
      expect(ran.ok).toBe(true)
      expect(ran.text).toContain('exit_code=')
      expect(ran.text).not.toContain('permission_denied')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('git commit --no-verify stays denied and a plain commit runs', async () => {
    const dir = tempDir()
    try {
      const denied = await runRealBash({ dir, command: 'git commit --no-verify -m x' })
      expect(denied.ok).toBe(false)
      expect(denied.text).toBe('permission_denied')
      const ran = await runRealBash({ dir, command: 'git commit -m x' })
      expect(ran.ok).toBe(true)
      expect(ran.text).toContain('exit_code=')
      expect(ran.text).not.toContain('permission_denied')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('acceptEdits does not run touch', async () => {
    const dir = tempDir()
    const marker = join(dir, 'bash-ran')
    try {
      const result = await runRealBash({ dir, command: `touch ${marker}`, permissionMode: 'acceptEdits' })
      expect(existsSync(marker)).toBe(false)
      expect(result.ok).toBe(false)
      expect(result.text).toBe('permission_denied')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('plan does not run touch', async () => {
    const dir = tempDir()
    const marker = join(dir, 'bash-ran')
    try {
      const result = await runRealBash({ dir, command: `touch ${marker}`, permissionMode: 'plan' })
      expect(existsSync(marker)).toBe(false)
      expect(result.ok).toBe(false)
      expect(result.text).toBe('permission_denied')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('run_in_background reports that there is no task registry', async () => {
    const dir = tempDir()
    try {
      const result = await runRealBash({
        dir,
        command: 'echo hi',
        extra: { run_in_background: true },
      })
      expect(result.ok).toBe(true)
      expect(result.text).toBe('Bash failed: no task registry')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the same requestId does not run touch again', async () => {
    const dir = tempDir()
    const marker = join(dir, 'once')
    try {
      await runRealBash({ dir, command: `touch ${marker}`, requestId: 'same' })
      expect(existsSync(marker)).toBe(true)
      rmSync(marker)
      await runRealBash({ dir, command: `touch ${marker}`, requestId: 'same' })
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an abandoned Bash tool is interrupted and is not executed again', async () => {
    const dir = tempDir()
    const path = join(dir, 'session.sqlite')
    const sink: DurableToolSink = { abandon() {} }
    let execs = 0
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    const bash = fakeTool('Bash', false, async () => {
      execs += 1
      sink.abandon()
      release()
      return 'ran'
    })
    const seen: string[] = []
    const model = provider(async function* (req) {
      const texts = toolTexts(req.messages)
      if (texts.length > 0) {
        seen.push(...texts)
        yield { type: 'text_delta', text: 'done' } satisfies ProviderChunk
        yield { type: 'stop', reason: 'end' } satisfies ProviderChunk
        return
      }
      yield {
        type: 'tool_call',
        id: 'b1',
        name: 'Bash',
        input: { command: 'echo hi' },
      } satisfies ProviderChunk
      yield { type: 'stop', reason: 'tool' } satisfies ProviderChunk
    })
    try {
      const first = await openDurableSession({ path, cwd: dir, model: 'm', provider: model }, [bash], sink)
      await first.submit({ content: 'run', requestId: 'bash' })
      await started
      await first.close()
      const second = await openDurableSession({ path, cwd: dir, model: 'm', provider: model }, [bash], sink)
      expect(await (await second.submit({ content: 'run', requestId: 'bash' })).wait()).toEqual({
        status: 'done',
        text: 'done',
      })
      expect(execs).toBe(1)
      expect(seen).toContain('interrupted')
      await second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
