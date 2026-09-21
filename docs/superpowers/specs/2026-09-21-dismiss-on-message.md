# RavenClaw next-horizon roadmap (dismiss-on-message)

Date: 2026-09-21  
Status: **implemented**  
Reviewed against tree at `0a1176f` (`origin/main`, instructionFiles + three doors landed).  
Successor to `2026-09-21-ignored-dismiss.md` (Status: implemented). Amends prior OUT for **dismiss-on-message** only. Does not reopen abort-pair I2, Slack/ACP skip UI, timeout→ignored, WorkspaceFs docker, or NotebookEdit docker.

Implementation plan: [docs/superpowers/plans/2026-09-21-dismiss-on-message.md](../plans/2026-09-21-dismiss-on-message.md). Isolated worktree only. Do not implement on `main`.

Sources: current tree; [eve analysis](../../research/eve-analysis.md) “single open question + a new user message = dismiss-and-continue (`status: ignored`).” Steal contracts. Do not copy eve source. Do not become an agent framework. Do not add a web UI.

---

## Where we are

`'ignored'` is a fourth `PendingAskAnswer`. Parked `applyAskAnswer(..., 'ignored')` persist-then-drops `IGNORED_TEXT` and does **not** start a model turn. Live `askUser` → `'ignored'` continues the turn. Ink/OpenTUI `i` skips **one** ask. `submitMessage` still **blocks** when any unpaired owned pending ask remains.

At `0a1176f`:

| Piece | Tree |
|---|---|
| `submitMessage` pending-guard | `listOwnedPendingAsks()` (this session **+ descendants**). Unpaired row → yield `{ type: 'status', message: 'pending permission ask' }`, return `{ reason: 'completed' }`, **no user row**. |
| `applyAskAnswer` | Only non-`submitMessage` closer. `'ignored'` persist-then-drop, no execute, no `queryLoop`. |
| `IGNORED_TEXT` | `ignored: the operator skipped this ask. The tool was not executed.` |
| Live HITL | Inside `queryLoop` via `askUser`. New TUI text during a live turn is steer/queue, not this guard. |
| HTTP `POST …/submit` | Calls `submitMessage`. Today a parked ask makes submit a no-op status. |
| ACP | `session/prompt` may `replayPendingAsks` **before** `submitMessage`. Timeout leaves the row. |
| `clearKeepId` / `rewindLast` | Still refuse with `pending permission ask`. |
| Follow-up | `runFollowupAfterSubmit` skips when owned leftover-asks remain. |
| Slack / Discord / ACP | Still 3-way. They cannot emit `'ignored'` (skip UI is a later door). |
| Schema | v11. No `pending_asks.answer` column. |

ignored-dismiss ruling 8: “`submitMessage` pending-guard unchanged. That is dismiss-and-continue for a **single** question without dismiss-on-message.” This horizon unparks **that trigger**: a new user message closes parked asks as ignored, then continues.

eve: approvals do **not** dismiss-on-message. Permission **answers** still go through `applyAskAnswer`. This door is **user text**, not an allow.

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Hosts only `submitMessage` for new user text. **`applyAskAnswer` remains the only non-`submitMessage` closer for operator answers.** Dismiss-on-message runs **inside** `submitMessage` by reusing the parked `'ignored'` persist path. A fourth host entry is forbidden.
2. Pairing 1:1. Never a second tool row for the same `callId`. Persist-before-drop stays.
3. `dontAsk` never becomes `bypass`. Leftover in `dontAsk` stays deny at decision time (no parked ask to dismiss).
4. Abort-pair I2 stays `ABORTED_TEXT`. Dismiss-on-message is ignored, not aborted.
5. Default prefix unchanged. No new tool. No schema bump (v11).
6. BYOK. Clean-room. No web UI, Prisma Task, Socket.IO, wiki, WorkspaceFs docker, NotebookEdit docker.
7. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent.

---

## Do not build

- Slack/Discord Ignore button; ACP skip option (3-way hosts stay valid; they gain dismiss-on-message **for free** if they `submitMessage` with new text)
- Timeout → ignored (Slack durable leave-row, ACP `AskWaiterExpired`, non-durable Slack timer-deny stay)
- Auto-start a model turn from `applyAskAnswer` (parked ignored still pairs only)
- Changing live `askUser` (live skip stays the `i` key / `'ignored'` answer; a live turn is not `submitMessage`)
- Steer/queue policy changes; dismiss is **not** a steer
- `clearKeepId` / `rewindLast` auto-ignore (they still refuse `pending permission ask`)
- Schema v12
- Kind-based auto-dismiss (`leftover` vs `ask_user` treated differently)
- WorkspaceFs docker, NotebookEdit docker, web UI, Workflow park

Amend prior OUT **only** for dismiss-on-message (`submitMessage` auto-`ignored`).

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

### Trigger

