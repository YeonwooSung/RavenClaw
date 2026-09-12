import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatDiffPanel,
  formatGitDiff,
  loadGitDiff,
  mergeDiffFiles,
  parseDiffArg,
  parseUnifiedDiff,
} from './diff-cmd'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempCwd(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  expect(result.status).toBe(0)
}

function initGitRepo(cwd: string): void {
  runGit(cwd, ['init'])
  runGit(cwd, ['config', 'user.email', 'test@example.com'])
  runGit(cwd, ['config', 'user.name', 'Test'])
  runGit(cwd, ['config', 'commit.gpgsign', 'false'])
}

describe('formatGitDiff', () => {
  test('reports a missing git work tree', () => {
    const cwd = tempCwd('raven-diff-nongit-')
    expect(formatGitDiff(cwd)).toBe('not a git repository')
  })

  test('returns empty text for a clean repo', () => {
    const cwd = tempCwd('raven-diff-clean-')
    initGitRepo(cwd)
    runGit(cwd, ['commit', '--allow-empty', '-m', 'init'])
    expect(formatGitDiff(cwd)).toBe('')
  })

  test('includes unstaged and staged diffs and caps the body', () => {
    const cwd = tempCwd('raven-diff-git-')
    initGitRepo(cwd)
    writeFileSync(join(cwd, 'tracked.txt'), 'alpha\n')
    runGit(cwd, ['add', 'tracked.txt'])
    runGit(cwd, ['commit', '-m', 'init'])

    writeFileSync(join(cwd, 'tracked.txt'), 'beta\n')
    writeFileSync(join(cwd, 'staged.txt'), 'gamma\n')
    runGit(cwd, ['add', 'staged.txt'])

    const text = formatGitDiff(cwd)
    expect(text).toContain('tracked.txt')
    expect(text).toContain('-alpha')
    expect(text).toContain('+beta')
    expect(text).toContain('staged.txt')
    expect(text).toContain('+gamma')

    writeFileSync(join(cwd, 'huge.txt'), `${'x'.repeat(25_000)}\n`)
    runGit(cwd, ['add', 'huge.txt'])
    expect(formatGitDiff(cwd).length).toBe(20_000)

    const view = loadGitDiff(cwd)
    expect(view.kind).toBe('files')
    if (view.kind !== 'files') return
    const names = view.files.map((file) => file.path)
    expect(names).toContain('tracked.txt')
    expect(names).toContain('staged.txt')
    const tracked = view.files.find((file) => file.path === 'tracked.txt')
    const stagedFile = view.files.find((file) => file.path === 'staged.txt')
    expect(tracked?.unstaged).toBe(true)
    expect(tracked?.staged).toBe(false)
    expect(stagedFile?.staged).toBe(true)
    expect(stagedFile?.unstaged).toBe(false)
  })
})

describe('parseDiffArg', () => {
  test('toggle, close, 1-based select, and usage errors', () => {
    expect(parseDiffArg(undefined)).toEqual({ action: 'toggle' })
    expect(parseDiffArg('')).toEqual({ action: 'toggle' })
    expect(parseDiffArg('close')).toEqual({ action: 'close' })
    expect(parseDiffArg('2')).toEqual({ action: 'select', index: 1 })
    expect(parseDiffArg('0')).toEqual({ action: 'error', message: 'usage: /diff [n|close]' })
    expect(parseDiffArg('foo')).toEqual({ action: 'error', message: 'usage: /diff [n|close]' })
  })
})

describe('parseUnifiedDiff and mergeDiffFiles', () => {
  const unstagedPatch = [
    'diff --git a/tracked.txt b/tracked.txt',
    'index 111..222 100644',
    '--- a/tracked.txt',
    '+++ b/tracked.txt',
    '@@ -1 +1 @@',
    '-alpha',
    '+beta',
    '',
  ].join('\n')
  const stagedPatch = [
    'diff --git a/staged.txt b/staged.txt',
    'new file mode 100644',
    'index 000..333',
    '--- /dev/null',
    '+++ b/staged.txt',
    '@@ -0,0 +1 @@',
    '+gamma',
    '',
  ].join('\n')

  test('splits files and prefers +++ b/ path', () => {
    const files = parseUnifiedDiff(`${unstagedPatch}${stagedPatch}`, 'unstaged')
    expect(files.map((file) => file.path)).toEqual(['tracked.txt', 'staged.txt'])
    expect(files[0]?.unstaged).toBe(true)
    expect(files[0]?.staged).toBe(false)
  })

  test('merge marks a path that appears on both sides', () => {
    const unstaged = parseUnifiedDiff(unstagedPatch, 'unstaged')
    const sameStaged = parseUnifiedDiff(unstagedPatch, 'staged')
    const merged = mergeDiffFiles(unstaged, sameStaged)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.staged).toBe(true)
    expect(merged[0]?.unstaged).toBe(true)
    expect(merged[0]?.patch).toContain('-alpha')
  })
})

describe('formatDiffPanel', () => {
  test('not-repo and clean', () => {
    expect(formatDiffPanel({ kind: 'not-repo' })).toEqual(['not a git repository'])
    expect(formatDiffPanel({ kind: 'clean' })).toEqual(['no uncommitted changes'])
  })

  test('lists files, marks the selected row, and clips hunks', () => {
    const view = {
      kind: 'files' as const,
      files: [
        {
          path: 'a.ts',
          staged: false,
          unstaged: true,
          patch: ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '-old', '+new', ''].join(
            '\n',
          ),
        },
        {
          path: 'b.ts',
          staged: true,
          unstaged: false,
          patch: 'diff --git a/b.ts b/b.ts\n+only\n',
        },
      ],
    }
    const lines = formatDiffPanel(view, 0)
    expect(lines[0]).toBe('diff  2 files')
    expect(lines[1]).toBe('> a.ts  unstaged')
    expect(lines[2]).toBe('  b.ts  staged')
    expect(lines.join('\n')).toContain('-old')
    expect(lines.join('\n')).not.toContain('+only')

    const second = formatDiffPanel(view, 1)
    expect(second[1]).toBe('  a.ts  unstaged')
    expect(second[2]).toBe('> b.ts  staged')
    expect(second.join('\n')).toContain('+only')

    const clipped = formatDiffPanel(view, 0, 2)
    expect(clipped.at(-1)).toBe('… 3 more')
  })
})
