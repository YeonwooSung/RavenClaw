import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function readPackageVersion(fromMetaUrl: string): string {
  let dir = dirname(fileURLToPath(fromMetaUrl))
  for (let i = 0; i < 6; i++) {
    const path = join(dir, 'package.json')
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
        if (typeof data.version === 'string' && data.version !== '') return data.version
      } catch {
        /* keep walking */
      }
    }
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return '0.0.0'
}
