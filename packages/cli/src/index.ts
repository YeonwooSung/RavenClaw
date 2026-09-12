import { createInterface } from 'node:readline'
import { createElement } from 'react'
import { render } from 'ink'
import { ensureHomeDir } from '@ravenclaw/core'
import { parseArgv } from './args'
import { HELP_TEXT, formatVersion } from './help'
import { runAcpStdio } from './acp-stdio'
import { App } from './app'
import { bootCli, openNewSession, resumeRuntime } from './engine'
import { runExec } from './exec'
import { SETUP_HINT, providerConfigured, runFirstRun } from './first-run'
import { readSecretLine } from './secret-input'
import {
  deleteCliSession,
  exportCliSession,
  formatResumeSessionLine,
  listCliSessions,
  resolveCliSessionId,
  showCliSession,
  titleCliSession,
} from './resume'
import { runOpenTuiApp } from './opentui-app'
import { formatPublicConfig } from './config-print'
import { completionsScript } from './completions'
import { formatMcpList, loadMcpServers } from './mcp-list'
import { formatMcpToolsReport } from './mcp-probe'
import { createSkill, deleteSkill } from './skill-new'
import { formatSkillsList } from './skills-list'
import { initProject } from './init'
import { doctorFailed, formatDoctorReport, probeLocalLlm, runDoctor } from './doctor'
import { searchCliSessions } from './search'
import { SMOKE_PROMPT, evaluateSmoke } from './smoke'
import { handleCronCli, runCronTick } from './cron-cmd'
import { fireCronJob } from './cron-fire'
import { runServe } from './serve'

