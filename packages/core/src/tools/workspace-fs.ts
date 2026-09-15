import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { sep } from 'node:path'
import { resolveExisting } from '../permissions/modes'

export type WorkspaceFs = {
  readFile(path: string): string
  writeFile(path: string, content: string): void
  mkdir(path: string): void
  unlink(path: string): void
  stat(path: string): {
    exists: boolean
    isFile: boolean
    isDir: boolean
    mtimeMs: number
    size: number
  }
  readdir(path: string): Array<{ name: string; isFile: boolean; isDir: boolean }>
  realpath(path: string): string
}

export function createWorkspaceFs(opts: {
  cwd: string
  backend: 'local' | 'docker'
}): WorkspaceFs {
  // backend is reserved for a later exec port; v1 is host node:fs + cwd jail.
  const root = realpathSync(opts.cwd)

  function jailed(path: string): string {
    const resolved = resolveExisting(root, path)
    if (!isInsideRoot(resolved, root)) {
      throw new Error('outside workspace')
    }
    return resolved
  }

  return {
    readFile(path) {
      return readFileSync(jailed(path), 'utf8')
    },
    writeFile(path, content) {
      writeFileSync(jailed(path), content, 'utf8')
    },
    mkdir(path) {
      mkdirSync(jailed(path), { recursive: true })
    },
    unlink(path) {
      unlinkSync(jailed(path))
    },
    stat(path) {
      const target = jailed(path)
      try {
        const st = statSync(target)
        return {
          exists: true,
          isFile: st.isFile(),
          isDir: st.isDirectory(),
          mtimeMs: st.mtimeMs,
          size: st.size,
        }
      } catch {
        return { exists: false, isFile: false, isDir: false, mtimeMs: 0, size: 0 }
      }
    },
    readdir(path) {
      return readdirSync(jailed(path), { withFileTypes: true }).map((ent) => ({
        name: ent.name,
        isFile: ent.isFile(),
        isDir: ent.isDirectory(),
      }))
    },
    realpath(path) {
      return realpathSync(jailed(path))
    },
  }
}

function isInsideRoot(resolved: string, root: string): boolean {
  if (resolved === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return resolved.startsWith(prefix)
}
