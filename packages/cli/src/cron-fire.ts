import { createTerminalBackend, type CronJob, type ResolvedConfig } from '@ravenclaw/core'
import { runExec, type RunExecOpts } from './exec'
import { openNewSession, type CliRuntime, type CliRuntimeBase } from './engine'

const PRE_SCRIPT_TIMEOUT_MS = 30_000

function clampJobTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return 600_000
  const n = Math.trunc(timeoutMs)
  if (n < 15_000) return 15_000
  if (n > 3_600_000) return 3_600_000
  return n
}

export function cronFireSessionRuntime(runtime: CliRuntimeBase, job: CronJob): CliRuntimeBase {
  const { engine: _engine, ...rest } = runtime as CliRuntimeBase & { engine?: unknown }
  const config = { ...runtime.config, permissionMode: 'dontAsk' as const }
  if (job.skipMemory === true) config.bare = true
  else delete config.bare
  const next: CliRuntimeBase = {
    ...rest,
    surface: 'headless',
    lockHolderName: 'cron',
    lockHolderId: runtime.lockHolderId ?? crypto.randomUUID(),
    config,
    cwd: job.cwd,
  }
  if (job.verifyOnStop === true) next.verifyOnStop = true
  else delete next.verifyOnStop
  return next
}

export type FireCronJobHooks = {
  openNewSession?: (runtime: CliRuntimeBase, opts?: { sessionId?: string }) => Promise<CliRuntime>
  runExec?: (opts: RunExecOpts) => ReturnType<typeof runExec>
  runPreScript?: typeof runCronPreScript
  delay?: (ms: number, onFire: () => void) => () => void
}

export async function runCronPreScript(opts: {
  script: string
  cwd: string
  config: ResolvedConfig
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const terminal = opts.config.terminal
  const backend = createTerminalBackend(terminal?.backend ?? 'local', {
    ...(terminal?.image !== undefined ? { image: terminal.image } : {}),
  })
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), PRE_SCRIPT_TIMEOUT_MS)
  try {
    const result = await backend.exec({
      command: opts.script,
      cwd: opts.cwd,
      timeoutMs: PRE_SCRIPT_TIMEOUT_MS,
      signal: ac.signal,
    })
    if (result.exitCode === 0) return { ok: true }
    const detail = result.stderr.trim() || result.stdout.trim()
    const suffix = detail === '' ? '' : `: ${detail}`
    return { ok: false, error: `preScript exited ${result.exitCode}${suffix}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `preScript failed: ${message}` }
  } finally {
    clearTimeout(timer)
  }
}

function defaultDelay(ms: number, onFire: () => void): () => void {
  const timer = setTimeout(onFire, ms)
  return () => clearTimeout(timer)
}

export async function fireCronJob(
  runtime: CliRuntimeBase,
  job: CronJob,
  hooks?: FireCronJobHooks,
): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  try {
    if (job.preScript !== undefined && job.preScript !== '') {
      const pre = await (hooks?.runPreScript ?? runCronPreScript)({
        script: job.preScript,
        cwd: job.cwd,
        config: runtime.config,
      })
      if (!pre.ok) return { ok: false, error: pre.error }
    }

    const open = hooks?.openNewSession ?? openNewSession
    const exec = hooks?.runExec ?? runExec
    const delay = hooks?.delay ?? defaultDelay
    const child = await open(cronFireSessionRuntime(runtime, job))
    const sessionId = child.engine.session.id
    let timedOut = false
    const cancelTimeout = delay(clampJobTimeoutMs(job.timeoutMs), () => {
      timedOut = true
      child.engine.abort()
    })
    try {
      const result = await exec({ prompt: job.prompt, engine: child.engine, write: () => {} })
      if (timedOut) return { ok: false, sessionId, error: 'timeout' }
      const ok = result.end.reason === 'completed'
      return {
        ok,
        sessionId,
        ...(ok ? {} : { error: result.end.reason }),
      }
    } catch (error) {
      if (timedOut) return { ok: false, sessionId, error: 'timeout' }
      return { ok: false, sessionId, error: error instanceof Error ? error.message : String(error) }
    } finally {
      cancelTimeout()
      await child.engine.close?.()
      await child.mcpCloser?.()
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
