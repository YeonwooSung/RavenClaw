import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import type { PermissionDecision } from '../types'
import { resolveExisting } from './modes'

const WRITE_TOOLS = new Set(['Edit', 'Write'])

export function safetyCheck(
  name: string,
  input: unknown,
  cwd: string,
): Extract<PermissionDecision, { behavior: 'deny' }> | undefined {
  if (!WRITE_TOOLS.has(name)) return undefined
  const raw = pathOf(input)
  if (raw === undefined) return undefined
  const resolved = resolveExisting(cwd, raw)
  const candidates = [raw, resolved, resolve(cwd, raw)]

  if (candidates.some(isGitDirWrite)) {
    return { behavior: 'deny', reason: 'safety', message: 'writes under .git/ are denied' }
  }
  if (candidates.some(isCredentialPath)) {
    return { behavior: 'deny', reason: 'safety', message: 'writes to credential files are denied' }
  }
  if (candidates.some((path) => isShellRc(path))) {
    return { behavior: 'deny', reason: 'safety', message: 'writes to shell rc files are denied' }
  }
  return undefined
}

function pathOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const path = (input as { path?: unknown }).path
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

function posix(path: string): string {
  return path.replace(/\\/g, '/')
}

function isGitDirWrite(path: string): boolean {
  return posix(path)
    .split('/')
    .includes('.git')
}

function isCredentialPath(path: string): boolean {
  const n = posix(path)
  const base = basename(n)
  if (base.endsWith('.pem')) return true
  const parts = n.split('/')
  const sshIdx = parts.lastIndexOf('.ssh')
  if (sshIdx >= 0 && base.startsWith('id_')) return true
  return false
}

function isShellRc(path: string): boolean {
  const n = posix(path)
  const home = posix(homedir())
  const rcs = [`${home}/.bashrc`, `${home}/.zshrc`]
  if (rcs.includes(n)) return true
  const base = basename(n)
  return base === '.bashrc' || base === '.zshrc'
}
