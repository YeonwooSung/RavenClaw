# RavenClaw next-horizon roadmap (Slack / Discord / ACP skip UI)

Date: 2026-09-22  
Status: implemented  
Shipped sha:  
Reviewed against tree at `061d23c` (`origin/main`, ignored dismiss + dismiss-on-message landed).  
Successor to `2026-09-21-ignored-dismiss.md` and `2026-09-21-dismiss-on-message.md` (Status: implemented). Amends prior OUT for **Slack / Discord / ACP emitting `'ignored'`** only. Does not reopen abort-pair I2, timeout→ignored, editor `cancelled`→ignored, a fourth host entry, schema v12, or docker writers.

Implementation plan: [docs/superpowers/plans/2026-09-22-hitl-skip-hosts.md](../plans/2026-09-22-hitl-skip-hosts.md). Isolated worktree only. Do not implement on `main`.

Sources: current tree; [eve analysis](../../research/eve-analysis.md) durable HITL skip. Steal contracts. Do not copy eve source. Do not become an agent framework. Do not add a web UI.

---

## Where we are

`'ignored'` is already a `PendingAskAnswer`. Parked `applyAskAnswer(..., 'ignored')` persist-then-drops `IGNORED_TEXT`. Live `askUser` → `'ignored'` continues the turn. Ink `i`; OpenTUI `i` / `skip` / `ignored`. HTTP resolve accepts `answer: 'ignored'`. New user text dismisses owned leftover-asks (dismiss-on-message).

Slack, Discord, and ACP still cannot emit `'ignored'`.

At `061d23c`:

| Piece | Tree |
|---|---|
| Slack | Buttons Allow / Deny (`raven_allow` / `raven_deny`). Text `allow`/`yes` / `deny`/`no`. Type `SlackPermissionAnswer = 'allow' \| 'deny' \| 'allow_always'` (`allow_always` is unused in parse). Channel non-DM auto-deny. Durable timeout leaves the row; non-durable timer → `'deny'`. |
| Discord | Text `allow`/`yes` / `deny`/`no`. No Ignore. Same durable / timer / non-DM deny. Type includes unused `allow_always`. |
| ACP | `PERMISSION_OPTIONS` = allow / allow_always / deny. `permissionOutcome` maps unknown and `cancelled` to `'deny'`. Sensitive `.env` / `id_rsa` hides `allow_always`. Timeout `AskWaiterExpired` (leave row). |
| Engine | Already accepts `'ignored'` from `askUser` and `applyAskAnswer`. |

This horizon is **host parity**: those three hosts grow a skip control that returns `'ignored'`. The engine does not change.

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Hosts only `submitMessage` for new user text. **`applyAskAnswer` remains the only non-`submitMessage` closer.** Skip is `'ignored'` through existing `askUser` / `applyAskAnswer`. No fourth host entry.
2. Pairing 1:1. Persist-before-execute stays. Parked ignored still does not start a model turn. Live ignored still continues (`abortRest: false`).
3. `dontAsk` leftover stays deny, not ignored. Non-DM Slack/Discord still auto-deny (not skip).
4. Abort-pair I2 stays `ABORTED_TEXT`. Timeout / editor `cancelled` stay as today (deny or leave-row). Skip is an operator answer.
5. Default prefix unchanged. No new tool. No schema bump.
6. BYOK. Clean-room. No web UI.
7. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent.

---

## Do not build

- Timeout → ignored (Slack durable leave-row, non-durable timer-deny, ACP `AskWaiterExpired`)
- Editor `cancelled` / abort → ignored (stay `'deny'` / `ABORTED_TEXT` as today)
- Remapping non-DM auto-deny to ignored
- Slack/Discord Allow-always button (type may keep `allow_always`; this door does not add a fourth approval)
- Changing Ink / OpenTUI / HTTP resolve (already 4-way)
- Auto-start a model turn from `applyAskAnswer`
- Dismiss-all host button (dismiss-on-message already covers new user text)
- Schema v12, docker Memory / file-history, web UI, LSP museum

Amend prior OUT **only** for Slack / Discord / ACP skip UI.

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

1. **IN is skip UI on Slack, Discord, and ACP.** Each host can emit `'ignored'`. Engine, pairing, HTTP, Ink, OpenTUI stay.

2. **Stable answer.** Hosts return `'ignored'` (the existing `PendingAskAnswer`). Do not invent `'skip'` as an engine answer. Map user-facing copy **Skip** onto `'ignored'`.

3. **Slack buttons.** `permissionBlocks` grows a third button: plain text `Skip`, `action_id: 'raven_skip'`, `value: callId`. No `style: 'danger'` on Skip (Deny keeps danger). `permissionAnswerOf`: `raven_skip` → `'ignored'`. Unknown `action_id` still `undefined` (re-queue).

4. **Slack / Discord text.** `parsePermitReply` accepts `skip`, `ignore`, `ignored` (trim + lower, whole message like today’s `allow`/`deny`). Prompt copy: durable `Reply *allow*, *deny*, or *skip*.` (Discord: without markdown stars if today’s Discord prompt has none). Non-durable adds the seconds in the same place as today. Do **not** parse `always` / `allow_always` this door.

