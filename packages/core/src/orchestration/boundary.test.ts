import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const TOOLS_DIR = join(import.meta.dir, '..', 'tools')

/** `tools/agent.ts` is a re-export shim for the Agent tool, now in orchestration/. */
const SHIM = 'agent.ts'

function toolSources(dir = TOOLS_DIR): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...toolSources(full))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const files = toolSources().filter((f) => relative(TOOLS_DIR, f) !== SHIM)

/**
 * Tools allowed to read orchestration fields off ToolContext
 * (store, session, registerChildEngine, tasks, instructionFiles).
 * Adding a tool here is a deliberate decision.
 */
const ORCHESTRATION_ALLOWLIST = [
  'bash.ts', // ctx.tasks registers background shell tasks; ctx.store enqueues the completion mailbox notice
  'enter-worktree.ts', // ctx.store/ctx.session persist the session job (worktree) record
  'exit-worktree.ts', // ctx.store/ctx.session clear the persisted session job record
  'task.ts', // ctx.tasks backs the Task* background-task tools
  'todo.ts', // ctx.store persists the session todo list
]

describe('hand/brain boundary', () => {
  test('tools/ does not import session-engine or orchestration/', () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!)
      for (const spec of specs) {
        if (spec.includes('loop/session-engine') || /(^|\/)orchestration\//.test(spec)) {
          offenders.push(`${relative(TOOLS_DIR, f)} -> ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('only allowlisted tools read orchestration context fields', () => {
    const re = /\bctx\??\.(store|session|registerChildEngine|tasks|instructionFiles)\b/
    const users = files
      .filter((f) => re.test(readFileSync(f, 'utf8')))
      .map((f) => relative(TOOLS_DIR, f))
      .sort()
    expect(users).toEqual([...ORCHESTRATION_ALLOWLIST].sort())
  })
})
