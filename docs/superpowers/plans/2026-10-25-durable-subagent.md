# Durable Subagent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ctx.spawn` runs one child conversation to an answer while the parent tool is still inside the outer drive loop.

**Architecture:** The child row stores `ownerTaskId`. Entries are not copied. Submit uses requestId `subagent:<taskId>` and `whenBusy: 'followUp'`. A private pump runs only that conversation's non-nested tasks. A child that already has `ownerTaskId` returns `subagent depth`. No host `conversation.spawn`.

**Tech Stack:** Bun, TypeScript, `@ravenclaw/durable`.

**Spec:** `docs/superpowers/specs/2026-10-25-durable-subagent.md`

## Global Constraints

- Work only in `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/durable-doors` on `feat/durable-doors`.
- Replace the nested-tool plan's stub `spawn`. Do not add a second spawn API.
- Do not wait on the outer `drive()` from inside `spawn`. That deadlocks.
- The pump must not select another conversation's tasks.
- Replay of a safe parent tool reuses the conversation with the same `ownerTaskId` and the same requestId. One child row.
- Abort reason is exactly `aborted`. Depth reason is exactly `subagent depth`.
- No background subagent, no name registry, no `packages/core` Agent tool.
- No version bump. No CHANGELOG. No pi source. No commit trailers. No `bun.lock`.
- Tests: `bun test ./packages/durable/src/runtime/turn.test.ts` from this worktree.
- Spec status stays `draft`.

## Review Focus

- The parent transcript does not contain the child user message.
- The child can run its own tool and the parent model does not see that tool message.
- A second spawn from the child creates no third conversation.
- Safe replay does not create a second child.

---

### Task 1: Pump a child conversation from spawn

**Files:**
- Modify: `packages/durable/src/runtime/turn.ts`
- Modify: `packages/durable/src/runtime/open.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

**Interfaces:**
- Produces: `ctx.spawn` behavior from the spec. Conversation row `ownerTaskId` is written.

- [ ] **Step 1: Write failing tests for a text answer, a child tool call, and depth.**
- [ ] **Step 2: Run the turn test file and confirm they fail.**
- [ ] **Step 3: Implement create-or-reuse, submit, and the child pump. Copy the agent document only.**
- [ ] **Step 4: Re-run the turn tests.**
- [ ] **Step 5: Commit** `feat(durable): spawn a foreground child conversation`.

### Task 2: Replay and abort the child once

**Files:**
- Modify: `packages/durable/src/runtime/turn.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

- [ ] **Step 1: Write failing tests for safe replay keeping one child, and for abort reason `aborted`.**
- [ ] **Step 2: Run the turn test file and confirm they fail.**
- [ ] **Step 3: Implement reuse and abort settlement.**
- [ ] **Step 4: Re-run the turn tests.**
- [ ] **Step 5: Commit** `fix(durable): resume one subagent and abort it with the parent signal`.
