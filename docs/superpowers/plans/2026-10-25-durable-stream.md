# Durable Stream Partial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional `model.stream` publishes the full text so far on `live.partial`, and a crash still resends the original request.

**Architecture:** `request` prefers `stream` when it is a function. Each `onPartial` commits `partial` without dropping `run`. Settle and thrown-stream commits delete `partial`. `partial()` reads it. Partials are not entries.

**Tech Stack:** Bun, TypeScript, `@ravenclaw/durable`.

**Spec:** `docs/superpowers/specs/2026-10-25-durable-stream.md`

## Global Constraints

- Work only in `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/durable-doors` on `feat/durable-doors`.
- Do not edit SDK or CLI. No `--json`.
- A model without `stream` never writes `partial`.
- `onPartial` receives the full text, not a delta. The commit replaces `live.partial`.
- `withSlot` and other live writes must not drop `partial` until the settle commit.
- Crash before the assistant entry resends the same messages. Do not project `partial`.
- No version bump. No CHANGELOG. No pi source. No commit trailers. No `bun.lock`.
- Tests: `bun test ./packages/durable/src/runtime/turn.test.ts` from this worktree.
- Spec status stays `draft`.

## Review Focus

- After `done`, `partial(1)` is `undefined`.
- `partial(99)` throws `unknown conversation 99`.
- A throw after one partial still clears `partial` and answers unanswered.
- The resent request does not contain the partial string as an assistant entry.

---

### Task 1: Commit and clear live.partial

**Files:**
- Modify: `packages/durable/src/storage/types.ts`
- Modify: `packages/durable/src/runtime/turn.ts`
- Modify: `packages/durable/src/runtime/open.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

**Interfaces:**
- Produces: `DurableModel.stream?` as in the spec. `DurableRuntime.partial(conversationId: number): string | undefined`.

- [ ] **Step 1: Write failing tests for two partials, complete-only, unknown conversation, and a throw after one partial.**
- [ ] **Step 2: Run the turn test file and confirm the new tests fail.**
- [ ] **Step 3: Implement stream, partial commits, settle deletion, and `partial()`.** Preserve `run` and `tools` when writing `partial`.
- [ ] **Step 4: Re-run the turn tests.**
- [ ] **Step 5: Commit** `feat(durable): store the in-flight reply text`.

### Task 2: Resend after a crash that left a partial

**Files:**
- Modify: `packages/durable/src/runtime/turn.ts` only if Task 1 still projects or resumes from partial.
- Test: `packages/durable/src/runtime/turn.test.ts`

- [ ] **Step 1: Write the failing abandon-after-partial test from the spec.**
- [ ] **Step 2: Run the turn test file.**
- [ ] **Step 3: If the test fails, stop projecting partial and keep the existing resend path.**
- [ ] **Step 4: Re-run the turn tests.**
- [ ] **Step 5: Commit** `test(durable): a partial does not resume the model request` if the test is the only change, or `fix(durable): do not resume from a stream partial` if code changed.
