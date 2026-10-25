# Durable Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five optional callbacks can replace a request, block or rewrite a tool, and decline or supply a compaction summary.

**Architecture:** `openDurable` takes `hooks?: DurableHooks`. Hooks run off the mutation line. Throws follow the spec: ignore, or block with `hook_error`. No registry and no persisted hook list.

**Tech Stack:** Bun, TypeScript, `@ravenclaw/durable`.

**Spec:** `docs/superpowers/specs/2026-10-25-durable-hooks.md`

## Global Constraints

- Work only in `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/durable-doors` on `feat/durable-doors`.
- One function per hook name. Do not add an extension registry.
- `beforeTool` must not change the stored assistant arguments.
- `beforeCompact` runs only when the user+assistant count is greater than 4.
- A hook is not given a commit function.
- Absent `hooks` keeps today's behavior.
- No version bump. No CHANGELOG. No pi source. No commit trailers. No `bun.lock`.
- Tests: `bun test ./packages/durable/src/runtime/turn.test.ts` from this worktree.
- Spec status stays `draft`.

## Review Focus

- A thrown `beforeRequest` still sends the original messages.
- A thrown `beforeTool` writes `hook_error` and does not execute.
- `beforeCompact` summary does not call `complete` for the summary.
- `decline: true` writes no compact entry and answers `''`.

---

### Task 1: Hook the model request and the tool result

**Files:**
- Modify: `packages/durable/src/storage/types.ts` or `packages/durable/src/runtime/open.ts` for the type
- Modify: `packages/durable/src/index.ts`
- Modify: `packages/durable/src/runtime/turn.ts`
- Modify: `packages/durable/src/runtime/open.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

**Interfaces:**
- Produces: `DurableHooks` exported from the package barrel. `openDurable` options `hooks?`.

- [ ] **Step 1: Write failing tests for beforeRequest replace, beforeRequest throw, beforeTool block, beforeTool arguments, beforeTool throw, and afterTool replace.**
- [ ] **Step 2: Run the turn test file and confirm they fail.**
- [ ] **Step 3: Implement those four hooks. `afterResponse` runs before classification and ignores throws. Add a test that a throwing afterResponse still settles `done`.**
- [ ] **Step 4: Re-run the turn tests.**
- [ ] **Step 5: Commit** `feat(durable): hook a request and a tool call`.

### Task 2: Hook compaction

**Files:**
- Modify: `packages/durable/src/runtime/turn.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

- [ ] **Step 1: Write failing tests for `{ summary: 'kept' }` and `{ decline: true }`.**
- [ ] **Step 2: Run the turn test file and confirm they fail.**
- [ ] **Step 3: Implement `beforeCompact` on the manual compact path.**
- [ ] **Step 4: Re-run the turn tests.**
- [ ] **Step 5: Commit** `feat(durable): hook compaction before the summary model`.
