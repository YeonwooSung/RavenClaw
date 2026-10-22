import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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

  test('Bash is denied without calling execute', async () => {
    const dir = tempDir()
    const path = join(dir, 'session.sqlite')
    const marker = join(dir, 'bash-ran')
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
        input: { command: `touch ${marker}` },
      } satisfies ProviderChunk
      yield { type: 'stop', reason: 'tool' } satisfies ProviderChunk
    })
    try {
      const session = await createDurableSession({ path, cwd: dir, model: 'm', provider: model })
      expect(await (await session.submit({ content: 'run' })).wait()).toEqual({ status: 'done', text: 'done' })
      expect(seen).toContain('permission_denied')
      expect(existsSync(marker)).toBe(false)
      await session.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