export { parseArgv } from './args'
export { CLI_VERSION, HELP_TEXT, formatVersion } from './help'
export { handleSlashCommand, LEARN_PROMPT } from './commands'
export { formatStatusLine } from './status-line'
export { runExec } from './exec'
export { runAcpStdio } from './acp-stdio'
export { runOpenTuiApp } from './opentui-app'

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed
  try {
    parsed = parseArgv(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  if (parsed.cmd === 'help') {
    process.stdout.write(HELP_TEXT)
    return 0
  }
  if (parsed.cmd === 'version') {
    process.stdout.write(`${formatVersion()}\n`)
    return 0
  }

  if (parsed.cmd === 'resume' && (parsed.prompt === undefined || parsed.prompt.trim() === '')) {
    parsed = { ...parsed, cmd: 'sessions' }
  }

  if (parsed.cmd === 'sessions') {
    const rows = await listCliSessions()
    if (rows.length === 0) {
      process.stdout.write('no sessions\n')
      return 0
    }
    for (const row of rows) process.stdout.write(`${formatResumeSessionLine(row)}\n`)
    return 0
  }

  if (parsed.cmd === 'show') {
    const shown = await showCliSession(parsed.prompt ?? '')
    if ('error' in shown) {
      process.stderr.write(`${shown.error}\n`)
      return shown.error.startsWith('usage:') ? 2 : 1
    }
    process.stdout.write(`${shown.text}\n`)
    return 0
  }

  if (parsed.cmd === 'rm') {
    const deleted = await deleteCliSession(parsed.prompt ?? '')
    if ('error' in deleted) {
      process.stderr.write(`${deleted.error}\n`)
      return deleted.error.startsWith('usage:') ? 2 : 1
    }
    process.stdout.write(`deleted ${deleted.id.slice(0, 8)}\n`)
    return 0
  }

  if (parsed.cmd === 'resume') {
    const resolved = await resolveCliSessionId(parsed.prompt ?? '')
    if (typeof resolved !== 'string') {
      process.stderr.write(`${resolved.error}\n`)
      return resolved.error.startsWith('usage:') ? 2 : 1
    }
    try {
      const home = await ensureHomeDir()
      if (!providerConfigured(home, parsed.flags)) {
        if (!process.stdin.isTTY) {
          process.stderr.write(`${SETUP_HINT}\n`)
          return 1
        }
        if (!(await promptFirstRun(home))) return 1
      }
      const booted = await bootCli({ flags: parsed.flags, createSession: false, lockHolder: 'tui' })
      const runtime = await resumeRuntime(booted, resolved)
      process.stdout.write(`resumed ${resolved.slice(0, 8)}\n`)
      try {
        if (parsed.tui === 'opentui') return await runOpenTuiApp(runtime)
        const instance = render(createElement(App, { runtime }))
        await instance.waitUntilExit()
        return 0
      } finally {
        await runtime.engine.close?.()
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (parsed.cmd === 'skills') {
    const parts = (parsed.prompt ?? '').trim().split(/\s+/).filter((p) => p !== '')
    if (parts[0] === 'new') {
      const created = createSkill({
        name: parts.slice(1).join(' '),
        project: parsed.project === true,
      })
      if ('error' in created) {
        process.stderr.write(`${created.error}\n`)
        return 2
      }
      process.stdout.write(created.created ? `wrote ${created.path}\n` : `exists ${created.path}\n`)
      return 0
    }
    if (parts[0] === 'rm') {
      const deleted = deleteSkill({
        name: parts.slice(1).join(' '),
        project: parsed.project === true,
      })
      if ('error' in deleted) {
        process.stderr.write(`${deleted.error}\n`)
        return deleted.error.startsWith('usage:') ? 2 : 1
      }
      process.stdout.write(`deleted ${deleted.path}\n`)
      return 0
    }
    if (parts.length > 0) {
      process.stderr.write('usage: raven skills [new|rm <name>] [--project]\n')
      return 2
    }
    process.stdout.write(`${formatSkillsList()}\n`)
    return 0
  }

  if (parsed.cmd === 'cron') {
    const verb = (parsed.prompt ?? 'list').trim().split(/\s+/)[0]?.toLowerCase()
    if (verb !== 'tick' && verb !== 'watch') {
      const result = handleCronCli(parsed.prompt, process.cwd())
      process.stdout.write(result.text + (result.text.endsWith('\n') ? '' : '\n'))
      return result.code
    }
  }

  if (parsed.cmd === 'mcp') {
    const sub = (parsed.prompt ?? 'list').trim().toLowerCase()
    if (sub === 'tools' || sub === 'probe') {
      process.stdout.write(`${await formatMcpToolsReport(loadMcpServers())}\n`)
      return 0
    }
    if (sub !== '' && sub !== 'list') {
      process.stderr.write('usage: raven mcp [list|tools]\n')
      return 2
    }
    process.stdout.write(`${formatMcpList(loadMcpServers())}\n`)
    return 0
  }

  if (parsed.cmd === 'completions') {
    const script = completionsScript(parsed.prompt ?? '')
    if ('error' in script) {
      process.stderr.write(`${script.error}\n`)
      return 2
    }
    process.stdout.write(script.text)
    return 0
  }

  if (parsed.cmd === 'init') {
    const result = initProject(process.cwd())
    process.stdout.write(
      result.created ? `wrote ${result.path}\n` : `exists ${result.path}\n`,
    )
    return 0
  }

  if (parsed.cmd === 'config') {
    process.stdout.write(`${formatPublicConfig({ flags: parsed.flags })}\n`)
    return 0
  }

  if (parsed.cmd === 'doctor') {
    const checks = runDoctor()
    const local = await probeLocalLlm()
    if (local) checks.push(local)
    process.stdout.write(`${formatDoctorReport(checks)}\n`)
    return doctorFailed(checks) ? 1 : 0
  }

  if (parsed.cmd === 'title') {
    const titled = await titleCliSession(parsed.prompt ?? '')
    if ('error' in titled) {
      process.stderr.write(`${titled.error}\n`)
      return titled.error.startsWith('usage:') ? 2 : 1
    }
    process.stdout.write(`${titled.id.slice(0, 8)}  ${titled.title}\n`)
    return 0
  }

  if (parsed.cmd === 'export') {
    const exported = await exportCliSession(parsed.prompt ?? '')
    if ('error' in exported) {
      process.stderr.write(`${exported.error}\n`)
      return exported.error.startsWith('usage:') ? 2 : 1
    }
    process.stdout.write(exported.text)
    return 0
  }

  if (parsed.cmd === 'search') {
    const text = await searchCliSessions({
      query: parsed.prompt ?? '',
      all: parsed.all === true,
    })
    process.stdout.write(`${text}\n`)
    return text.startsWith('usage:') ? 2 : 0
  }

  if (parsed.cmd === 'setup') {
    const home = await ensureHomeDir()
    return (await promptFirstRun(home)) ? 0 : 1
  }

  if (
    parsed.cmd === 'acp' ||
    parsed.cmd === 'exec' ||
    parsed.cmd === 'smoke' ||
    parsed.cmd === 'cron' ||
    parsed.cmd === 'serve'
  ) {
    const home = await ensureHomeDir()
    if (!providerConfigured(home, parsed.flags)) {
      process.stderr.write(`${SETUP_HINT}\n`)
      return 1
    }
  }

  if (parsed.cmd === 'smoke') {
    try {
      const runtime = await bootCli({
        flags: parsed.flags,
        tools: [],
        maxRounds: 1,
        surface: 'headless',
        lockHolder: 'exec',
      })
      try {
        const result = await runExec({ prompt: SMOKE_PROMPT, engine: runtime.engine })
        const verdict = evaluateSmoke(result.text)
        process.stdout.write(`${verdict.detail}\n`)
        return verdict.code
      } finally {
        await runtime.engine.close?.()
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (parsed.cmd === 'acp') {
    try {
      await runAcpStdio({
        boot: async () => {
          const runtime = await bootCli({
            flags: parsed.flags,
            createSession: false,
            surface: 'headless',
            lockHolder: 'acp',
          })
          return {
            create: async (sessionId) => (await openNewSession(runtime, { sessionId })).engine,
            load: async (sessionId) => (await resumeRuntime(runtime, sessionId)).engine,
          }
        },
      })
      return 0
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (parsed.cmd === 'cron') {
    try {
      const runtime = await bootCli({
        flags: parsed.flags,
        createSession: false,
        surface: 'headless',
        lockHolder: 'cron',
      })
      const tickOnce = async () => {
        const text = await runCronTick({
          run: (job) => fireCronJob(runtime, job),
        })
        process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'))
      }
      const verb = (parsed.prompt ?? '').trim().split(/\s+/)[0]?.toLowerCase()
      if (verb === 'watch') {
        for (;;) {
          await tickOnce()
          await new Promise((resolve) => setTimeout(resolve, 15_000))
        }
      }
      await tickOnce()
      return 0
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (parsed.cmd === 'exec') {
    if (parsed.prompt === undefined || parsed.prompt === '') {
      process.stderr.write('usage: raven exec [--json] <prompt>\n')
      return 2
    }
    try {
      const runtime = await bootCli({ flags: parsed.flags, surface: 'headless', lockHolder: 'exec' })
      try {
        const execOpts: Parameters<typeof runExec>[0] = {
          prompt: parsed.prompt,
          engine: runtime.engine,
        }
        if (parsed.json) execOpts.json = true
        const result = await runExec(execOpts)
        return result.end.reason === 'completed' ? 0 : 1
      } finally {
        await runtime.engine.close?.()
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (parsed.cmd === 'serve') {
    try {
      return await runServe({ flags: parsed.flags })
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  try {
    const home = await ensureHomeDir()
    if (!providerConfigured(home, parsed.flags)) {
      if (!process.stdin.isTTY) {
        process.stderr.write(`${SETUP_HINT}\n`)
        return 1
      }
      if (!(await promptFirstRun(home))) return 1
    }
    const runtime = await bootCli({ flags: parsed.flags, lockHolder: 'tui' })
    try {
      if (parsed.cmd === 'interactive' && parsed.tui === 'opentui') {
        return await runOpenTuiApp(runtime)
      }
      const instance = render(createElement(App, { runtime }))
      await instance.waitUntilExit()
      return 0
    } finally {
      await runtime.engine.close?.()
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function promptFirstRun(home: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const write = (chunk: string) => {
    process.stdout.write(chunk)
  }
  try {
    return await runFirstRun({
      home,
      input: rl,
      write,
      readSecret: async () => {
        rl.pause()
        try {
          return await readSecretLine({ input: process.stdin, write })
        } finally {
          rl.resume()
        }
      },
    })
  } finally {
    rl.close()
  }
}

if (import.meta.main) {
  void main().then((code) => process.exit(code))
}
