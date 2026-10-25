# Durable Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `fork(atEntryId)` copies that conversation's entries through one id into a new conversation, and phases stop hardcoding the root.

**Architecture:** Root keeps document keys `agent` and `live`. Other ids use `agent:<id>` and `live:<id>`. Inbox is already `inbox:<id>`. Conversation rows gain optional parent, at, and owner fields. `ownerTaskId` is stored and unused until the subagent plan.

**Tech Stack:** Bun, TypeScript, `@ravenclaw/durable` memory and sqlite stores.

**Spec:** `docs/superpowers/specs/2026-10-25-durable-fork.md`

## Global Constraints

- Work only in `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/durable-doors` on `feat/durable-doors`.
- Do not edit `packages/core` session branching. This is not `branchAt`.
- Do not copy tasks, submissions, inbox, or live.
- Missing entry message is exactly `entry is not on this conversation`.
- Unknown handle message is exactly `unknown conversation <id>`.
- Fork while the parent is busy must not throw `DurableBusy`.
- Existing root tests keep reading keys `agent` and `live`.
- No version bump. No CHANGELOG. No pi source. No commit trailers. No `bun.lock`.
- Tests from this worktree: `bun test ./packages/durable/src/runtime/turn.test.ts ./packages/durable/src/storage/memory.test.ts ./packages/durable/src/storage/sqlite.test.ts`.
- Spec status stays `draft`.

## Review Focus

- Entries after `atEntryId` stay only on the parent.
- Child ids come from `mintId()` and are not 1.
- A fork of a fork copies the child's entries only.
- A parent run and a child submit both finish.

---

### Task 1: Address live and agent documents by conversation

**Files:**
- Modify: `packages/durable/src/storage/types.ts`
- Modify: `packages/durable/src/runtime/turn.ts`
- Modify: `packages/durable/src/runtime/open.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

**Interfaces:**
- Produces: `liveKey`, `agentKey` with the spec's id 1 exception. `DurableConversationRow` optional fields. `DurableRuntime.conversation(id)`.

- [ ] **Step 1: Write a failing test that a second conversation row can submit without disturbing the root live document.** Create the row through the public `conversation` API only after it exists; until `fork` exists, this task may add `conversation(id)` and a package-internal create used by the test only if `fork` is not ready. Prefer implementing `fork` in Task 2 and in this task only replacing hardcoded root reads with `task.conversationId` while keeping root tests green.
- [ ] **Step 2: Run the durable turn, memory, and sqlite tests. Root tests must pass before the commit.**
- [ ] **Step 3: Replace `ROOT_CONVERSATION_ID` entry and document writes in phases with the task's conversation id and the key helpers. Root submit still uses id 1 and keys `agent` and `live`.**
- [ ] **Step 4: Re-run those tests.**
- [ ] **Step 5: Commit** `refactor(durable): read each conversation's own transcript`.

### Task 2: Copy entries through fork(atEntryId)

**Files:**
- Modify: `packages/durable/src/runtime/open.ts`
- Test: `packages/durable/src/runtime/turn.test.ts`

**Interfaces:**
- Produces: `DurableConversation.fork(atEntryId: number): Promise<DurableConversation>`.

- [ ] **Step 1: Write the failing fork tests from the spec.**
- [ ] **Step 2: Run the turn test file and confirm they fail.**
- [ ] **Step 3: Implement one-commit copy. New ids. Copy agent when present. Do not copy tasks, submissions, inbox, or live.**
- [ ] **Step 4: Re-run turn, memory, and sqlite tests.**
- [ ] **Step 5: Commit** `feat(durable): fork a conversation through one entry`.
