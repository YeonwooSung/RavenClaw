import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

const CAFFEINATE_SECS = 300
const RESTART_BEFORE_MS = 30_000

export type PreventSleepSpawn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess

export interface PreventSleepOptions {
  platform?: NodeJS.Platform
  spawn?: PreventSleepSpawn
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

export interface PreventSleepController {
  start(): void
  stop(): void
}

export function createPreventSleep(opts: PreventSleepOptions = {}): PreventSleepController {
  const platform = opts.platform ?? process.platform
  const spawnFn = opts.spawn ?? (spawn as PreventSleepSpawn)
  const schedule = opts.setTimeout ?? setTimeout
  const cancel = opts.clearTimeout ?? clearTimeout
  let refs = 0
  let child: ChildProcess | undefined
  let restartTimer: ReturnType<typeof setTimeout> | undefined

  const killChild = () => {
    if (!child) return
    try {
      child.kill()
    } catch {
      // already gone
    }
    child = undefined
  }

  const launch = () => {
    if (platform !== 'darwin') return
    try {
      child = spawnFn('caffeinate', ['-i', '-t', String(CAFFEINATE_SECS)], {
        stdio: 'ignore',
      })
      child.on('error', () => {
        child = undefined
      })
      child.on('exit', () => {
        child = undefined
      })
    } catch {
      child = undefined
    }
  }

  const armRestart = () => {
    cancel(restartTimer)
    if (refs <= 0 || platform !== 'darwin') return
    restartTimer = schedule(() => {
      if (refs <= 0) return
      killChild()
      launch()
      armRestart()
    }, CAFFEINATE_SECS * 1000 - RESTART_BEFORE_MS)
    restartTimer.unref?.()
  }

  const disarm = () => {
    cancel(restartTimer)
    restartTimer = undefined
    killChild()
  }

  return {
    start() {
      refs += 1
      if (refs === 1) {
        launch()
        armRestart()
      }
    },
    stop() {
      if (refs === 0) return
      refs -= 1
      if (refs === 0) disarm()
    },
  }
}

const shared = createPreventSleep()

export function startPreventSleep(): void {
  shared.start()
}

export function stopPreventSleep(): void {
  shared.stop()
}

function onProcessExit(): void {
  try {
    stopPreventSleep()
  } catch {
    // process is leaving
  }
}

process.once('exit', onProcessExit)
