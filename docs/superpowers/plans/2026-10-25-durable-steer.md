# Durable Steer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A queued `steer` joins the next tool follow-up, or starts the next run when the model stops.

**Architecture:** postTools places the first steer item before `projectMessages`. final settles every input on the current run with the same answer, then places one remaining steer ahead of any follow-up. One item per boundary.

**Tech Stack:** Bun, TypeScript, `@ravenclaw/durable`.

**Spec:** `docs/superpowers/specs/2026-10-25-durable-steer.md`

## Global Constraints

- Work only in `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/durable-doors` on `feat/durable-doors`.
- Depends on the inbox plan's queue. Do not change `reject`.
- No `all` mode and no settings field.
- Do not place steer or follow-up on unanswered.
- A steer placed at postTools gets the same `done` text as the original submission.
- No package outside `packages/durable`. No version bump. No CHANGELOG. No pi source. No commit trailers. No `bun.lock`.
- Tests: `bun test ./packages/durable/src/runtime/turn.test.ts` from this worktree.
- Spec status stays `draft`.

## Review Focus

- postTools must not place a follow-up.
- Two steers: the second waits until the current run stops.
- A stop with no tool still promotes one queued steer into a new run.
- Unanswered leaves the steer queued.

---

### Task 1: Inject the first steer before the tool follow-up

**Files:**
- Modify: `packages/durable/src/runtime/turn.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

- [ ] **Step 1: Write failing tests for one steer after a tool call, two steers, and steer winning over followUp at postTools.**
- [ ] **Step 2: Run the turn test file and confirm the new tests fail.**
- [ ] **Step 3: Implement postTools placement and same-answer settlement for submissions listed on the run.**
- [ ] **Step 4: Re-run the turn tests.**
- [ ] **Step 5: Commit** `feat(durable): steer the next tool follow-up`.

### Task 2: Start the next run from a steer when the model stops

**Files:**
- Modify: `packages/durable/src/runtime/turn.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

- [ ] **Step 1: Write failing tests for a tool-less stop, and for unanswered leaving the steer queued.**
- [ ] **Step 2: Run the turn test file and confirm those tests fail.**
- [ ] **Step 3: Implement the final boundary.** Steer before follow-up. One steer. Current inputs share one answer.
- [ ] **Step 4: Re-run the turn tests.**
- [ ] **Step 5: Commit** `feat(durable): start the next run from a queued steer`.
