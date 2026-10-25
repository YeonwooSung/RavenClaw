# Durable Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `whenBusy: 'followUp'` queues a user message and places one item after the current run answers.

**Architecture:** Document `inbox:<conversationId>` holds `{ items }`. Reject stays a throw with no write. A done settle places the first `followUp` item as the next run. An unanswered settle leaves the inbox.

**Tech Stack:** Bun, TypeScript, `@ravenclaw/durable`.

**Spec:** `docs/superpowers/specs/2026-10-25-durable-inbox.md`

## Global Constraints

- Work only in `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/durable-doors` on `feat/durable-doors`.
- Do not edit `packages/core`, `packages/sdk`, `packages/cli`, CHANGELOG, or versions.
- Do not copy pi source. Storage schema version stays `1`.
- Omitted `whenBusy` still throws `DurableBusy` while a run is live and writes nothing.
- Do not place `steer` items. Leave them for the steer plan.
- No commit trailers. Do not commit `bun.lock` or `.superpowers/`.
- Tests: `bun test ./packages/durable/src/runtime/turn.test.ts` from this worktree. No bare `bun test`. No `scripts/ci-unit.sh`.
- Spec status stays `draft`.

## Review Focus

- Two follow-ups drain one per completed run, in id order.
- A repeated `requestId` does not append a second item.
- `model_error` does not start the queued item.
- `reject` with a non-empty inbox throws `DurableBusy` and does not append.

---

### Task 1: Queue a follow-up while busy

**Files:**
- Modify: `packages/durable/src/storage/types.ts`
- Modify: `packages/durable/src/runtime/open.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

**Interfaces:**
- Produces: `submit` input `whenBusy?: 'reject' | 'followUp' | 'steer'`. `InboxItem` as in the spec. Document key `inbox:<id>`.

- [ ] **Step 1: Write failing tests for busy reject, busy followUp wait, and duplicate requestId.**
- [ ] **Step 2: Run the turn test file and confirm the new tests fail.**
- [ ] **Step 3: Implement admission.** Idle and empty inbox keeps today's submit for every mode. Busy or non-empty inbox plus `reject` throws `DurableBusy` before a write. `followUp` and `steer` append one queued submission and one inbox item and do not set `live.run`.
- [ ] **Step 4: Re-run the turn tests.**
- [ ] **Step 5: Commit** `feat(durable): queue a follow-up while a run is busy`.

### Task 2: Place one follow-up when the run answers

**Files:**
- Modify: `packages/durable/src/runtime/turn.ts`
- Modify: `packages/durable/src/runtime/open.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

- [ ] **Step 1: Write failing tests for two follow-ups, unanswered leaving the queue, and reject against a non-empty inbox.**
- [ ] **Step 2: Run the turn test file and confirm those tests fail.**
- [ ] **Step 3: Implement placement** in the done settle only. First `followUp` becomes a user entry, keeps its submission `queued`, starts one generation, and points `live.run` at it. Steer-only inbox clears `live.run` and keeps items. Unanswered clears nothing in the inbox.
- [ ] **Step 4: Re-run the turn tests.**
- [ ] **Step 5: Commit** `feat(durable): place one queued follow-up after an answer`.
