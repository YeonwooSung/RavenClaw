import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureHomeDir, ravenclawHome } from './home'

const ENV_KEY = 'RAVENCLAW_HOME'

let savedHome: string | undefined
const tempDirs: string[] = []

beforeEach(() => {
  savedHome = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (savedHome === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedHome
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('ravenclawHome', () => {
  test('unset RAVENCLAW_HOME ends with /.ravenclaw', () => {
    delete process.env.RAVENCLAW_HOME
    const home = ravenclawHome()
    expect(home.endsWith('/.ravenclaw')).toBe(true)
    expect(home).toBe(join(homedir(), '.ravenclaw'))
  })

  test('RAVENCLAW_HOME override uses that path', () => {
    const dir = tempDir('ravenclaw-home-override-')
    process.env.RAVENCLAW_HOME = dir
    expect(ravenclawHome()).toBe(dir)
  })
})

describe('ensureHomeDir', () => {
  test('creates the home directory', async () => {
    const parent = tempDir('ravenclaw-home-ensure-')
    const dir = join(parent, 'nested', 'home')
    process.env.RAVENCLAW_HOME = dir
    expect(existsSync(dir)).toBe(false)
    const created = await ensureHomeDir()
    expect(created).toBe(dir)
    expect(existsSync(dir)).toBe(true)
  })
})
