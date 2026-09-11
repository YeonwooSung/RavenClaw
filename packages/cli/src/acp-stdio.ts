import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_PARSE_ERROR,
  createAcpServer,
  jsonRpcError,
  type AcpEngine,
  type JsonRpcId,
} from '@ravenclaw/acp'
import { bootCli, openNewSession, resumeRuntime } from './engine'

export type AcpStdioBoot = () => Promise<{
  engine?: AcpEngine
  create?: (sessionId: string) => Promise<AcpEngine>
  load?: (sessionId: string) => Promise<AcpEngine>
}>

export type RunAcpStdioOpts = {
  input?: AsyncIterable<string | Uint8Array>
  output?: { write(chunk: string): unknown }
  boot?: AcpStdioBoot
}

export async function runAcpStdio(opts: RunAcpStdioOpts = {}): Promise<void> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const boot = opts.boot ?? defaultBoot
  let booted: Awaited<ReturnType<AcpStdioBoot>> | undefined
  const once = async () => {
    booted ??= await boot()
    return booted
  }

  const writeLine = (value: unknown) => {
    output.write(`${JSON.stringify(value)}\n`)
  }

  const server = createAcpServer({
    engineFactory: (sessionId) =>
      wrapBoot(
        once().then(async (runtime) => {
          if (runtime.create) return runtime.create(sessionId)
          if (runtime.engine) return runtime.engine
          throw new Error('ACP boot did not provide create or engine')
        }),
      ),
    loadEngine: (sessionId) =>
      wrapBoot(
        once().then(async (runtime) => {
          if (runtime.load) return runtime.load(sessionId)
          throw new Error(`session not found: ${sessionId}`)
        }),
      ),
    notify: writeLine,
  })

  for await (const line of readLines(input)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let msg: unknown
    try {
      msg = JSON.parse(trimmed) as unknown
    } catch {
      writeLine(jsonRpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error'))
      continue
    }
    try {
      writeLine(await server.handle(msg))
    } catch (error) {
      writeLine(
        jsonRpcError(
          requestId(msg),
          JSON_RPC_INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error),
        ),
      )
    }
  }
}

async function* readLines(
  input: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<string> {
  let buf = ''
  for await (const chunk of input) {
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    let idx = buf.indexOf('\n')
    while (idx >= 0) {
      yield buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      idx = buf.indexOf('\n')
    }
  }
  if (buf.length > 0) yield buf
}

async function defaultBoot(): Promise<{
  create: (sessionId: string) => Promise<AcpEngine>
  load: (sessionId: string) => Promise<AcpEngine>
}> {
  const runtime = await bootCli({ flags: { dontAsk: true }, createSession: false })
  return {
    create: async (sessionId) => (await openNewSession(runtime, { sessionId })).engine,
    load: async (sessionId) => (await resumeRuntime(runtime, sessionId)).engine,
  }
}

function wrapBoot(booted: Promise<AcpEngine>): AcpEngine {
  const ready = booted
  void ready.catch(() => {})
  return {
    async *submitMessage(text) {
      const engine = await ready
      return yield* engine.submitMessage(text)
    },
    abort() {
      void ready.then((engine) => engine.abort()).catch(() => {})
    },
  }
}

function requestId(message: unknown): JsonRpcId | null {
  if (!message || typeof message !== 'object') return null
  const id = (message as { id?: unknown }).id
  if (typeof id === 'string' || typeof id === 'number') return id
  return null
}
