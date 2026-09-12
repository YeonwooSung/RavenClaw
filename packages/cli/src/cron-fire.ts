import { runExec } from './exec'
import { openNewSession, type CliRuntimeBase } from './engine'
import type { CronJob } from '@ravenclaw/core'

export function cronFireSessionRuntime(runtime: CliRuntimeBase, job: CronJob): CliRuntimeBase {
  const { engine: _engine, ...rest } = runtime as CliRuntimeBase & { engine?: unknown }
  return {
    ...rest,
    surface: 'headless',
    lockHolderName: 'cron',
    lockHolderId: runtime.lockHolderId ?? crypto.randomUUID(),
    config: { ...runtime.config, permissionMode: 'dontAsk' },
    cwd: job.cwd,
  }
}

export async function fireCronJob(
  runtime: CliRuntimeBase,
  job: CronJob,
): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  try {
    const child = await openNewSession(cronFireSessionRuntime(runtime, job))
    try {
      const result = await runExec({ prompt: job.prompt, engine: child.engine, write: () => {} })
      const ok = result.end.reason === 'completed'
      return {
        ok,
        sessionId: child.engine.session.id,
        ...(ok ? {} : { error: result.end.reason }),
      }
    } finally {
      await child.engine.close?.()
      await child.mcpCloser?.()
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
