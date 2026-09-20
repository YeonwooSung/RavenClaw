# jobDiff parallel flake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate git spawn env so `jobDiff` (and the serve `/diff` fixture) ignore foreign `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`. The parallel `GET /v1/session/:id/diff with a job returns jobDiff` flake goes away without mocking git or weakening assertions.

**Architecture:** Production `runGit` copies `process.env`, keeps `PATH`, sets `GIT_TERMINAL_PROMPT=0`, deletes `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`, then `spawnSync`s with that env and the existing unique `cwd`. Serve tests use the same recipe via a local `gitRun` helper. `jobDiff` stays a store-free parser of real git output.

**Tech Stack:** Bun, TypeScript, existing `spawnSync` + `jobDiff`.

**Spec:** `docs/superpowers/specs/2026-09-20-jobdiff-parallel-flake.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer for operator answers.
- Default prefix stays small and frozen. No new always-on tool. Job diff stays a **host / session op**, not a tool.
- `dontAsk` never becomes `bypass`.
- BYOK is the product. Ads never touch BYOK.
- Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
- `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
- Leftover-ask still wins rewind. Edit-resubmit stays host composition.
- `jobDiff(job)` stays store-free. Do not add `store`. Do not call `maybeFinishRewindReset` from the helper.
- Do not change JobDiff shape, serve `/diff` semantics, or `maybeFinishRewindReset`.
- No schema bump. No new route. Do not mock git. Do not weaken `/diff` assertions.
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push.

### Plan rulings

The spec stays the product authority. These lines resolve underspecification only.

1. **Sanitize in `runGit` itself**, not in `jobDiff`. `job-diff.ts` does not grow an env helper. Local function inside `session-worktree.ts` is fine; do not export a new public API.

2. **Env recipe (production and tests, copy locally — do not share a module):**

```ts
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
delete env.GIT_DIR
delete env.GIT_WORK_TREE
delete env.GIT_INDEX_FILE
```

`PATH` stays because `process.env` is copied. Do not hardcode `PATH`. Do not delete other `GIT_*` vars.

3. **Keep `GIT_TIMEOUT_MS` and the catch mapping.** Timeout stays 30s. Catch still returns `{ ok: false, stdout: '', stderr: '' }`. `fail()` notice stays `stderr || stdout || 'git failed'`.

4. **Unit test mutates `process.env` only around the `jobDiff` call** and restores in `finally` (including `undefined` → `delete`). Build the real repo *before* setting the foreign vars. Also point `job-diff.test.ts` `initRepo` / `git` spawns at the same recipe so a parallel sibling in that file is not poisoned.

5. **Serve `gitRun` replaces every `spawnSync('git', …)` in `serve.test.ts`**, including `tempGitRepo` and the rewind-reset stub. Existing `/diff` expectations stay byte-for-byte the same.

6. **Stress loop is verification, not a unit test.** After Task 2: 10 sequential full-file runs of `bun test ./packages/cli/src/serve.test.ts`. Spec “done when” is 20× under that parallel file run plus once alone. Do not add a loop inside the test file.

7. **Out of both tasks:** `packages/core/src/tools/worktree.ts` `runGit`, `packages/cli/src/diff-cmd.ts` env, JobDiff parser, serve `/diff` handler, `maybeFinishRewindReset`.

## File map

| File | Role |
|---|---|
| `packages/core/src/tools/session-worktree.ts` | production `runGit` sanitized env |
| `packages/core/src/session/job-diff.test.ts` | `jobDiff ignores foreign GIT_DIR`; sanitize local git helpers |
| `packages/cli/src/serve.test.ts` | `gitRun` helper; all git spawns |

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 `runGit` + unit test | `session-worktree.ts` (`runGit` only), `job-diff.test.ts` |
| 2 serve `gitRun` | `serve.test.ts` git spawns only |

Task 1 before Task 2.

---

### Task 1: Sanitize production `runGit` + `jobDiff ignores foreign GIT_DIR`

**Files:**
- Modify: `packages/core/src/tools/session-worktree.ts`, `packages/core/src/session/job-diff.test.ts`

**Interfaces:**
- Consumes: `spawnSync('git', args, { cwd, encoding, timeout, env })`
- Produces: `runGit` still `{ ok, stdout, stderr }`; catch still empty strings; `jobDiff` still store-free

