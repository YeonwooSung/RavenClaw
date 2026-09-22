# CI unit packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `scripts/ci-unit.sh` run unit tests for every workspace package so GitHub Actions no longer skips `providers`, `ads`, `sdk`, `acp`, and `tui-opentui`.

**Architecture:** Push CI and nightly already call `bash scripts/ci-unit.sh`. Add five `bun test packages/<name>` lines after the existing `core` then `cli` lines. Pin the script with a source-lock test in `packages/cli` that reads the file and does not spawn it. Docs stop saying CI unit is core+cli only.

**Tech Stack:** bash, bun test, existing GitHub Actions workflows (unedited steps).

**Spec:** [docs/superpowers/specs/2026-09-22-ci-unit-packages.md](../specs/2026-09-22-ci-unit-packages.md)

## Global Constraints

- Isolated `.worktrees/` + TDD. Do not implement on `main`.
- Targeted `bun test ./<files>` only (path must start with `./`). Never full-repo `bun test` (Docker hang).
- Do not spawn `bash scripts/ci-unit.sh` from the lock test.
- Do not edit `package.json` `"test"` / `"test:ci"`.
- Do not add a GHA job, matrix, bun-version bump, or live smoke.
- Do not unskip env-gated provider live tests.
- Do not commit `.superpowers/` or `bun.lock`.
- Clean-room. No web UI.

## Plan rulings (spec 1–6, not new law)

1. Script order is exactly: core, cli, providers, ads, sdk, acp, tui-opentui.
2. Keep shebang, Docker-hang comment, `set -euo pipefail`, `cd "$(dirname "$0")/.."`.
3. No line that is only `bun test`.
4. `ci.yml` / `nightly.yml` steps stay `bash scripts/ci-unit.sh`.
5. remaining-roadmap edit is the R4.1 nightly sentence only.

---

## File map

| Path | Task | Role |
|---|---|---|
| `packages/cli/src/ci-unit.test.ts` | 1 | source-lock of `scripts/ci-unit.sh` |
| `scripts/ci-unit.sh` | 1 | seven `bun test packages/<name>` lines |
| `CONTRIBUTING.md` | 2 | Tests section: CI runs every workspace package |
| `docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md` | 2 | R4.1 sentence |
| `CHANGELOG.md` | 2 | Unreleased Added |
| `docs/research/eve-analysis.md` / `.ko.md` | 2 | closer pointer |
| `docs/superpowers/specs/2026-09-22-ci-unit-packages.md` | 2 | Status implemented |

`.github/workflows/ci.yml` and `nightly.yml` are not in the map (ruling 4). `packages/cli/src/ci-cli.test.ts` is not edited.

## Task partitions

| Task | Slice | Files |
|---|---|---|
| 1 | C0 lock + script | `ci-unit.test.ts`, `scripts/ci-unit.sh` |
| 2 | C1 docs honesty | CONTRIBUTING, remaining-roadmap R4.1, CHANGELOG, eve-analysis en/ko, this spec Status |

---

### Task 1: Lock test + seven package lines

**Files:**
- Create: `packages/cli/src/ci-unit.test.ts`
- Modify: `scripts/ci-unit.sh`

**Interfaces:**
- Consumes: repo-root `scripts/ci-unit.sh` via `join(import.meta.dir, '../../..', 'scripts/ci-unit.sh')`
- Produces: script lines `bun test packages/{core,cli,providers,ads,sdk,acp,tui-opentui}` in that order; lock test that fails if any line is missing or if a bare `bun test` line exists

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/ci-unit.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const scriptPath = join(import.meta.dir, '../../..', 'scripts/ci-unit.sh')