1. **Trigger is `submitMessage` with unpaired owned pending asks.** After `whenTreeStop` / rewind recovery, **before** `UserPromptSubmit` / appending the user row. If every owned pending row is already paired, today’s drop-stale-row path stays (drop and continue). If none remain unpaired, do not yield `pending permission ask`.

2. **Dismiss the rows that today set `askBlocked`.** That set is `listOwnedPendingAsks()`: this session **and descendants**, unpaired only. A parent new message ignores a child leftover-ask (row written on `row.sessionId`). This is what unblocks `submitMessage`. Do not leave a child row that would re-block.

3. **Reuse parked `'ignored'`.** For each unpaired owned row, call the same persist-then-drop path as `applyAskAnswerOnce(..., 'ignored')` (`IGNORED_TEXT`, no execute, no `allow_always`, no `queryLoop` per row). Prefer calling `applyAskAnswer(callId, 'ignored')` (or a shared helper both use) so races with a concurrent resolve stay one-winner: whoever persists first wins; the other sees paired and drop-only. Do not rewrite `ABORTED_TEXT` into ignored or vice versa.

4. **All-or-nothing before the user row.** Walk rows sequentially. If any persist fails, **stop**. Do not append the user message. Do not start `queryLoop`. Leave remaining unpaired rows. Yield `{ type: 'status', message: 'pending permission ask' }` (same string as today — persist-fail already leaves the row; do not invent a second blocked notice). Partial ignored pairs that already landed stay landed (pairing 1:1); the operator retries submit.

5. **Then continue as a normal submit.** After every owned unpaired row is paired or gone, fall through to today’s `UserPromptSubmit` → persist user row → `queryLoop`. The model sees the ignored tool rows **then** the new user text (dismiss-and-continue). Do **not** yield `pending permission ask` on the success path. Optional single status `ignored N pending ask(s)` is allowed; default is **quiet** (no extra status) so HTTP/TUI clients that key on `pending permission ask` do not misfire.

6. **Empty / whitespace-only text.** If today’s `submitMessage` already accepts that input, dismiss-then-continue still runs (the user sent a delivery). Do not special-case empty as “dismiss only, no turn” unless current empty-text law already refuses the turn — do not change empty-text law this door.

7. **Dismiss only when `liveTurn === null`.** If `liveTurn !== null`, keep today’s block (`pending permission ask`) and do not ignore rows. Do **not** add a steer. Do **not** call `abort('cancel')` to dismiss. Live `askUser` skip stays the `i` key / `'ignored'` answer inside `queryLoop`. Leftover-ask parks the loop, so the parked case this door cares about is idle + unpaired rows.

### What stays

8. **`applyAskAnswer` API unchanged.** Parked `'ignored'` still pairs only and does not start a turn. Hosts that want to skip **one** ask without sending user text keep `applyAskAnswer(..., 'ignored')` / Ink `i`.

9. **`clearKeepId` / `rewindLast` / HTTP `POST …/clear` still refuse** with `pending permission ask`. Dismiss is not an undo and not a clear.

10. **Abort stays abort.** Esc / `abort('cancel'|'interrupt')` / I2 stay `ABORTED_TEXT`. A new user message is not a cancel.

11. **`dontAsk` leftover stays deny** at decision time. No parked dontAsk ask to auto-ignore.

12. **Follow-up.** After a successful dismiss-and-continue submit that writes `lastEnd`, `runFollowupAfterSubmit` may run (owned leftover-asks are gone). That is correct. Do not special-case skip.

13. **ACP replay.** ACP may still drain `replayPendingAsks` before `submitMessage`. If the operator already answered via replay, `submitMessage` sees no unpaired rows and does not double-ignore. If replay times out and leaves rows, `submitMessage` of new prompt text now dismisses them (this is the product). Do not change ACP timeout → `AskWaiterExpired` leave-row for the **replay** waiter itself.

14. **HTTP resolve envelope unchanged.** `{ callId, allow }` and optional `answer` stay. Submit-with-text is the dismiss trigger, not a new resolve body.

15. **Slack / Discord / ACP skip UI still out.** A Slack follow-up **message** that goes through `submitMessage` will dismiss parked asks (ruling 2) because it is new user text. That is dismiss-on-message, not a new Ignore button. Button payloads stay allow/deny.

16. **Approvals do not dismiss-on-message.** `applyAskAnswer('allow')` still executes that one tool and does not ignore siblings. Sibling parked rows remain until ignored, denied, allowed, or a later `submitMessage`.

---

## Theme

New user text means the operator moved on. Every parked owned ask is paired as ignored, then the text runs. One-ask skip (`i` / `applyAskAnswer`) stays. Cancel stays aborted. Clear/rewind still refuse while a row is open.

---

## Per-slice board

Board as of this worktree (done). Leave Shipped sha empty until it lands on `main`.

| ID | Status vs tree |
|---|---|
| D0.1 `submitMessage` dismiss-then-continue | **done** |
| D0.2 Persist-fail all-or-nothing | **done** |
| D1.1 Child leftover-ask on parent submit | **done** |
| D1.2 Live turn / applyAskAnswer / clear / rewind pins | **done** |
| D2 Eval + docs | **done** |

