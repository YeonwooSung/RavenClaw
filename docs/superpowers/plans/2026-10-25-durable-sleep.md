# Durable Sleep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tool result `sleepUntil` parks the parent generation until `now()` reaches `until`, and `resume()` continues that turn.

**Architecture:** The tool-result commit sets the parent generation to `sleeping` with checkpoint `{ phase: 'sleep', until, resume: 'tools' }`. `drive` promotes due sleeps to `pending` without changing `restarts`. `wake()` is a pure read. No timer.

**Tech Stack:** Bun, TypeScript, `@ravenclaw/durable` memory storage, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-25-durable-sleep.md`

## Global Constraints

- Work only in `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/durable-doors` on `feat/durable-doors`.
- Do not edit `packages/core`, `packages/sdk`, `packages/cli`, `scripts/ci-unit.sh`, `CHANGELOG.md`, or package versions.
- Do not copy pi source. Do not import `@ravenclaw/core`.
- Sqlite meta stays `ravenclaw-durable` version `1`.
- No `setTimeout`. Missing `now` means `() => 0`. Call `now` only from sleep promotion, the sleep phase, and `wake()`.
- `close()` and open reconcile still rewrite only `running` rows.
- Default busy `submit` still throws `DurableBusy`.
- No `Co-Authored-By` or `Signed-off-by`. Do not commit `bun.lock`, `node_modules`, or `.superpowers/`.
- From this worktree, tests start with `./`. No bare `bun test`. No `bash scripts/ci-unit.sh`.
- Spec status stays `draft`. Do not fill Shipped sha.

## Review Focus

- A finite `sleepUntil >= 0` that is still in the future must not call the model for follow-up.
- `Number.NaN` and a missing parent must not sleep.
- Reopen must not increment `restarts` just because the task slept.
- `wake().at` is the earliest future `until`. Due or pending work sets `active: true`.

---

### Task 1: Park a generation on sleepUntil

**Files:**
- Modify: `packages/durable/src/storage/types.ts`
- Modify: `packages/durable/src/runtime/turn.ts`
- Modify: `packages/durable/src/runtime/open.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

**Interfaces:**
- Consumes: `DurableTool.execute` return value, parent generation `waiting` until children are terminal.
- Produces: `DurableTaskStatus` includes `'sleeping'`. Tool result may include `sleepUntil?: number`.

- [ ] **Step 1: Write the failing tests named in the spec section 테스트, except `wake()` and the reopen test.** Cover future `sleepUntil`, past `sleepUntil`, and `Number.NaN`.
- [ ] **Step 2: Run** `bun test ./packages/durable/src/runtime/turn.test.ts` and confirm the new tests fail.
- [ ] **Step 3: Implement.** Pass `now` into `PhaseHost`. On a successful tool result, if `sleepUntil` is finite and `>= 0` and `now() < sleepUntil` and `parentTaskId` is set, commit the parent as `sleeping` with checkpoint `{ phase: 'sleep', until: sleepUntil, resume: 'tools' }` in the same commit as the tool result. Do not create the follow-up generation. `runGeneration` on phase `sleep`: if not due, keep `sleeping` and return; if due, set checkpoint `{ phase: 'tools' }` and run the existing follow-up. At the start of each `drive` iteration, commit due `sleeping` tasks to `pending` with the same checkpoint and the same `restarts`.
- [ ] **Step 4: Run the same test file. New tests pass. Existing tests pass.**
- [ ] **Step 5: Commit** `feat(durable): sleep a generation until a tool deadline` with only these files.

### Task 2: Report wake() and keep the sleep across reopen

**Files:**
- Modify: `packages/durable/src/runtime/open.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

**Interfaces:**
- Produces: `DurableRuntime.wake(): { active: boolean; at?: number }`.

- [ ] **Step 1: Write the failing `wake()` and reopen tests from the spec.**
- [ ] **Step 2: Run** `bun test ./packages/durable/src/runtime/turn.test.ts` and confirm those tests fail.
- [ ] **Step 3: Implement `wake()` as a read of `storage.readTasks()` plus `now()`. Do not commit. Do not add a timer.**
- [ ] **Step 4: Re-run the test file. All tests pass.**
- [ ] **Step 5: Commit** `feat(durable): report the next sleep deadline` with only these files.
