# Durable harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@ravenclaw/durable`, a clean-room sibling runtime that resumes a model turn at the last committed phase.

**Architecture:** Own memory and bun:sqlite stores. One mutation line. Generation and tool tasks checkpoint before `complete` / `execute`. `openDurable` rewrites `running` to `pending` and increments `restarts`. Hosts keep `queryLoop`.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bun:test`.

**Spec:** [docs/superpowers/specs/2026-10-22-durable-harness.md](../specs/2026-10-22-durable-harness.md)

## Global Constraints

- Work only in `.worktrees/durable` on `feat/durable`. Do not implement on `main`.
- TDD. Targeted `bun test ./<files>` from the worktree. Paths start with `./`. Never bare `bun test`. Never `bash scripts/ci-unit.sh`.
- No `packages/core` source edits. No CLI or SDK behavior change except listing this package in `scripts/ci-unit.sh`, `packages/cli/src/ci-unit.test.ts`, `CONTRIBUTING.md`, `ARCHITECTURE.md`, and `ARCHITECTURE.ko.md`.
- No version bump, no CHANGELOG, no `bun.lock` commit, no Co-Authored-By.
- Clean-room. Do not paste pi source.
- The spec is the authority for strings, restart counting, and signatures.

## File map

| Path | Task | Role |
|---|---|---|
| `packages/durable/package.json`, `NOTICE`, `src/package.test.ts` | 1 | package lock |
| `packages/durable/src/json.ts`, `errors.ts`, `json.test.ts` | 2 | strict JSON and errors |
| `packages/durable/src/storage/types.ts`, `memory.ts`, `memory.test.ts` | 3 | memory store |
| `packages/durable/src/storage/sqlite.ts`, `sqlite.test.ts` | 4 | sqlite store |
| `packages/durable/src/runtime/commit.ts`, `commit.test.ts` | 5 | mutation line |
| `packages/durable/src/runtime/scheduler.ts`, `scheduler.test.ts` | 6 | restart and evolve |
| `packages/durable/src/runtime/turn.ts`, `open.ts`, `turn.test.ts` | 7 | resume scenarios |
| `src/index.ts`, `exports.test.ts`, CI and architecture docs | 8 | public surface and listing |

### Task 1: Lock the package name

**Files:** Create `packages/durable/package.json`, `NOTICE`, `src/package.test.ts`.

Commit: `test(durable): lock the package name`

### Task 2: Strict JSON

**Files:** Create `src/json.ts`, `src/errors.ts`, `src/json.test.ts`.

`assertStrictJson` stays private to the package. Errors are `DurableBusy` (`busy`), `DurableClosed` (`closed`), `DurableFault` (`fault`).

Commit: `feat(durable): reject values that are not strict JSON`

### Task 3: Memory store

**Files:** Create `src/storage/types.ts`, `memory.ts`, `memory.test.ts`.

First `mintId()` is 2. `commit` is all-or-nothing. Reads return copies.

Commit: `feat(durable): add an in-memory atomic store`

### Task 4: SQLite store

**Files:** Create `src/storage/sqlite.ts`, `sqlite.test.ts`.

`bun:sqlite`, one transaction per commit, meta schema `ravenclaw-durable` version `1`.

Commit: `feat(durable): add a sqlite store`

### Task 5: Mutation line

**Files:** Create `src/runtime/commit.ts`, `commit.test.ts`.

`createCommitLine(storage).run(fn)` serializes callers. A thrown callback writes nothing. A storage throw makes the next `run` throw `DurableClosed`. `DurableFault` leaves the line open.

Commit: `feat(durable): commit on one mutation line`

### Task 6: Restart counter

**Files:** Create `src/runtime/scheduler.ts`, `scheduler.test.ts`.

`reconcileTask`: `running` becomes `pending` with `restarts + 1`. `restarts >= limit` parks and does not invoke. `evolveTask`: an equal checkpoint keeps `restarts`; a changed checkpoint or a terminal outcome sets `restarts` to 0 and a terminal row has no checkpoint.

Commit: `feat(durable): resume parked phases`

### Task 7: Turn resume

**Files:** Create `src/runtime/turn.ts`, `open.ts`, `turn.test.ts`.

Cover every scenario in the spec's "테스트하는 경계" turn list. Crash during an effect is `abandon()` after the intent commit, or a storage `commit` that throws after `complete` returns. `submit` resolves when the user row is committed.

Commit: `feat(durable): resume a turn at the failed phase`

### Task 8: Barrel and CI listing

**Files:** Create `src/index.ts`, `src/exports.test.ts`. Modify `scripts/ci-unit.sh`, `packages/cli/src/ci-unit.test.ts`, `CONTRIBUTING.md`, `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`.

Append `bun test packages/durable` after `tui-opentui`. Do not edit root `test` scripts or `ci.yml`.

`ARCHITECTURE.md` after the host-local query loop bullet: `@ravenclaw/durable` (`packages/durable`) is an opt-in sibling runtime with its own store. CLI, SDK, ACP, and HTTP still enter turns only through `queryLoop`. This package is not a host-local query loop.

Commit: `docs(durable): list the package without touching the query loop`

## Verification

```bash
bun test ./packages/durable/src/package.test.ts ./packages/durable/src/json.test.ts ./packages/durable/src/storage/memory.test.ts ./packages/durable/src/storage/sqlite.test.ts ./packages/durable/src/runtime/commit.test.ts ./packages/durable/src/runtime/scheduler.test.ts ./packages/durable/src/runtime/turn.test.ts ./packages/durable/src/exports.test.ts ./packages/cli/src/ci-unit.test.ts
```
