import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const VERIFY_CAP = 8
const EXACT_SCRIPTS = ['test', 'lint', 'typecheck', 'check', 'fmt', 'format', 'tsc'] as const
const PREFIX_SCRIPT = /^(test|lint):/

type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm' | 'cargo' | 'go' | 'python'

const MANIFESTS: ReadonlyArray<{ files: readonly string[]; manager: PackageManager }> = [
  { files: ['bun.lock', 'bun.lockb'], manager: 'bun' },
  { files: ['pnpm-lock.yaml'], manager: 'pnpm' },
  { files: ['yarn.lock'], manager: 'yarn' },
  { files: ['package-lock.json'], manager: 'npm' },
  { files: ['Cargo.toml'], manager: 'cargo' },
  { files: ['go.mod'], manager: 'go' },
  { files: ['pyproject.toml', 'requirements.txt'], manager: 'python' },
]

export function loadCodingPosture(cwd: string): string {
  if (cwd.length === 0) return ''
  const manager = detectPackageManager(cwd)
  const verifies = collectVerifyCommands(cwd, manager)
  if (manager === undefined && verifies.length === 0) return ''
  const lines: string[] = []
  if (manager !== undefined) lines.push(`package manager: ${manager}`)
  for (const command of verifies) lines.push(`verify: ${command}`)
  return lines.join('\n')
}

function detectPackageManager(cwd: string): PackageManager | undefined {
  for (const spec of MANIFESTS) {
    for (const file of spec.files) {
      if (isFile(join(cwd, file))) return spec.manager
    }
  }
  return undefined
}

function collectVerifyCommands(cwd: string, manager: PackageManager | undefined): string[] {
  const out: string[] = []
  if (manager === 'cargo') out.push('cargo test')
  else if (manager === 'go') out.push('go test ./...')
  if (out.length >= VERIFY_CAP) return out.slice(0, VERIFY_CAP)
  out.push(...packageJsonVerifies(cwd, manager).slice(0, VERIFY_CAP - out.length))
  return out
}

function packageJsonVerifies(cwd: string, manager: PackageManager | undefined): string[] {
  const scripts = readScripts(cwd)
  if (scripts === undefined) return []
  const runner = jsRunner(manager)
  return selectScriptNames(scripts).map((name) => formatJsVerify(runner, name))
}

function selectScriptNames(scripts: Record<string, unknown>): string[] {
  const exact = EXACT_SCRIPTS.filter((name) => Object.hasOwn(scripts, name))
  const prefixed = Object.keys(scripts)
    .filter((name) => PREFIX_SCRIPT.test(name))
    .sort()
  return [...exact, ...prefixed].slice(0, VERIFY_CAP)
}

function formatJsVerify(runner: 'bun' | 'pnpm' | 'yarn' | 'npm', name: string): string {
  if (runner === 'bun' && name === 'test') return 'bun test'
  if (runner === 'bun') return `bun run ${name}`
  if (runner === 'pnpm') return `pnpm run ${name}`
  if (runner === 'yarn') return `yarn run ${name}`
  return `npm run ${name}`
}

function jsRunner(manager: PackageManager | undefined): 'bun' | 'pnpm' | 'yarn' | 'npm' {
  if (manager === 'bun' || manager === 'pnpm' || manager === 'yarn' || manager === 'npm') {
    return manager
  }
  return 'npm'
}

function readScripts(cwd: string): Record<string, unknown> | undefined {
  let raw: string
  try {
    raw = readFileSync(join(cwd, 'package.json'), 'utf8')
  } catch {
    return undefined
  }
  let data: unknown
  try {
    data = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const scripts = (data as { scripts?: unknown }).scripts
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return undefined
  return scripts as Record<string, unknown>
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}
