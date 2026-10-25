# Durable Nested Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ctx.call` runs one child tool under the caller, with its own checkpoint, and the scheduler never picks that task.

**Architecture:** Nested tasks use `nested: true`. Open turns a `running` nested task into terminal `aborted` without execute. The nested tool entry id is `nested:<childTaskId>` and `projectMessages` drops it. `spawn` in this plan returns `subagent depth` and writes nothing.

**Tech Stack:** Bun, TypeScript, `@ravenclaw/durable`.

**Spec:** `docs/superpowers/specs/2026-10-25-durable-nested-tools.md`

## Global Constraints

- Work only in `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/durable-doors` on `feat/durable-doors`.
- Depth is one nested call. The child's `call` returns content `nested tool depth` and does not execute.
- Unknown name content is exactly `tool_unavailable`.
- Select skips `nested: true`.
- Do not put the nested tool message into the next model request.
- `beforeTool` and `afterTool` apply to the nested call.
- This plan's `spawn` creates no conversation.
- No version bump. No CHANGELOG. No pi source. No commit trailers. No `bun.lock`.
- Tests: `bun test ./packages/durable/src/runtime/turn.test.ts` from this worktree.
- Spec status stays `draft`.

## Review Focus

- Parent result contains the child content. The model request does not contain `nested:`.
- Storage still has the nested tool entry.
- Reopen does not execute a nested tool that was `running`.
- A blocked nested tool does not execute.

---

### Task 1: Call a child tool from execute

**Files:**
- Modify: `packages/durable/src/storage/types.ts`
- Modify: `packages/durable/src/runtime/turn.ts`
- Modify: `packages/durable/src/runtime/open.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

**Interfaces:**
- Produces: tool ctx `call` and `spawn` as in the spec. `DurableTaskRow.nested?: boolean`.

- [ ] **Step 1: Write failing tests for a successful call, unknown tool, depth, beforeTool block, and spawn writing nothing.**
- [ ] **Step 2: Run the turn test file and confirm they fail.**
- [ ] **Step 3: Implement `call` and the stub `spawn`.** Commit the nested running task before execute, then the terminal result. Pass hooks.
- [ ] **Step 4: Re-run the turn tests.**
- [ ] **Step 5: Commit** `feat(durable): call one tool from inside a tool`.

### Task 2: Do not resume a nested tool

**Files:**
- Modify: `packages/durable/src/runtime/open.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

- [ ] **Step 1: Write the failing abandon-during-nested-execute test. The child abandons the runtime before returning, leaving its nested task `running`.**
- [ ] **Step 2: Run the turn test file and confirm it fails.**
- [ ] **Step 3: In reconcile, a `running` task with `nested: true` becomes terminal `outcome: 'aborted'` and is not invoked. Do not increment a path that executes it.**
- [ ] **Step 4: Re-run the turn tests.**
- [ ] **Step 5: Commit** `fix(durable): abort a nested tool that was still running`.
