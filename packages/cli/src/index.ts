import { createInterface } from 'node:readline'
import { createElement } from 'react'
import { render } from 'ink'
import { ensureHomeDir } from '@ravenclaw/core'
import { parseArgv } from './args'
import { HELP_TEXT, formatVersion } from './help'
import { runAcpStdio } from './acp-stdio'
import { App } from './app'
import { bootCli } from './engine'
import { runExec } from './exec'
import { SETUP_HINT, providerConfigured, runFirstRun } from './first-run'
import { runOpenTuiApp } from './opentui-app'

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

  if (parsed.cmd === 'setup') {
    const home = await ensureHomeDir()
    return (await promptFirstRun(home)) ? 0 : 1
  }

  if (parsed.cmd === 'acp' || parsed.cmd === 'exec') {
    const home = await ensureHomeDir()
    if (!providerConfigured(home, parsed.flags)) {
      process.stderr.write(`${SETUP_HINT}\n`)
      return 1
    }
  }

  if (parsed.cmd === 'acp') {
    try {
      await runAcpStdio({
        boot: () => bootCli({ flags: parsed.flags }),
      })
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
      const runtime = await bootCli({ flags: parsed.flags })
      const execOpts: Parameters<typeof runExec>[0] = {
        prompt: parsed.prompt,
        engine: runtime.engine,
      }
      if (parsed.json) execOpts.json = true
      const result = await runExec(execOpts)
      return result.end.reason === 'completed' ? 0 : 1
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
    const runtime = await bootCli({ flags: parsed.flags })
    if (parsed.cmd === 'interactive' && parsed.tui === 'opentui') {
      return await runOpenTuiApp(runtime)
    }
    const instance = render(createElement(App, { runtime }))
    await instance.waitUntilExit()
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function promptFirstRun(home: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  try {
    return await runFirstRun({
      home,
      input: rl,
      write: (chunk) => {
        process.stdout.write(chunk)
      },
    })
  } finally {
    rl.close()
  }
}

if (import.meta.main) {
  void main().then((code) => process.exit(code))
}
