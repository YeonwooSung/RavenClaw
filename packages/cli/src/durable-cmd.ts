import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import {
  ensureHomeDir,
  loadConfig,
  type ConfigFlags,
  type Provider,
  type ResolvedConfig,
} from '@ravenclaw/core'
import { createDurableSession, type CreateDurableSessionOptions } from '@ravenclaw/sdk'
import { providerFromConfig } from './engine'
import { SETUP_HINT, providerConfigured } from './first-run'

export const DURABLE_USAGE = 'usage: raven durable --path <file> <prompt>'

type DurableCommandSession = {
  submit(input: { content: string; requestId?: string }): Promise<{
    wait(): Promise<{ status: 'done'; text: string } | { status: 'unanswered'; reason: string }>
  }>
  close(): Promise<void>
}

export function durableRequestId(filePath: string, prompt: string): string {
  // resolve() follows process.cwd(), not the session cwd.
  const digest = createHash('sha256')
    .update(resolve(filePath))
    .update('\0')
    .update(prompt)
    .digest('hex')
  return `durable:${digest}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runDurableCommand(input: {
  path: string | undefined
  prompt: string | undefined
  flags: ConfigFlags
  cwd?: string
  home?: string
  ensureHome?: () => Promise<string>
  io?: {
    stdout?: { write(chunk: string): void }
    stderr?: { write(chunk: string): void }
  }
  createSession?: (opts: CreateDurableSessionOptions) => Promise<DurableCommandSession>
  resolveProvider?: (config: ResolvedConfig) => Promise<Provider>
}): Promise<number> {
  const stdout = input.io?.stdout ?? process.stdout
  const stderr = input.io?.stderr ?? process.stderr
  if (input.path === undefined || input.prompt === undefined || input.prompt === '') {
    stderr.write(`${DURABLE_USAGE}\n`)
    return 2
  }

  const createSession = input.createSession ?? createDurableSession
  const resolveProvider = input.resolveProvider ?? providerFromConfig
  let code = 1
  let session: DurableCommandSession | undefined
  try {
    const home = input.home ?? (await (input.ensureHome ?? ensureHomeDir)())
    if (!providerConfigured(home, input.flags)) {
      stderr.write(`${SETUP_HINT}\n`)
      code = 1
    } else {
      const config = loadConfig({ home, flags: input.flags })
      const provider = await resolveProvider(config)
      const cwd = input.cwd ?? input.flags.cwd ?? process.cwd()
      session = await createSession({
        path: input.path,
        cwd,
        provider,
        model: config.model,
        permissionMode: 'dontAsk',
      })
      const submission = await session.submit({
        content: input.prompt,
        requestId: durableRequestId(input.path, input.prompt),
      })
      const result = await submission.wait()
      if (result.status === 'done') {
        stdout.write(`${result.text}\n`)
        code = 0
      } else {
        stderr.write(`${result.reason}\n`)
      }
    }
  } catch (error) {
    stderr.write(`${errorMessage(error)}\n`)
    code = 1
  } finally {
    if (session !== undefined) {
      try {
        await session.close()
      } catch (error) {
        stderr.write(`${errorMessage(error)}\n`)
        code = 1
      }
    }
  }
  return code
}
