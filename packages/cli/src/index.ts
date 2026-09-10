import { createElement } from 'react'
import { render } from 'ink'
import { parseArgv } from './args'
import { App } from './app'
import { bootCli } from './engine'
import { runExec } from './exec'

export { parseArgv } from './args'
export { handleSlashCommand, LEARN_PROMPT } from './commands'
export { formatStatusLine } from './status-line'
export { runExec } from './exec'

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed
  try {
    parsed = parseArgv(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
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
    const runtime = await bootCli({ flags: parsed.flags })
    const instance = render(createElement(App, { runtime }))
    await instance.waitUntilExit()
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (import.meta.main) {
  void main().then((code) => process.exit(code))
}
