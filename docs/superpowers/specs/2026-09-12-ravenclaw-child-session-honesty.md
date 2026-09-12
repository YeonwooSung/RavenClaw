# RavenClaw child-session honesty

Date: 2026-09-12  
Status: approved for spec (not implemented)  
Supersedes: gateway spec slices **A2 report** and **A3 steer** in `2026-09-12-ravenclaw-gateway-and-parallel-agents.md`. Isolation cleanup already keeps dirty trees; this spec adds the parent-visible report and live-child steer.  
Does not extend `2026-09-12-ravenclaw-remaining-roadmap.md`.

Steal contracts. Do not copy Hermes source.

---

## Why

Background `Agent` children already run in-process through `TaskRegistry`. Two honesty holes remain:

1. `prepareChildWorktree` already skips `git worktree remove` when the tree is dirty, but the parent tool result does not say so. The operator cannot find `.ravenclaw/worktrees/<childSessionId>`.
2. The parent `SessionEngine` has `enqueueSteer` → `injectMidTurnHint`. Child engines are not in the registry, so `/steer` and no tool can aim at a live child.

This spec closes those holes. It does not add Discord, pairing, a delivery ledger, `execute_code`, or automatic worktree GC.

---

## Constraints

1. One `queryLoop`. Hosts still only call `submitMessage`.
2. Persist-before-execute and pairing stay law. Steer does not re-execute tools.
3. `dontAsk` is not `bypass`.
4. Default tool prefix stays small. `TaskSteer` is one small always-on schema next to `TaskOutput` / `TaskStop`.
5. Children cannot spawn `Agent` and cannot steer siblings.

---

## Locked decisions

| Topic | Choice |
|---|---|
| Steer surface | New tool `TaskSteer` + slash `/tasks steer <id> <text>` |
| Who can be steered | Live in-process Agent tasks only (`type === 'agent'` and `status === 'running'` with an attached engine) |
| Dead / other-process child | Error. Do not persist a user row. Do not open a new child turn. |
| Sync `Agent` (parent blocked) | No task id. Not a `TaskSteer` target. |
| Bash background tasks | Not steerable. |
| Dirty worktree | Report `{ path, dirty, pruned }`. Clean trees are removed as today. No auto-GC. No `/worktrees` slash. |
| Implementation axis | `TaskRegistry.attachEngine` + `steer`; worktree JSON is the last line of the child tool result |

---

## 1. TaskRegistry

`packages/core/src/tasks/registry.ts`.

Add process-local fields on the live task (not on `TaskSnapshot` persisted anywhere — snapshots stay JSON-safe):

```ts
attachEngine(id: string, engine: { enqueueSteer(text: string): void }): void
steer(id: string, text: string): { ok: true } | { ok: false; error: string }
```

Rules:

- `register` is unchanged. Background `Agent` still registers **before** the engine exists.
- `spawnChild` calls `attachEngine(taskId, engine)` immediately after `createSessionEngine`.
- `complete` / `kill` drop the engine handle.
- `steer`:
  - missing id, `type !== 'agent'`, or `status !== 'running'` → `{ ok: false, error: 'not a live agent task' }`
  - running agent but no engine yet → `{ ok: false, error: 'agent not started' }`
  - `text.trim() === ''` → `{ ok: false, error: 'empty text' }`
  - else `engine.enqueueSteer(text)` and `{ ok: true }`

The handle is memory only. It is not written to the store, the task log, or FTS.

---

## 2. TaskSteer

`packages/core/src/tools/task.ts` (same file as `TaskOutput` / `TaskStop`).

```ts
{ taskId: string, text: string }
```

- `isReadOnly() === true`.
- `checkPermissions` always `{ behavior: 'allow', reason: 'mode' }`. No leftover-ask (unlike `TaskStop`, which kills a process).
- `dontAsk` may call it.
- `execute` calls `ctx.tasks.steer(taskId, text)`.
  - fail → `TaskSteer failed: <error>`
  - ok → `steered <taskId> <preview>` where preview is the first 40 characters of trimmed text
- `isEnabled` follows the same rule as `TaskOutput` (registry present).
- Root pool only. Child tool pool excludes `TaskSteer` (same deny list as `Agent` / nesting).

Slash: extend `/tasks`:

```
/tasks                 list
/tasks kill <id>       existing
/tasks steer <id> <text>
```

Ink and OpenTUI call the same `registry.steer`. No new panel.

Parent `/steer <text>` is unchanged: it still targets the **parent** live turn only.

