import { describe, expect, test } from 'bun:test'
import type {
  RoundEnd,
  SessionEngine,
  SessionRecord,
  StreamEvent,
} from '@ravenclaw/core'
import { createAskBridge, type CliRuntime } from './engine'
import { runOpenTuiApp } from './opentui-app'

function makeSession(): SessionRecord {
  return {
    id: 'sess_opentui',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp',
    model: 'dummy',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
  }
}

function asyncLines(...lines: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) yield line
    },
  }
}

function fakeRuntime(engine: SessionEngine, ask = createAskBridge()): CliRuntime {
  return { engine, ask } as CliRuntime
}

function fakeEngine(
  session: SessionRecord,
  submit: (text: string) => AsyncGenerator<StreamEvent, RoundEnd>,
): SessionEngine {
  return {
    get session() {
      return session
    },
    submitMessage: submit,
    async compactNow() {},
    async setPermissionMode() {},
    abort() {},
  }
}

describe('runOpenTuiApp', () => {
  test('user prompt streams text_delta into written lines and /quit exits 0', async () => {
    const submitted: string[] = []
    const engine = fakeEngine(makeSession(), async function* (text) {
      submitted.push(text)
      yield { type: 'text_delta', text: 'hello back' }
      return { reason: 'completed' }
    })
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(engine), {
      input: asyncLines('hi', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
    })
    expect(code).toBe(0)
    expect(submitted).toEqual(['hi'])
    expect(written.join('')).toContain('hello back')
  })

  test('permission_ask then y allows via the ask bridge', async () => {
    const answers: Array<'allow' | 'deny' | 'allow_always'> = []
    const ask = createAskBridge()
    const event: Extract<StreamEvent, { type: 'permission_ask' }> = {
      type: 'permission_ask',
      id: 'p1',
      tool: 'Bash',
      input: { command: 'ls' },
      message: 'Allow Bash?',
    }
    const engine = fakeEngine(makeSession(), async function* (text) {
      expect(text).toBe('run ls')
      yield event
      const answer = await ask.ask(event, new AbortController().signal)
      answers.push(answer)
      yield { type: 'text_delta', text: `answer:${answer}` }
      return { reason: 'completed' }
    })
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(engine, ask), {
      input: asyncLines('run ls', 'y', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
    })
    expect(code).toBe(0)
    expect(answers).toEqual(['allow'])
    expect(written.join('')).toContain('Allow Bash?')
    expect(written.join('')).toContain('answer:allow')
  })
})