describe('ci-unit.sh', () => {
  const text = readFileSync(scriptPath, 'utf8')
  const lines = text.split('\n')

  test('is a fail-closed targeted suite, not bare bun test', () => {
    expect(lines[0]).toBe('#!/usr/bin/env bash')
    expect(text).toMatch(/Docker hang/)
    expect(text).toContain('set -euo pipefail')
    expect(text).toContain('cd "$(dirname "$0")/.."')
    expect(lines.some((line) => /^\s*bun test\s*$/.test(line))).toBe(false)
  })

  test('runs every workspace package after core then cli', () => {
    const commands = lines.filter((line) => line.startsWith('bun test packages/'))
    expect(commands).toEqual([
      'bun test packages/core',
      'bun test packages/cli',
      'bun test packages/providers',
      'bun test packages/ads',
      'bun test packages/sdk',
      'bun test packages/acp',
      'bun test packages/tui-opentui',
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

From the worktree root:

```bash
bun test ./packages/cli/src/ci-unit.test.ts
```

Expected: FAIL — the commands array is only `packages/core` and `packages/cli` (missing the five, or `toEqual` mismatch). Do not edit the test to match today's two-line script.

- [ ] **Step 3: Write minimal implementation**

Replace `scripts/ci-unit.sh` with:

```bash
#!/usr/bin/env bash
# Targeted unit suites only. Never `bun test` with no args (full-repo Docker hang).
set -euo pipefail
cd "$(dirname "$0")/.."
bun test packages/core
bun test packages/cli
bun test packages/providers
bun test packages/ads
bun test packages/sdk
bun test packages/acp
bun test packages/tui-opentui
```

Keep the file executable if it already is (`chmod +x` only if the worktree copy lost the bit).

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
bun test ./packages/cli/src/ci-unit.test.ts ./packages/cli/src/ci-cli.test.ts
```

Expected: PASS. `ci-cli.test.ts` is the existing no-key CLI lock and must stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ci-unit.test.ts scripts/ci-unit.sh
git commit -m "$(cat <<'EOF'
test: run every workspace package in ci-unit.sh

Push and nightly already call this script. Core and CLI were the
only suites; ads isolation and provider fixtures never ran on CI.
EOF
)"
```

Do not add `bun.lock`.

---

### Task 2: Docs honesty

**Files:**
- Modify: `CONTRIBUTING.md` Tests section (after the ads isolation bullet)
- Modify: `docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md` R4.1 nightly bullet only
- Modify: `CHANGELOG.md` Unreleased Added (prepend one bullet)
- Modify: `docs/research/eve-analysis.md` closer (append one sentence)
- Modify: `docs/research/eve-analysis.ko.md` closer (append one sentence)
- Modify: `docs/superpowers/specs/2026-09-22-ci-unit-packages.md` Status → implemented; board C0–C1 done

**Interfaces:**
- Consumes: Task 1 script contract
- Produces: docs that name all workspace packages and still forbid bare `bun test`

- [ ] **Step 1: Write the failing honesty pins inside the lock test**

Add to `packages/cli/src/ci-unit.test.ts` (same file as Task 1):

```ts
  test('CONTRIBUTING names ci-unit.sh for every workspace package', () => {
    const contributing = readFileSync(
      join(import.meta.dir, '../../..', 'CONTRIBUTING.md'),
      'utf8',
    )
    expect(contributing).toContain('scripts/ci-unit.sh')
    expect(contributing).toContain('packages/providers')
    expect(contributing).toContain('packages/ads')
    expect(contributing).toContain('packages/sdk')
    expect(contributing).toContain('packages/acp')
    expect(contributing).toContain('packages/tui-opentui')
  })
```

This is a docs lock, not a product behavior lock. If CONTRIBUTING already contains those package names in the Layout table, also require the Tests section to mention `scripts/ci-unit.sh` **and** that CI runs every workspace package (the `scripts/ci-unit.sh` substring is the unique Tests-section pin; Layout does not mention the script today).

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test ./packages/cli/src/ci-unit.test.ts
```

Expected: FAIL — CONTRIBUTING Tests section does not mention `scripts/ci-unit.sh`.

- [ ] **Step 3: Docs**

In `CONTRIBUTING.md` `## Tests`, after the ads isolation bullet, add:

```
- CI (`scripts/ci-unit.sh`) runs `bun test packages/<name>` for every workspace package (`core`, `cli`, `providers`, `ads`, `sdk`, `acp`, `tui-opentui`). Never `bun test` with no args (full-repo Docker hang).
```

Keep the existing no-key CLI bullet.

In remaining-roadmap, replace the R4.1 nightly sentence:

Old:

```
- Nightly: workflow `cron: '0 7 * * *'` that runs `bun test` on `packages/core` + `packages/cli` targeted suites (never full-repo `bun test` — Docker hang). Optional live smoke job **manual** (`workflow_dispatch`) with a repo secret; default nightly is unit-only.
```

New:

```
- Nightly: workflow `cron: '0 7 * * *'` that runs `scripts/ci-unit.sh` (every workspace package; never full-repo `bun test` — Docker hang). Amended by `2026-09-22-ci-unit-packages.md`. Optional live smoke job **manual** (`workflow_dispatch`) with a repo secret; default nightly is unit-only.
```

Do not edit the remaining-roadmap closer's dismiss-on-message sentence (sibling honesty door).

Prepend to `CHANGELOG.md` `## Unreleased` `### Added`:

```
- CI unit (`scripts/ci-unit.sh`) runs every workspace package (`core`, `cli`, `providers`, `ads`, `sdk`, `acp`, `tui-opentui`). Push and nightly still call that script. Never bare `bun test` (full-repo Docker hang). Spec: [docs/superpowers/specs/2026-09-22-ci-unit-packages.md](docs/superpowers/specs/2026-09-22-ci-unit-packages.md). Plan: [docs/superpowers/plans/2026-09-22-ci-unit-packages.md](docs/superpowers/plans/2026-09-22-ci-unit-packages.md).
```

Append to eve-analysis.md closer (the last paragraph of section 11):

`CI unit coverage of every workspace package is implemented (`docs/superpowers/specs/2026-09-22-ci-unit-packages.md`).`

Append the Korean equivalent to eve-analysis.ko.md closer.

Set this spec `Status: implemented`, board C0–C1 **done**, Shipped sha left empty until main.

- [ ] **Step 4: Run the lock**

```bash
bun test ./packages/cli/src/ci-unit.test.ts
```

Expected: PASS (three tests).

- [ ] **Step 5: Commit**

```bash
git add CONTRIBUTING.md \
  docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md \
  CHANGELOG.md \
  docs/research/eve-analysis.md \
  docs/research/eve-analysis.ko.md \
  docs/superpowers/specs/2026-09-22-ci-unit-packages.md \
  packages/cli/src/ci-unit.test.ts
git commit -m "$(cat <<'EOF'
docs: CI unit covers every workspace package

Honesty for ci-unit.sh. Do not claim the Docker hang is fixed.
EOF
)"
```

---

## Spec coverage (self-review)

| Spec ruling / wave | Task |
|---|---|
| 1 seven lines, core+cli first | 1 |
| 2 no bare bun test; workflows unedited | 1 (lock) + workflows not in file map |
| 3 source-lock test, do not spawn script | 1 |
| 4 one job | 2 does not touch yml |
| 5 docs honesty | 2 |
| 6 secrets / skipIf | no code change; live tests stay skipIf |
| C0 | 1 |
| C1 | 2 |
| Success checks 1–5 | 1 + 2 |

No placeholders. `package.json` scripts stay OUT.
