# RavenClaw next-horizon roadmap (CI unit packages)

Date: 2026-09-22  
Status: implemented  
Shipped sha:  
Reviewed against tree at `061d23c` (`origin/main`).  
Successor to remaining-roadmap R4.1 (`2026-09-12-ravenclaw-remaining-roadmap.md`). Amends that spec’s nightly line **only** so `scripts/ci-unit.sh` lists every workspace package. Does not reopen the full-repo Docker hang, live smoke secrets, `package.json` `"test"` / `"test:ci"` scripts, or a new GitHub Actions job/matrix.

Implementation plan: [docs/superpowers/plans/2026-09-22-ci-unit-packages.md](../plans/2026-09-22-ci-unit-packages.md). Isolated worktree only. Do not implement on `main`.

Sources: current tree; [CONTRIBUTING.md](../../../CONTRIBUTING.md) Tests section. Steal contracts. Do not copy eve source. Do not become an agent framework. Do not add a web UI.

---

## Where we are

Push CI (`.github/workflows/ci.yml`) and nightly unit (`.github/workflows/nightly.yml`) both run `bash scripts/ci-unit.sh`. That script is:

```bash
bun test packages/core
bun test packages/cli
```

Workspace packages `providers`, `ads`, `sdk`, `acp`, and `tui-opentui` have unit tests on `main` (151 pass / 4 env-gated skip / 0 fail at write time) and never run on GitHub Actions. Ads isolation (`packages/ads/src/isolation.test.ts`) and SDK isolation are CONTRIBUTING must-stay-green locks that CI does not execute.

`bun test` with no args stays forbidden (full-repo Docker hang). This door does **not** fix that hang. It adds one `bun test packages/<name>` line per missing workspace package.

At `061d23c`:

| Piece | Tree |
|---|---|
| `scripts/ci-unit.sh` | `set -euo pipefail`; cd repo root; `bun test packages/core` then `bun test packages/cli`. Comment forbids bare `bun test`. |
| `.github/workflows/ci.yml` | one job: bun 1.1.29, `bun install`, Targeted unit tests via `bash scripts/ci-unit.sh`, then no-key CLI smoke. |
| `.github/workflows/nightly.yml` | unit job calls the same script. Optional `workflow_dispatch` live smoke stays secret-gated. |
| `package.json` `"test"` / `"test:ci"` | still `bun test` (hang path). Out of this door. |
| Workspace packages | `core`, `providers`, `ads`, `sdk`, `cli`, `tui-opentui`, `acp`. |

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Hosts only `submitMessage`. This door does not touch the loop, tools, or hosts.
2. Default prefix unchanged. No new tool.
3. `dontAsk` never becomes `bypass`.
4. BYOK. Clean-room. No web UI, Prisma Task, Socket.IO, wiki.
5. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent.
6. Never `bun test` with no args in CI or in `scripts/ci-unit.sh`.

---

## Do not build

- Full-repo `bun test` / fixing the Docker hang
- Pointing `package.json` `"test"` or `"test:ci"` at `ci-unit.sh`
- New GitHub Actions job, matrix, bun-version bump, or extra workflow file
- Default-on live smoke (`raven smoke`, env-gated provider live tests must keep `test.skipIf`)
- Eval fixtures, schema bump, version bump
- Slack/ACP skip UI, Memory docker, file-history docker undo (sibling unmerged branches)
- Changing no-key CLI smoke steps in `ci.yml`

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

1. **IN is `scripts/ci-unit.sh` listing every workspace package.** After `packages/core` and `packages/cli`, the script runs, in this order, as their own lines:
   - `bun test packages/providers`
   - `bun test packages/ads`
   - `bun test packages/sdk`
   - `bun test packages/acp`
   - `bun test packages/tui-opentui`
   Keep `core` then `cli` first (fail-fast on the large suites). Keep `#!/usr/bin/env bash`, the Docker-hang comment, `set -euo pipefail`, and `cd "$(dirname "$0")/.."`.

2. **No bare `bun test`.** The script must not contain a line that is only `bun test` (optional whitespace). Each `bun test` invocation has a `packages/<name>` argument. `ci.yml` and `nightly.yml` keep `run: bash scripts/ci-unit.sh` and are **not** edited unless a comment there names only core+cli (then amend the comment).

