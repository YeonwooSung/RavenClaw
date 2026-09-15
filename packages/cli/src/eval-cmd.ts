import { DEFAULT_EVAL_FIXTURES_DIR, runEvalDir } from '@ravenclaw/core'

export async function runEvalCmd(dir?: string): Promise<number> {
  const target = dir !== undefined && dir.trim() !== '' ? dir : DEFAULT_EVAL_FIXTURES_DIR
  try {
    await runEvalDir(target)
    process.stdout.write(`ok  eval ${target}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
