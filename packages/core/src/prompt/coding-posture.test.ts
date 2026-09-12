import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCodingPosture } from './coding-posture'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-posture-'))
  tempDirs.push(dir)
  return dir
}

function writeScripts(dir: string, scripts: Record<string, string>): void {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ scripts })}\n`)
}

describe('loadCodingPosture', () => {
  test('empty cwd and empty directory return empty string', () => {
    expect(loadCodingPosture('')).toBe('')
    expect(loadCodingPosture(tempDir())).toBe('')
  })

  test('bun.lock plus package.json scripts uses bun runner', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'bun.lock'), '')
    writeScripts(dir, { test: 'echo test', lint: 'echo lint', build: 'echo build' })
    expect(loadCodingPosture(dir)).toBe(
      ['package manager: bun', 'verify: bun test', 'verify: bun run lint'].join('\n'),
    )
  })

  test('bun.lockb is treated as bun', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'bun.lockb'), '')
    writeScripts(dir, { test: 'echo test' })
    expect(loadCodingPosture(dir)).toContain('package manager: bun')
    expect(loadCodingPosture(dir)).toContain('verify: bun test')
  })

  test('pnpm, yarn, and npm lockfiles select the first matching manager', () => {
    const pnpm = tempDir()
    writeFileSync(join(pnpm, 'pnpm-lock.yaml'), '')
    writeScripts(pnpm, { test: 'x' })
    expect(loadCodingPosture(pnpm)).toBe(['package manager: pnpm', 'verify: pnpm run test'].join('\n'))

    const yarn = tempDir()
    writeFileSync(join(yarn, 'yarn.lock'), '')
    writeScripts(yarn, { lint: 'x' })
    expect(loadCodingPosture(yarn)).toBe(['package manager: yarn', 'verify: yarn run lint'].join('\n'))

    const npm = tempDir()
    writeFileSync(join(npm, 'package-lock.json'), '{}')
    writeScripts(npm, { typecheck: 'x' })
    expect(loadCodingPosture(npm)).toBe(
      ['package manager: npm', 'verify: npm run typecheck'].join('\n'),
    )
  })

  test('first lockfile match wins over later manifests', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'bun.lock'), '')
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n')
    writeScripts(dir, { test: 'x' })
    expect(loadCodingPosture(dir)).toContain('package manager: bun')
    expect(loadCodingPosture(dir)).not.toContain('cargo')
    expect(loadCodingPosture(dir)).not.toContain('npm')
  })

  test('Cargo.toml and go.mod emit their default verify commands', () => {
    const cargo = tempDir()
    writeFileSync(join(cargo, 'Cargo.toml'), '[package]\nname = "x"\n')
    expect(loadCodingPosture(cargo)).toBe(['package manager: cargo', 'verify: cargo test'].join('\n'))

    const go = tempDir()
    writeFileSync(join(go, 'go.mod'), 'module example.com/x\n')
    expect(loadCodingPosture(go)).toBe(['package manager: go', 'verify: go test ./...'].join('\n'))
  })

  test('pyproject.toml and requirements.txt detect python without a verify command', () => {
    const py = tempDir()
    writeFileSync(join(py, 'pyproject.toml'), '[project]\nname = "x"\n')
    expect(loadCodingPosture(py)).toBe('package manager: python')

    const req = tempDir()
    writeFileSync(join(req, 'requirements.txt'), 'pytest\n')
    expect(loadCodingPosture(req)).toBe('package manager: python')
  })

  test('includes exact verify scripts plus test:* and lint:*, caps at 8', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'bun.lock'), '')
    writeScripts(dir, {
      build: 'x',
      start: 'x',
      test: 'x',
      lint: 'x',
      typecheck: 'x',
      check: 'x',
      fmt: 'x',
      format: 'x',
      tsc: 'x',
      'test:unit': 'x',
      'lint:fix': 'x',
      'test:e2e': 'x',
    })
    const lines = loadCodingPosture(dir).split('\n')
    expect(lines[0]).toBe('package manager: bun')
    expect(lines.slice(1)).toHaveLength(8)
    expect(lines.slice(1)).toEqual([
      'verify: bun test',
      'verify: bun run lint',
      'verify: bun run typecheck',
      'verify: bun run check',
      'verify: bun run fmt',
      'verify: bun run format',
      'verify: bun run tsc',
      'verify: bun run lint:fix',
    ])
    expect(loadCodingPosture(dir)).not.toContain('build')
    expect(loadCodingPosture(dir)).not.toContain('start')
    expect(loadCodingPosture(dir)).not.toContain('test:e2e')
  })

  test('invalid or missing package.json scripts are ignored', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'bun.lock'), '')
    writeFileSync(join(dir, 'package.json'), '{not json')
    expect(loadCodingPosture(dir)).toBe('package manager: bun')
  })
})