---

## 3. Background spawn hookup

`startBackgroundAgent` in `packages/core/src/tools/agent.ts`:

1. `register` + return `{ status: 'dispatched', taskId, childSessionId }` (unchanged).
2. Inside `spawnChild`, after `createSessionEngine`, `ctx.tasks.attachEngine(taskId, engine)`.
3. On child terminal, `complete` as today. Mailbox line unchanged.
4. `TaskSteer` before step 2 fails with `agent not started`. The caller may retry. Nothing is persisted.

Sync `Agent` (no `run_in_background`) does not register a task and does not attach an engine.

---

## 4. Worktree report

`packages/core/src/tools/worktree.ts`: `cleanup()` returns:

```ts
{ path: string, dirty: boolean, pruned: boolean }
```

Behavior stays:

- `isolation !== 'worktree'` or not a git repo → no worktree, no report.
- Dirty (`git status --porcelain` nonempty, or git failed) → do not remove. `{ dirty: true, pruned: false }`.
- Clean → `worktree remove` (force only if still clean after a failed non-force). `{ dirty: false, pruned: true }`.

`spawnChild` `finally` still calls `cleanup()`. If a real worktree was created, append **one last line** to the child tool result:

```json
{"worktree":{"path":"/abs/.ravenclaw/worktrees/<childSessionId>","dirty":true,"pruned":false}}
```

`path` is always the worktree path (even when `pruned: true`).

Placement: after `SetOutput` / last-assistant / abort text, after the 32k bind. If adding the JSON line would exceed the bound, shrink the body so the JSON line fits.

`isolation: none` and fallback-to-parent-cwd: no JSON line.

No session-start sweeper. No `/worktrees`. Operators remove leftovers with `git worktree remove`.

---

## 5. Mid-turn inject (unchanged)

Child `enqueueSteer` uses the existing parent path: `drainSteering` in `finalizeRound` → `injectMidTurnHint` (prefer last tool text, else last assistant, else user last-resort) → persist the mutated row. Pairing stays 1:1. Tools already executed are not re-run.

---

## 6. Tests

Targeted `bun test` only (never full-repo).

| File | Cases |
|---|---|
| `packages/core/src/tasks/registry.test.ts` | `steer` before `attachEngine` fails `agent not started`; after attach, `enqueueSteer` called once; Bash id and completed id fail `not a live agent task`; empty text fails |
| `packages/core/src/tools/task.test.ts` | parse; `isReadOnly` true; permissions allow; missing id; empty text |
| `packages/core/src/tools/agent.test.ts` | worktree dirty → path remains on disk and last line is `dirty: true, pruned: false`; clean → path gone, `pruned: true`; `isolation: none` → no JSON line |
| `packages/core/src/tools/agent.test.ts` | background child + `TaskSteer` suffixes the next tool result; child `execute` count unchanged |
| `packages/cli/src/commands.test.ts` | `/tasks steer t_1 hello` → `{ name: 'tasks', arg: 'steer t_1 hello' }` |

---

## 7. Files

| Path | Change |
|---|---|
| `packages/core/src/tasks/registry.ts` | `attachEngine`, `steer` |
| `packages/core/src/tools/task.ts` | `taskSteerTool` |
| `packages/core/src/tools/agent.ts` | attach after engine create; append worktree JSON |
| `packages/core/src/tools/worktree.ts` | `cleanup` returns `{ path, dirty, pruned }` |
| `packages/core/src/agent/root.ts` and CLI `createRootTools` | register `TaskSteer`; exclude from child pool |
| `packages/cli/src/commands.ts` | `/tasks` usage |
| `packages/cli/src/app.tsx`, `opentui-app.ts` | `/tasks steer` |
| tests listed above | |

---

## 8. Out of scope

- Discord, pairing CLI, delivery ledger (see the sibling spec)
- `execute_code`, computer-use
- Giving sync `Agent` a task id so it can be steered
- Steering Bash tasks
- Auto-delete of dirty worktrees
- Changing parent `/steer`
- Opening a child session in another process to deliver “steer”

---

## Done when

1. `/tasks steer <id> <text>` on a running background Agent injects the text on the child’s next tool round and does not re-run tools.
2. The same call on a finished task, a Bash task, or before the engine attaches, returns the errors in §1 and persists nothing.
3. A dirty worktree remains under `.ravenclaw/worktrees/<id>` and the parent result’s last line reports `dirty: true, pruned: false`.
4. A clean worktree is removed and the last line reports `pruned: true`.