---

## Wave D0 — Guard becomes dismiss

### D0.1 Success path

**Contract.** Unpaired owned asks + `submitMessage({ text })` + `liveTurn === null`: each row persist `IGNORED_TEXT` then drop; user row appended; `queryLoop` runs; no `pending permission ask` status (unless ruling 5 optional notice). Model transcript has ignored tool rows immediately before the new user message.

**Files.** `packages/core/src/loop/session-engine.ts`, `session-engine.test.ts`.

### D0.2 Persist-fail

**Contract.** Ruling 4. A test that fails persist on the second of two rows: first ignored is paired; second remains; no user row; status `pending permission ask`.

---

## Wave D1 — Edges

### D1.1 Descendants

**Contract.** Parent `submitMessage` ignores an unpaired child leftover-ask (`row.sessionId` = child). Parent then runs. Child pending row gone; child messages have `IGNORED_TEXT`.

### D1.2 Pins

**Contract.** `applyAskAnswer(..., 'ignored')` still does not start a turn. `clearKeepId` / `rewindLast` still `{ ok: false, notice: 'pending permission ask' }` while unpaired rows exist (they do **not** auto-ignore). Esc/I2 still `ABORTED_TEXT`. Concurrent `applyAskAnswer('allow')` vs dismiss: first persist wins. Live `askUser` skip still `i`. HTTP `{ callId, allow: false }` still deny.

**Files.** `session-engine.test.ts`, existing rewind/clear tests (do not retarget).

---

## Wave D2 — Eval + docs

**Contract.** New eval fixture `dismiss-on-message` sibling of `ignored-dismiss`: seed a leftover-ask, `submitMessage` new text, assert `IGNORED_TEXT` then the user row, tool not executed, no `permission_denied`, no `ABORTED_TEXT`. Do not change `ignored-dismiss` or `pending-ask-persist`. Docs: `ARCHITECTURE.md` / `.ko.md`, `docs/headless.md`. Point at this spec from ignored-dismiss ruling 8 / eve-inspired “dismiss-on-message stays parked”; do not rewrite 2026-09-15 except a pointer.

**Files.** `packages/core/src/eval/run.ts`, new fixture, docs listed.

---

## File map

| Path | Wave |
|---|---|
| `packages/core/src/loop/session-engine.ts` | D0, D1 |
| `packages/core/src/loop/session-engine.test.ts` | D0, D1 |
| `packages/core/src/eval/run.ts` + fixture | D2 |
| `docs/headless.md`, `ARCHITECTURE.md`, `ARCHITECTURE.ko.md` | D2 |
| pointer lines in `2026-09-21-ignored-dismiss.md`, eve-analysis en/ko | D2 |

Do not touch: Slack/Discord/ACP adapter button sets, `pending-asks.ts` enum (already has `'ignored'`), schema, WorkspaceFs, NotebookEdit, Grep/Glob.

---

## Success checks

1. Parked leftover-ask + `submitMessage('go on')` → one `IGNORED_TEXT` row, pending gone, tool not executed, user row present, `queryLoop` ran.
2. Two parked rows → both ignored, then one user row.
3. Persist-fail mid-list → no user row; `pending permission ask`; already-paired ignored stays paired.
4. Child leftover-ask is ignored on parent submit; parent is not blocked.
5. `applyAskAnswer('ignored')` still does not start a turn. Ink `i` still one-ask.
6. `clearKeepId` / `rewindLast` still refuse while unpaired.
7. I2 / Esc still `ABORTED_TEXT`. `dontAsk` leftover still deny.
8. `ignored-dismiss` and `pending-ask-persist` evals stay green.

---

## Tests that stay green (do not retarget)

Live cancel abort-pair; persist-fail on cancel leaves the row; `pending-ask-persist` eval deny; `ignored-dismiss` eval; ACP timeout leave-row; Slack durable timer does not deny; `dontAsk` leftover deny; serve resolve unmatched 404; keep-id `/clear` refuse child unpaired ask (**clear**, not submit); rewind refuse pending permission ask.

---

## Out of this closeout

Slack/ACP skip UI, timeout→ignored, schema v12, auto-turn from `applyAskAnswer`, clear/rewind auto-ignore, live-turn dismiss, WorkspaceFs docker, NotebookEdit docker, web UI, Prisma Task, Socket.IO, wiki, eve default-auto-execute.

---

## Hard rulings recap

1. Dismiss lives inside `submitMessage`. No fourth host entry.
2. Every unpaired owned row (this session + descendants) → `IGNORED_TEXT` persist-then-drop, then the user text runs.
3. Persist-fail stops before the user row. Partial pairs stay.
4. `applyAskAnswer` / `i` / abort / clear / rewind / dontAsk keep their own laws.
5. No schema bump. No skip buttons on Slack/ACP this door.
