# RavenClaw jobDiff parallel flake (sanitize `runGit` env)

Date: 2026-09-20  
Status: implemented  
Shipped sha: `2c2f009` on `main` (original `session-worktree.ts` `runGit` hole). Sibling `worktree.ts` / `diff-cmd.ts` `runGit` are amended by this worktree.  
Reviewed against tree at `a707249` (`origin/main` after parent tree-stop + docs honesty + truncation persist-count).  
Does not reopen G3.1 / G3.2 product doors from [`2026-09-17-job-host-state-roadmap.md`](2026-09-17-job-host-state-roadmap.md). Job diff stays `base...HEAD` ∪ dirty, store-free `jobDiff(job)`.

Implementation plan: [2026-09-20-jobdiff-parallel-flake.md](../plans/2026-09-20-jobdiff-parallel-flake.md). Isolated worktree only.

Sources: current tree. No new steal from eve/y0.

---

## Where we are

G3.1 shipped: `jobDiff` is a store-free helper of `SessionJob`. Serve `GET /v1/session/:id/diff` awaits `maybeFinishRewindReset` then calls `jobDiff(job)`. No job → `{ ok: false, notice: 'no job record' }`. Git failure → `{ ok: false, notice }`. Shape is `create | update | delete | rename` plus plus/minus.

The helper lives in `packages/core/src/session/job-diff.ts` and talks to git only through `runGit` in `packages/core/src/tools/session-worktree.ts`. `runGit` sanitizes spawn env:

```ts
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
delete env.GIT_DIR
delete env.GIT_WORK_TREE
delete env.GIT_INDEX_FILE
spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env })
```

`cwd` is `job.worktreePath`. Spawn throw (including ENOENT) is mapped to `{ ok: false, stdout: '', stderr: '' }`, so `jobDiff` notices `'git failed'`.

`packages/cli/src/serve.test.ts` test `GET /v1/session/:id/diff with a job returns jobDiff` (~1979) builds a unique `tempGitRepo` (`mkdtempSync`), commits `new.ts`, writes dirty `dirty.txt`, then hits `/diff`. Under **parallel** `bun test` it **sometimes** fails with git spawn **ENOENT** or **timeout**. The same test **passes alone**. Sibling `GET /v1/session/:id/diff finishes a pending rewind reset` (~2024) uses the same helper. `tempGitRepo` is already unique — that is not the hole.

This is a production honesty bug that the parallel test happens to trip. It is not a new product surface.

---

## The flake (diagnosed)

Git env vars override `cwd`. `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_INDEX_FILE` from `process.env` win over the unique temp repo. Parallel `bun test` inherits them from the parent (this checkout is a git worktree) and from sibling git spawns that contend on the same foreign dir: index.lock → hang until `GIT_TIMEOUT_MS` (30s); missing/deleted foreign dir → ENOENT or non-zero. `runGit` then returns `{ ok: false }` with empty stderr.

The serve test’s own `spawnSync('git', …)` calls (fixture setup + the rewind-reset stub) have the same hole: no `env`, so fixture `git init` / `commit` / `rev-parse` can also talk to a foreign repo.

`diff-cmd.ts` used to set `env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }` but still inherit `GIT_DIR`. `packages/core/src/tools/worktree.ts` `runGit` was the same class of hole. Both are now **in** with the same env sanitization (copy `process.env`, `GIT_TERMINAL_PROMPT=0`, delete `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`).

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

1. **Locked fix: sanitize spawn env.** Production `runGit` (`session-worktree.ts`, `worktree.ts`, `diff-cmd.ts`) **and** every git `spawnSync` in `serve.test.ts` copy `process.env`, keep `PATH`, set `GIT_TERMINAL_PROMPT=0`, and **delete** `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`. Unique `cwd` already exists; env is what makes it win.
2. **Do not mock git.** Do not rewrite `jobDiff` as a parser of mocked strings. Prefer making the spawn deterministic under parallel bun test. Mock only if env sanitization is proven insufficient — that would be a new spec.
3. **Do not weaken assertions.** `GET /v1/session/:id/diff with a job returns jobDiff` still expects `ok: true`, `baseCommitSha`, `shadowBranch`, `dirty: true`, `new.ts` create, `dirty.txt` create.
4. **`jobDiff` stays store-free.** Signature stays `jobDiff(job: SessionJob)`. Do not add `store`. Do not call `maybeFinishRewindReset` from the helper. Serve `/diff` still awaits finish then `jobDiff`.
5. **Do not change JobDiff shape, `/diff` semantics, or `maybeFinishRewindReset`.** No schema bump. No new route. Ops stay `create | update | delete | rename`. No-job notice stays `'no job record'`.
6. **Unit test the production bug.** `job-diff.test.ts` adds `jobDiff ignores foreign GIT_DIR`: build a real temp repo (committed create + dirty untracked), set `process.env.GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` to a foreign path, call `jobDiff` with `worktreePath` of the real repo, expect `ok: true` and the real files. Restore env in `finally`.
7. **Keep spawn-error mapping.** `runGit` catch → `{ ok: false, stdout: '', stderr: '' }` stays. Do not change `fail()` notice text except by making git succeed.
8. **Targeted `bun test ./<files>` only.** Isolated worktree. Do not implement on `main` without consent.

---

## Files

| File | Role |
|---|---|
| `packages/core/src/tools/session-worktree.ts` | production `runGit` sanitized env |
| `packages/core/src/session/job-diff.test.ts` | `jobDiff ignores foreign GIT_DIR` |
| `packages/cli/src/serve.test.ts` | `gitRun` helper; `tempGitRepo` + `/diff` git spawns use it |
| `packages/core/src/tools/worktree.ts` | production `runGit` same env sanitization |
| `packages/cli/src/diff-cmd.ts` | production `runGit` same env sanitization |

`job-diff.ts` parser / shape stays. Serve `/diff` handler stays.

---

## Done when

- `jobDiff ignores foreign GIT_DIR` is green.
- `isWorktreeDirty ignores foreign GIT_DIR` and `formatGitDiff ignores foreign GIT_DIR` are green.
- `GET /v1/session/:id/diff with a job returns jobDiff` still asserts `ok: true`, `baseCommitSha`, `shadowBranch`, dirty true, `new.ts` create, `dirty.txt` create.
- That serve test passes **20×** under parallel `bun test ./packages/cli/src/serve.test.ts` and still passes **alone**.
- Existing `job-diff.test.ts` cases (committed create + dirty update, rename `from`, missing worktree, no double-count staged) stay green.

---

## Out

- Mocking git / rewriting `jobDiff` as a string parser
- Weakening `/diff` assertions or skipping the test under parallel bun
- Adding `store` to `jobDiff`; changing JobDiff; changing `/diff` or `maybeFinishRewindReset`
- Schema bump, new route, web UI
- Making `createSessionEngine` async
- Changing `tempGitRepo` uniqueness (already `mkdtemp`)