3. **Lock with a unit test, not by running the script inside bun test.** `packages/cli/src/ci-unit.test.ts` reads `scripts/ci-unit.sh` from the repo root (`join(import.meta.dir, '../../..', 'scripts/ci-unit.sh')`) and asserts:
   - shebang `#!/usr/bin/env bash`
   - a comment that mentions Docker hang / forbids bare `bun test`
   - `set -euo pipefail`
   - the seven `bun test packages/<name>` lines exist in the order in ruling 1 (core, cli, then the five)
   - no line matches `/^\s*bun test\s*$/`
   Do not spawn `bash scripts/ci-unit.sh` from that test (it would re-run core+cli). Env-gated live provider tests stay skipped in CI; do not unskip them.

4. **Workflows stay one job.** Push CI still: bun 1.1.29, `bun install`, `bash scripts/ci-unit.sh`, no-key CLI. Nightly unit still calls the same script. Live-smoke job stays `workflow_dispatch` + secret.

5. **Docs honesty.** CONTRIBUTING Tests section says CI (`scripts/ci-unit.sh`) runs every workspace package and never bare `bun test`. remaining-roadmap R4.1 nightly sentence is amended: unit job uses `scripts/ci-unit.sh` covering all workspace packages (this spec), never full-repo `bun test`. CHANGELOG Unreleased Added bullet. eve-analysis en/ko closer pointer. This spec Status → implemented after code. Do not claim the Docker hang is fixed. Do not claim `npm test` / `bun test` at repo root is safe.

6. **Secrets.** No new secrets. Ads isolation and provider fixture tests stay network-free. Live provider tests remain `test.skipIf` on missing env.

---

## Theme

GitHub Actions unit CI runs the same packages a contributor has tests for. A missing `bun test packages/ads` can no longer hide an ads-core import. Bare `bun test` stays off the runner.

---

## Per-slice board

Board as of this worktree (`docs/ci-unit-packages`).

| ID | Status vs tree |
|---|---|
| C0 lock test + `ci-unit.sh` lines | **done** |
| C1 docs honesty | **done** |

---

## Wave C0 — Script + lock

**Contract.** Ruling 1–3. RED: `ci-unit.test.ts` fails because the five package lines are missing. GREEN: script has all seven lines; lock passes. Existing `ci-cli.test.ts` stays green.

**Files.** `scripts/ci-unit.sh`, `packages/cli/src/ci-unit.test.ts`.

---

## Wave C1 — Docs

**Contract.** Ruling 5. CONTRIBUTING, remaining-roadmap R4.1, CHANGELOG Unreleased, eve-analysis closer, this spec Status implemented (Shipped sha empty until main).

**Files.** `CONTRIBUTING.md`, `docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md` (R4.1 sentence only), `CHANGELOG.md`, `docs/research/eve-analysis.md`, `docs/research/eve-analysis.ko.md`, this spec.

---

## File map

| Path | Wave |
|---|---|
| `packages/cli/src/ci-unit.test.ts` | C0 |
| `scripts/ci-unit.sh` | C0 |
| `CONTRIBUTING.md` | C1 |
| remaining-roadmap R4.1 | C1 |
| `CHANGELOG.md` | C1 |
| eve-analysis en/ko closer | C1 |
| this spec | C1 Status |

Leave `package.json` scripts, `ci.yml` / `nightly.yml` steps (unless a comment names only core+cli), eval, schema, hosts.

---

## Success checks

1. `scripts/ci-unit.sh` runs `bun test packages/<name>` for `core`, `cli`, `providers`, `ads`, `sdk`, `acp`, `tui-opentui` in that order after cd-to-root.
2. The script has no bare `bun test` line.
3. `bun test ./packages/cli/src/ci-unit.test.ts` pins 1–2 without spawning the script.
4. `ci.yml` and `nightly.yml` still invoke `bash scripts/ci-unit.sh`.
5. Docs no longer say CI unit is core+cli only.

---

## Out of this closeout

Docker hang, `package.json` test scripts, live smoke, new GHA jobs, version bump, unmerged P1/P2/P3 product doors.
