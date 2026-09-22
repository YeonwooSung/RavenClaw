# RavenClaw next-horizon roadmap (`ignored` dismiss-and-continue)

Date: 2026-09-21  
Status: implemented  
Shipped sha: `22a55c1` on `main` (PR #15).  
Reviewed against tree at `dc45aec` (`origin/main`, waist closed).  
Successor to `2026-09-20-leftover-ask-abort-pair.md` (Status: implemented). Amends prior OUT for **`ignored` as a leftover-ask result** only. Does not reopen abort-pair I2, tree-stop, dismiss-on-message, Grep/Glob docker-exec, or LSP depth.

Implementation plan: [2026-09-21-ignored-dismiss.md](../plans/2026-09-21-ignored-dismiss.md). Isolated worktree only.

Sources: current tree; [eve analysis](../../research/eve-analysis.md) durable HITL (`status: "ignored"` as a result label). Steal contracts. Do not copy eve source. Do not become an agent framework. Do not add a web UI.

---

## Where we are

Leftover-ask is durable (`pending_asks`, one row per `call_id`). Operator answers go through `applyAskAnswer`. Live HITL goes through `askUser`. Abort-pair I2 writes `ABORTED_TEXT`. `dontAsk` leftover is deny.

At `dc45aec`:

| Piece | Tree |
|---|---|
| `PendingAskAnswer` | `'allow' \| 'deny' \| 'allow_always'` (`packages/core/src/session/pending-asks.ts`). No answer column in SQL (schema v11). |
| Parked deny | Persist `permission_denied: ${message}`, then drop. No execute. No model turn. Persist fail leaves the row. |
| Parked allow | Execute, then persist tool row, then drop. |
| Unknown answer | **Falls through to execute** (`applyAskAnswerOnce`). |
| Live deny | `abortRest: false`; siblings still run; loop continues. |
| Live wrap `claimAsk` | `if (answer !== 'deny') claimAsk(...)` — a future `'ignored'` would be claimed today. |
| `askUser` throw | `AskWaiterExpired` → empty + **row stays**. Other abort → `ABORTED_TEXT`. |
| HTTP `POST …/resolve` | `{ callId, allow: boolean }` only. Live `settleAsk` first; else `applyAskAnswer`. Unmatched 404. |
| Ink / OpenTUI | `y` allow / `n` deny / `a` always. Esc is abort (`engine.abort('cancel')`), not deny. |
| Slack / Discord | Allow/Deny buttons. Durable timeout leaves the row. Non-durable timer → `'deny'`. |
| ACP | Timeout throws `AskWaiterExpired` (leave row). Editor `cancelled` maps to `'deny'`. |
| `submitMessage` | Unpaired owned ask → `{ type: 'status', message: 'pending permission ask' }`, no user row. |

eve steal: dismiss-and-continue for a **single** question; unmatched leftover responses re-queue. eve trigger (new user text auto-dismisses) stays parked. Amended by [`2026-09-21-dismiss-on-message.md`](2026-09-21-dismiss-on-message.md) (on `main` at `061d23c`).

This horizon unparks **one new answer** `'ignored'`.

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Hosts only `submitMessage` for new user text. **`applyAskAnswer` remains the only non-`submitMessage` closer for operator answers.** Extending its enum is this door. A fourth host entry is forbidden.
2. Pairing 1:1. Never a second tool row for the same `callId`. Persist-before-execute stays.
3. `dontAsk` never becomes `bypass`. Leftover in `dontAsk` stays deny, not ignored.
4. Abort-pair I2 stays `ABORTED_TEXT`. Ignored is an operator answer. Aborted is a stop.
5. Default prefix unchanged. No new tool.
6. No schema bump. v11 stays. Do not add `pending_asks.answer`.
7. BYOK. Clean-room. No web UI, Prisma Task, Socket.IO, wiki, Grep/Glob docker-exec, LSP depth.
8. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent.

---

## Do not build

- Dismiss-on-message (`submitMessage` auto-`ignored`)
- Dismiss-all / ignore-every-pending-row
- Slack/Discord Ignore button (3-way hosts stay valid)
- ACP skip option; remapping timeout / editor `cancelled` → ignored
- Timeout → ignored (Slack durable leave-row, ACP `AskWaiterExpired`, non-durable Slack timer-deny)
- Auto-start a model turn from `applyAskAnswer`
- Schema v12
- Grep/Glob docker-exec, LSP depth, web UI, Workflow park, default-auto-execute

Amend prior OUT **only** for `ignored` as a leftover-ask / live `askUser` result.

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

### Answer and persist

1. **`PendingAskAnswer` grows `'ignored'`.** `SessionEngineOptions.askUser` uses that type (stop duplicating the three-way union in `types.ts`).

2. **Stable tool text.** New `IGNORED_TEXT` in `pairing.ts`:

   ```
   ignored: the operator skipped this ask. The tool was not executed.
   ```

   `ok: false`. Must not start with `permission_denied:` or `aborted:`. Prefer the constant over a per-ask sentence so tests match one string.

3. **Persist-before-drop, deny-shaped, not I2.** Persist `makeToolMessage(callId, false, IGNORED_TEXT)`, then delete the pending row. Persist fail leaves the row. Do not execute. Do not `persistAllowAlways`. If I2 races with ignored: whoever persists first wins; the other sees paired and drop-only. Do not rewrite `ABORTED_TEXT` into `ignored` or vice versa.

4. **Unknown answers fail closed.** `'ignored'` is its own branch **before** execute. Any non-enum string from `applyAskAnswer` is `'unmatched'` and does **not** execute. Today’s fall-through-to-execute is a landmine; close it in this door for unknown values only. `'allow'` / `'deny'` / `'allow_always'` stay as today.

5. **Live wrap claims only execute-path answers.**

   ```ts
   if (answer === 'allow' || answer === 'allow_always') claimAsk(event.id)
   ```

   Do not keep `!== 'deny'` (that would claim `'ignored'` and risk a double pair).

### Live vs parked

6. **Live `askUser` → `'ignored'` continues the turn.** Same as live deny: `abortRest: false`, skip **only that call**, rest of the batch runs, `queryLoop` continues, model sees the ignored row.

7. **Parked `applyAskAnswer(..., 'ignored')` pairs only.** No execute, no `queryLoop`, no auto-`submitMessage`. After the pair, `submitMessage` is unblocked for **that** `callId`. Other parked rows stay.

8. **`submitMessage` pending-guard.** One-ask skip (`applyAskAnswer(..., 'ignored')` / Ink `i`) still pairs only and does not start a turn. Dismiss-and-continue of **all** parked owned asks on a new user message is amended by [`2026-09-21-dismiss-on-message.md`](2026-09-21-dismiss-on-message.md).

9. **Kind `'leftover'` and `'ask_user'` share the ignored path.** Kind-based auto-dismiss is a later door.

10. **Descendant match unchanged.** Parent `applyAskAnswer` may still pair a grandchild `callId`; the ignored row is written on `row.sessionId`.

### Hosts

11. **HTTP resolve envelope (compat).** Keep `{ callId, allow: boolean }` as the 2-way path. Add optional `answer?: PendingAskAnswer`.

    | Body | Meaning |
    |---|---|
    | `{ callId, allow: true\|false }` | allow / deny (today) |
    | `{ callId, answer: 'ignored'\|'allow'\|'deny'\|'allow_always' }` | that answer (`allow` may be omitted) |
    | both present and they disagree | **400** |
    | missing both / empty `callId` / unknown `answer` | **400** |

    Live `settleAsk` receives the mapped `PendingAskAnswer`. Unmatched still **404** `{ status: 'unmatched' }`. Crash-resolve still pairs only. Envelope honesty also lets HTTP express `allow_always`; that is not a new hole.

12. **Ink + OpenTUI skip key this door.** Ink `i`. OpenTUI `i` / `skip` / `ignored`. Esc stays abort. `y`/`n`/`a` unchanged.

13. **Slack / Discord / ACP stay 3-way.** They cannot emit `'ignored'` until a later door. Timeout/cancel mappings stay. Unmatched leftover responses still re-queue.

14. **`dontAsk` leftover stays deny.** `decidePermission` must not emit ignored.

15. **Abort stays abort.** Esc / `AbortError` / `abort('cancel'|'interrupt')` / I2 stay `ABORTED_TEXT`. Clear stays wipe, not an answer.

---

## Theme

The operator can skip **one** parked or live ask. The tool is not executed. Pairing holds. The live turn continues. A parked resolve does not start a model turn. Cancel, deny, and dontAsk keep their own texts.

---

## Per-slice board

Board as of `22a55c1` on `main` (PR #15). I0.1–I2 done.

| ID | Status vs tree |
|---|---|
| I0.1 Types and constant | **done** |
| I0.2 Parked branch + unknown fail-closed | **done** |
| I1.1 `executeOneCall` | **done** |
| I1.2 Resolve envelope | **done** |
| I1.3 TUI | **done** |
| I2 Eval + docs | **done** |

---

## Wave I0 — Enum + persist

### I0.1 Types and constant

**Contract.** `PendingAskAnswer += 'ignored'`. `IGNORED_TEXT`. `askUser` return type uses `PendingAskAnswer`.

**Files.** `packages/core/src/session/pending-asks.ts`, `packages/core/src/types.ts`, `packages/core/src/loop/pairing.ts`.

**Done when.** Typecheck of core; pairing test asserts `IGNORED_TEXT` is distinct from `ABORTED_TEXT` and `permission_denied`.

### I0.2 Parked branch + unknown fail-closed

**Contract.** `applyAskAnswerOnce`: `'ignored'` persist-then-drop, no execute, no `allow_always`. Unknown → `'unmatched'`. Live wrap claims only allow / allow_always.

**Files.** `packages/core/src/loop/session-engine.ts`, `session-engine.test.ts` / `query-loop.test.ts`.

**Done when.** `applyAskAnswer ignored` persists `IGNORED_TEXT`, deletes the row, `executeCount` 0; missing id `'unmatched'`; ignored does not write an allow-always rule.

---

## Wave I1 — Live loop + HTTP + TUI

### I1.1 `executeOneCall`

**Contract.** Live `'ignored'` like deny (`abortRest: false`). Live ignored then a second `applyAskAnswer` does not double-pair. `AskWaiterExpired` still empty+row. Abort throw still `ABORTED_TEXT`.

**Files.** `packages/core/src/loop/phases.ts`, `query-loop.test.ts`.

### I1.2 Resolve envelope

**Contract.** Ruling 11 in `parseResolveBody` + serve handler. Live settle `'ignored'` without `applyAskAnswer`. Crash-resolve ignored pairs only. Unmatched 404. `{ callId, allow: false }` still deny.

**Files.** `packages/core/src/gateway/http.ts`, `packages/cli/src/serve.ts`, `http.test.ts`, `serve.test.ts`.

### I1.3 TUI

**Contract.** Ink `i`, OpenTUI `i`/`skip`/`ignored`. Esc abort. Dialog copy mentions skip.

**Files.** `packages/cli/src/permission-dialog.tsx`, `app.tsx`, `opentui-app.ts` + tests.

---

## Wave I2 — Eval + docs

**Contract.** Optional sibling of `pending-ask-persist` that pairs via `'ignored'` and asserts not `permission_denied`. Do not change the existing deny fixture. Docs: `ARCHITECTURE.md` / `.ko.md`, `docs/headless.md`, `SLASH_COMMANDS.md` / `.ko.md`. Point at this spec from eve-inspired “no `ignored`” history; do not rewrite 2026-09-15 except a pointer.

**Files.** `packages/core/src/eval/run.ts` (optional fixture), docs listed.

---

## File map

| Path | Wave |
|---|---|
| `packages/core/src/session/pending-asks.ts` | I0 |
| `packages/core/src/types.ts` | I0 |
| `packages/core/src/loop/pairing.ts` | I0 |
| `packages/core/src/loop/session-engine.ts` | I0 |
| `packages/core/src/loop/phases.ts` | I1 |
| `packages/core/src/gateway/http.ts` | I1 |
| `packages/cli/src/serve.ts` | I1 |
| `packages/cli/src/permission-dialog.tsx` | I1 |
| `packages/cli/src/app.tsx` | I1 |
| `packages/cli/src/opentui-app.ts` | I1 |
| eval fixture (optional) + docs | I2 |

Leave Slack/Discord/ACP adapters on 3-way.

---

## Success checks

1. Parked `'ignored'` → one `IGNORED_TEXT` row, pending gone, tool not executed, no model turn.
2. Live `'ignored'` → loop continues; siblings run; no `ABORTED_TEXT`.
3. `{ callId, answer: 'ignored' }` resolve 200 matched; `{ callId, allow: false }` still deny; disagreeing fields 400.
4. Esc / cancel I2 still `ABORTED_TEXT`. Parent interrupt still leaves a child leftover-ask.
5. `dontAsk` leftover still deny. ACP timeout still leaves the row.
6. `submitMessage` with a remaining other parked ask still `pending permission ask`.
7. Unknown `applyAskAnswer` string is `'unmatched'` and does not execute.

---

## Tests that stay green (do not retarget)

Live cancel abort-pair; parent interrupt leaves a child leftover-ask; persist-fail on cancel leaves the row; `pending-ask-persist` eval deny; ACP timeout leave-row; Slack durable timer does not deny; `dontAsk` leftover deny; serve resolve unmatched 404; keep-id `/clear` refuse child unpaired ask.

---

## Out of this closeout

Dismiss-on-message, dismiss-all, Slack/Discord/ACP skip UI, timeout→ignored, schema v12, Grep/Glob docker-exec, LSP depth, web UI, Prisma Task, Socket.IO, wiki, eve default-auto-execute, Workflow park.

---

## Hard rulings recap

1. Fourth answer on `applyAskAnswer` / `askUser` only. No fourth host entry.
2. `IGNORED_TEXT`; persist-then-drop; no execute; no `allow_always`.
3. Live continues; parked pairs only; `submitMessage` still blocked on other unpaired asks.
4. Unknown answers unmatched. Claim wrap is allow / allow_always only.
5. HTTP optional `answer` field; 2-way `allow` stays. Ink/OpenTUI `i`. Slack/ACP stay 3-way.
6. No schema bump. I2 stays aborted. `dontAsk` stays deny.