5. **Types.** `SlackPermissionAnswer` and `DiscordPermissionAnswer` add `'ignored'`. `applyAskAnswer` on those bound sessions already forwards the host answer; widening the union is enough for crash-resume skip. ACP `AcpPermissionAnswer` adds `'ignored'`.

6. **ACP option.** Append to `PERMISSION_OPTIONS` (after deny):

   ```
   { optionId: 'ignored', name: 'Skip', kind: 'reject_once' }
   ```

   Sensitive-path filter still drops **only** `allow_always`. Skip remains available on `.env` / `id_rsa`. `mapPermissionOptionId`: `ignored` / `skip` / `ignore` → `'ignored'`. `cancelled` and unknown stay `'deny'`. Do not add a new `PermissionOptionKind`.

7. **Timeout / cancel unchanged.** Slack durable timeout still leaves the row. Slack/Discord non-durable timer still `'deny'`. ACP timeout still `AskWaiterExpired`. ACP `cancelled` still `'deny'`. Esc / `abort('cancel')` still `ABORTED_TEXT`.

8. **Non-DM unchanged.** Slack/Discord `askUser` outside a DM still returns `'deny'` immediately, no prompt, no skip.

9. **Crash-resume.** Slack/Discord leftover button/text skip calls `applyAskAnswer(callId, 'ignored')` and does not `submitMessage` (same shape as today’s allow-button crash-resume tests).

10. **Docs honesty.** `ARCHITECTURE.md` / `.ko.md`, `SLASH_COMMANDS.md` / `.ko.md`: Slack/Discord/ACP skip = `'ignored'`. Stop saying they stay 3-way. CHANGELOG Unreleased bullet. Pointer from ignored-dismiss ruling 13. Do not rewrite 2026-09-15 except a pointer.

---

## Theme

Every HITL host can skip one ask. The tool is not executed. Pairing holds. Cancel, deny, dontAsk, and timeout keep their own texts.

---

## Per-slice board

Board as of this worktree (done). Leave Shipped sha empty until it lands on `main`.

| ID | Status vs tree |
|---|---|
| S1 Slack Skip button + text | **done** |
| S2 Discord skip text | **done** |
| S3 ACP Skip option | **done** |
| S4 Docs | **done** |

---

## Wave S1 — Slack

**Contract.** Ruling 3–5, 7–9 for Slack. Tests: `permissionBlocks` has Skip; `raven_skip` / text `skip` settle `'ignored'`; `raven_deny` still deny; durable timeout still leaves the row; crash-resume skip uses `applyAskAnswer`.

**Files.** `packages/cli/src/slack/adapter.ts`, `types.ts`, `adapter.test.ts`.

---

## Wave S2 — Discord

**Contract.** Ruling 4–5, 7–9 for Discord. Tests: text `skip`/`ignore`/`ignored` → `'ignored'`; `deny` unchanged; prompt mentions skip; crash-resume skip uses `applyAskAnswer`.

**Files.** `packages/cli/src/discord/adapter.ts`, `types.ts`, `adapter.test.ts`.

---

## Wave S3 — ACP

**Contract.** Ruling 6–7. Tests: `permissionOutcome` selected `ignored`/`skip` → `'ignored'`; `cancelled` → `'deny'`; `PERMISSION_OPTIONS` includes Skip; sensitive path still has Skip and still hides `allow_always`; server `askUser` returns `'ignored'` when the editor selects Skip.

**Files.** `packages/acp/src/protocol.ts`, `protocol.test.ts`, `server.ts`, `server.test.ts`.

---

## Wave S4 — Docs

**Contract.** Ruling 10. Spec Status → implemented after code.

**Files.** `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`, `SLASH_COMMANDS.md`, `SLASH_COMMANDS.ko.md`, `CHANGELOG.md`, `docs/research/eve-analysis.md` / `.ko.md` closer pointer, `docs/superpowers/specs/2026-09-21-ignored-dismiss.md` ruling 13 amendment.

---

## File map

| Path | Wave |
|---|---|
| `packages/cli/src/slack/adapter.ts` | S1 |
| `packages/cli/src/slack/types.ts` | S1 |
| `packages/cli/src/slack/adapter.test.ts` | S1 |
| `packages/cli/src/discord/adapter.ts` | S2 |
| `packages/cli/src/discord/types.ts` | S2 |
| `packages/cli/src/discord/adapter.test.ts` | S2 |
| `packages/acp/src/protocol.ts` | S3 |
| `packages/acp/src/protocol.test.ts` | S3 |
| `packages/acp/src/server.ts` | S3 |
| `packages/acp/src/server.test.ts` | S3 |
| docs listed in S4 | S4 |

Leave `session-engine.ts`, `phases.ts`, `pending-asks.ts`, pairing, HTTP resolve, Ink, OpenTUI, schema, docker tools.

---

## Success checks

1. Slack Skip button and `skip` text → `'ignored'`; Allow/Deny unchanged.
2. Discord `skip`/`ignore`/`ignored` → `'ignored'`.
3. ACP Skip option → `'ignored'`; `cancelled` still `'deny'`; sensitive path can skip.
4. Timeouts and I2 abort still not ignored.
5. Crash-resume skip pairs via `applyAskAnswer` and does not submit.

---

## Out of this closeout

Timeout→ignored, cancelled→ignored, Allow-always buttons, dismiss-all host button, Memory/file-history docker, schema bump.
