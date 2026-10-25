# Durable Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manual `compact()` replaces an old prefix with one summary entry in the model projection. Stored rows stay.

**Architecture:** A compaction task runs before chat generations. The cut keeps the last two user or assistant messages and does not split a tool pair. `projectMessages` starts at the latest compact entry at or before the cutoff. No token counter.

**Tech Stack:** Bun, TypeScript, `@ravenclaw/durable`.

**Spec:** `docs/superpowers/specs/2026-10-25-durable-compact.md`

## Global Constraints

- Work only in `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/durable-doors` on `feat/durable-doors`.
- Do not edit `packages/core` `spliceCompactPath`.
- Do not delete entries. Do not add `active`.
- Busy or non-empty inbox throws `DurableBusy` and writes nothing.
- System prompt and wrapper strings are exactly the spec's strings.
- Compaction calls `complete`, never `stream`.
- `<= 4` user+assistant messages: `done` with answer `''` and no entry.
- Any other model result: unanswered reason `model_error` and no entry.
- No version bump. No CHANGELOG. No pi source. No commit trailers. No `bun.lock`.
- Tests: `bun test ./packages/durable/src/runtime/turn.test.ts` from this worktree.
- Spec status stays `draft`. No `beforeCompact` yet.

## Review Focus

- The first user message remains in storage and is absent from the next model request.
- A second compact does not feed the model the entries before the first summary.
- Tool results stay with the assistant that called them when that assistant is in the tail.
- `model_error` writes no compact entry.

---

### Task 1: Project from the latest compact entry

**Files:**
- Modify: `packages/durable/src/storage/types.ts`
- Modify: `packages/durable/src/runtime/turn.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

**Interfaces:**
- Produces: entry `kind: 'compact'`, optional `boundaryId`. `projectMessages` rule from the spec.

- [ ] **Step 1: Write a failing unit test that calls `projectMessages` with a compact entry and expects the prefix dropped.** Export the function if the test is in the same package; it is already exported from `turn.ts`.
- [ ] **Step 2: Run the turn test file and confirm it fails.**
- [ ] **Step 3: Implement the projection rule only.**
- [ ] **Step 4: Re-run the turn tests.**
- [ ] **Step 5: Commit** `feat(durable): project messages from the latest compact entry`.

### Task 2: Run a manual compact task

**Files:**
- Modify: `packages/durable/src/runtime/turn.ts`
- Modify: `packages/durable/src/runtime/open.ts`
- Modify: `packages/durable/src/runtime/scheduler.ts` only if select lives there. Select currently lives in `open.ts`.
- Test: `packages/durable/src/runtime/turn.test.ts`

**Interfaces:**
- Produces: `DurableConversation.compact(instructions?: string): Promise<DurableSubmission>`. Task name `'compaction'`.

- [ ] **Step 1: Write the failing compact tests from the spec, including the tool-pair tail if a short fixture can show it.**
- [ ] **Step 2: Run the turn test file and confirm they fail.**
- [ ] **Step 3: Implement select, summarize, wrapper, and settlement.** Select compaction before a pending generation.
- [ ] **Step 4: Re-run the turn tests.**
- [ ] **Step 5: Commit** `feat(durable): compact a conversation by hand`.