- [ ] **Step 1: Write the failing test**

In `packages/core/src/session/job-diff.test.ts`, keep existing cases. Point `initRepo` / `git` at a local sanitized env (same recipe as ruling 2) so this file stays deterministic, **then** add:

```ts
test('jobDiff ignores foreign GIT_DIR', () => {
  const repo = initRepo()
  const base = revParse(repo)
  write(repo, 'new.ts', 'hello\n')
  git(repo, ['add', 'new.ts'])
  git(repo, ['commit', '-m', 'add'])
  write(repo, 'dirty.txt', 'x\n')

  const foreign = join(tempDir('ravenclaw-job-diff-foreign-'), 'not-a-git')
  const prevDir = process.env.GIT_DIR
  const prevWorkTree = process.env.GIT_WORK_TREE
  const prevIndex = process.env.GIT_INDEX_FILE
  process.env.GIT_DIR = foreign
  process.env.GIT_WORK_TREE = tempDir('ravenclaw-job-diff-wt-')
  process.env.GIT_INDEX_FILE = join(tempDir('ravenclaw-job-diff-index-'), 'index')
  try {
    const diff = jobDiff({
      baseBranch: 'main',
      shadowBranch: 'raven/t',
      baseCommitSha: base,
      worktreePath: repo,
    })
    expect(diff.ok).toBe(true)
    if (!diff.ok) return
    expect(diff.dirty).toBe(true)
    expect(diff.files.some((f) => f.path === 'new.ts' && f.op === 'create')).toBe(true)
    expect(diff.files.some((f) => f.path === 'dirty.txt' && f.op === 'create')).toBe(true)
  } finally {
    if (prevDir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = prevDir
    if (prevWorkTree === undefined) delete process.env.GIT_WORK_TREE
    else process.env.GIT_WORK_TREE = prevWorkTree
    if (prevIndex === undefined) delete process.env.GIT_INDEX_FILE
    else process.env.GIT_INDEX_FILE = prevIndex
  }
})
```

Sanitized helper shape (do not import from `session-worktree`):

```ts
function gitSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  return env
}
```

Pass `env: gitSpawnEnv()` into the existing `initRepo` / `git` `spawnSync` calls. Do not mock `jobDiff`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/yeonwoosung/Desktop/RavenClaw/.worktrees/jobdiff-flake
bun test ./packages/core/src/session/job-diff.test.ts
```

Expected: FAIL — `jobDiff ignores foreign GIT_DIR` sees `ok: false` (or the foreign tree) because `runGit` inherits `GIT_DIR`. Existing cases still pass (helpers now ignore the foreign vars).

- [ ] **Step 3: Sanitize production `runGit`**

In `packages/core/src/tools/session-worktree.ts`, change only `runGit`:

```ts
export function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    delete env.GIT_DIR
    delete env.GIT_WORK_TREE
    delete env.GIT_INDEX_FILE
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      env,
    })
    return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } catch {
    return { ok: false, stdout: '', stderr: '' }
  }
}
```

Do not change `job-diff.ts`. Do not export the env object.

- [ ] **Step 4: Re-run tests**

```bash
cd /Users/yeonwoosung/Desktop/RavenClaw/.worktrees/jobdiff-flake
bun test ./packages/core/src/session/job-diff.test.ts
```

Expected: PASS, including `jobDiff ignores foreign GIT_DIR` and the existing create/rename/missing/staged cases.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/session-worktree.ts packages/core/src/session/job-diff.test.ts
git commit -m "$(cat <<'EOF'
fix: isolate runGit env from foreign GIT_DIR

jobDiff must use job.worktreePath even when the process inherited
GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE. Copy PATH, set
GIT_TERMINAL_PROMPT=0, drop those three vars.
EOF
)"
```

---

### Task 2: Serve test `gitRun` helper

**Files:**
- Modify: `packages/cli/src/serve.test.ts`

**Interfaces:**
- Consumes: `spawnSync('git', args, { cwd, encoding, env })`
- Produces: same `/diff` body assertions as today

- [ ] **Step 1: Add `gitRun` and route every git spawn through it**

Near `tempGitRepo` in `packages/cli/src/serve.test.ts`:

```ts
function gitSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  return env
}

function gitRun(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: gitSpawnEnv() })
}
```

Replace `tempGitRepo`’s inner `run`:

```ts
function tempGitRepo(dirty = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-serve-pr-'))
  serveTempDirs.push(dir)
  const run = (args: string[]) => {
    const result = gitRun(dir, args)
    expect(result.status).toBe(0)
  }
  run(['init'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'commit.gpgsign', 'false'])
  run(['commit', '--allow-empty', '-m', 'init'])
  if (dirty) writeFileSync(join(dir, 'dirty.txt'), 'x\n')
  return dir
}
```

In `GET /v1/session/:id/diff with a job returns jobDiff` replace the bare `spawnSync('git', …)` calls with `gitRun` **without changing expectations**:

```ts
test('GET /v1/session/:id/diff with a job returns jobDiff', async () => {
  const cwd = tempGitRepo(false)
  const base = gitRun(cwd, ['rev-parse', 'HEAD']).stdout.trim()
  writeFileSync(join(cwd, 'new.ts'), 'hello\n')
  gitRun(cwd, ['add', 'new.ts'])
  gitRun(cwd, ['commit', '-m', 'add new'])
  writeFileSync(join(cwd, 'dirty.txt'), 'x\n')

  const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
  const runtime = await ctx.runtimeForSession('s1')
  if (!runtime) throw new Error('expected runtime')
  runtime.engine.session = {
    id: 's1',
    permissionMode: 'default',
    job: {
      baseBranch: 'main',
      shadowBranch: 'raven/s',
      baseCommitSha: base,
      worktreePath: cwd,
    },
  }

  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/diff', {
      headers: { authorization: 'Bearer secret' },
    }),
    ctx,
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    baseCommitSha?: string
    shadowBranch?: string
    dirty?: boolean
    files?: Array<{ path: string; op: string }>
    notice?: string
  }
  expect(body.ok).toBe(true)
  expect(body.baseCommitSha).toBe(base)
  expect(body.shadowBranch).toBe('raven/s')
  expect(body.dirty).toBe(true)
  expect(body.files?.some((f) => f.path === 'new.ts' && f.op === 'create')).toBe(true)
  expect(body.files?.some((f) => f.path === 'dirty.txt' && f.op === 'create')).toBe(true)
})
```

In `GET /v1/session/:id/diff finishes a pending rewind reset` use `gitRun` for `rev-parse`, `add`, `commit`, the stub `reset --hard`, and the final HEAD check. Keep `expect(later).not.toBe(base)` and the final HEAD `toBe(base)`.

Grep the file: no remaining `spawnSync('git'`. `/pr` tests keep using `tempGitRepo` (now isolated). Do not mock `jobDiff`. Do not drop `ok: true` / `new.ts` / `dirty.txt` asserts.

- [ ] **Step 2: Run the serve file (this is the fail-the-fixture check if any spawn was missed)**

```bash
cd /Users/yeonwoosung/Desktop/RavenClaw/.worktrees/jobdiff-flake
bun test ./packages/cli/src/serve.test.ts
```

Expected: PASS. If a leftover bare `spawnSync('git'` still inherits a foreign `GIT_DIR` in this worktree, the `/diff` test fails `ok: true` — fix by routing it through `gitRun`, do not weaken.

- [ ] **Step 3: Stress loop (verification, not a unit test)**

```bash
cd /Users/yeonwoosung/Desktop/RavenClaw/.worktrees/jobdiff-flake
for i in $(seq 1 10); do
  bun test ./packages/cli/src/serve.test.ts || exit 1
done
bun test ./packages/cli/src/serve.test.ts -t "GET /v1/session/:id/diff with a job returns jobDiff"
```

Expected: all 10 full-file runs pass (bun already parallelizes inside the file). The isolated `-t` run also passes. Spec done-when is 20× of the full file; run the extra 10 if the first 10 are green and time allows, same command.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/serve.test.ts
git commit -m "$(cat <<'EOF'
test: isolate serve git spawns from foreign GIT_DIR

tempGitRepo and /diff fixtures must not inherit GIT_DIR from the
parent worktree under parallel bun test. Same env recipe as runGit.
EOF
)"
```
