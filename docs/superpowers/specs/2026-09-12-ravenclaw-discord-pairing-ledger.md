# RavenClaw Discord + pairing + inbound ledger

Date: 2026-09-12  
Status: implemented
Implements gateway spec slice **G3** in `2026-09-12-ravenclaw-gateway-and-parallel-agents.md`.  
Does not extend `2026-09-12-ravenclaw-remaining-roadmap.md`.  
Sibling: `2026-09-12-ravenclaw-child-session-honesty.md` (TaskSteer) is a separate spec.

Steal contracts from Slack (`packages/cli/src/slack/`) and Hermes pairing. Do not copy Hermes source. Do not refactor Slack in this spec.

---

## Why

Slack (`raven slack`) is the first chat host. G3 is the second network plus the two pieces Slack shipped without: a local pairing CLI for unauthorized DMs, and an inbound delivery ledger so reconnects do not open the same turn twice.

---

## Constraints

1. One `queryLoop`. Discord only calls `submitMessage`.
2. Persist-before-execute and pairing (tool_use / tool_result) stay law.
3. `dontAsk` is not `bypass`. Guild channels are `dontAsk`. DMs leftover-ask, 120s deny.
4. Empty `allowFrom` is deny-all except a pairing-approved user id.
5. No company backend. Tokens in `~/.ravenclaw/.env` (0600).
6. Ads never on BYOK chat sessions.
7. Slack package is **read-only** this spec.

---

## Locked decisions

| Topic | Choice |
|---|---|
| Process | `raven discord` — sibling of `raven slack`, not folded into `serve` |
| Auth | Config allowlist + DM pairing (`raven pairing approve <code>`) |
| Ledger | Inbound event id dedupe only. No outbound send queue |
| Leftover-ask | Match Slack: guild `dontAsk`, DM 120s deny |
| Implementation | Clone Slack adapter shape; pairing + ledger are shared modules Slack does not call yet |

---

## 1. Process and session

`raven discord` is a long-lived official Discord Gateway client (HTTPS + WebSocket). No discord.js-sized SDK. CWD is the workspace the process was launched from. Token: `DISCORD_BOT_TOKEN`.

Session key:

```
raven:discord:{guildId|dm}:{channelId}[:threadId]
```

Guild channels share one session per channel (and thread suffix). DMs use `dm` + the DM channel id.

`openSession` uses `lockHolder: 'discord'`. Per-session `turnFlights` serializes `submitMessage` with 15s mailbox peek — same contract as Slack/`serve`.

Streaming: first `send`, then `edit` that message. If edit fails, `send` a new message. Collapse tool rows. Text only. No image attach in this spec.

---

## 2. Admit

Config (mirrors Slack names under `discord:`):

- `allowFrom: string[]` — user ids. Empty = deny-all unless pairing-approved.
- `channels: string[]` — guild channel ids. Empty = DMs only.
- `mentionOnly: boolean` — default true.

**Guild channel**

1. Channel not in `channels` (or list empty) → drop.
2. `mentionOnly` and message does not mention the bot → drop.
3. Author not in `allowFrom` and not in `pairing.json` `discord.<userId>` → drop.
4. Else open engine with `dontAsk`.

**DM**

1. Author in `allowFrom` or pairing-approved → open engine, leftover-ask, 120s deny.
2. Else do **not** open a turn. Issue or reuse a 10-minute 6-digit code for that user. Reply once: `pair with: raven pairing approve <code>`.

Bot-authored messages and empty content: drop. Do not write them to the ledger (they may be retried).

---

## 3. Pairing CLI

Files (0600):

- `~/.ravenclaw/pairing.json` — `{ "discord": { "<userId>": { "approvedAt": number, "note"?: string } } }`
- `~/.ravenclaw/pairing-pending.json` — `{ "<code>": { "platform": "discord", "userId": string, "expiresAt": number } }`

Corrupt JSON is fail-closed (no pairing pass).

| Command | Behavior |
|---|---|
| `raven pairing list` | Approved ids + pending codes with expiry. No tokens |
| `raven pairing approve <code>` | Move pending user into `pairing.json`, delete pending. Unknown/expired code → exit 1 |
| `raven pairing revoke discord <userId>` | Remove from `pairing.json`. Does not edit `allowFrom` |

Same user, still-valid pending: reuse the code (do not spam new codes).

`allowFrom` remains the static config list. Pairing is the extra grant. Revoke does not remove a user who is also in `allowFrom`.

Slack is not wired to this file in this spec.

---

## 4. Inbound ledger

Same SQLite file as `SessionStore` (or a sibling opened from the same home). Table:

```sql
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  seen_at INTEGER NOT NULL
);
```

- Key: `discord:<message.id>`.
- `seen(id)`: INSERT OR IGNORE; return whether the row is new.
- If not new → drop the event. Do not `submitMessage`.
- If INSERT fails → drop (do not open a turn twice).
- On process start, delete rows with `seen_at` older than 24 hours.

No outbound queue. A crashed mid-turn is recovered by persist-before-execute + `/resume`, not by replaying the Discord event.

---

## 5. Event path

```
MESSAGE_CREATE
  → drop self / empty
  → ledger seen(discord:<id>)? drop
  → normalize
  → admit (channel / DM / pairing)
  → openSession + turnFlights.handleTurn
  → send / edit reply
```

Errors:

- Missing token → process exit 1, no Discord message.
- Session lock held → one line, same wording family as Slack (`held by <holder>`).
- `submitMessage` throws → reply `turn failed`. No prompt body, no stack.

---

## 6. Tests

Targeted `bun test` only.

| File | Cases |
|---|---|
| `packages/cli/src/pairing.test.ts` | issue/reuse/expire 10m; approve writes pairing.json; unknown code fails; revoke; corrupt JSON fail-closed |
| `packages/cli/src/discord/admit.test.ts` | empty allowFrom drops channels; unapproved DM is code-only; approved DM passes; mentionOnly; bot drop |
| `packages/core/src/session/deliveries.test.ts` | second `seen` is duplicate; 24h gc; bot/empty never inserted |
| `packages/cli/src/discord/session-key.test.ts` | guild / thread / dm keys |
| `packages/cli/src/discord/run.test.ts` | `lockHolder: 'discord'`; channel `dontAsk`; DM 120s; turnFlights serializes mailbox |
| `packages/cli/src/args.test.ts` + help/completions | `discord`, `pairing` |

Live Discord cloud is not a done-condition.

---

## 7. Files

| Path | Change |
|---|---|
| `packages/cli/src/discord/` | `run`, admit, normalize, session-key, gateway, send/edit |
| `packages/cli/src/pairing.ts` | file IO + approve/list/revoke |
| `packages/core/src/session/deliveries.ts` | `seen`, `gc` |
| `packages/cli/src/args.ts`, `index.ts`, `help.ts`, `completions.ts` | `raven discord`, `raven pairing` |
| `packages/cli/src/slack/**` | **no edits** |

---

## 8. Out of scope

- Slack refactor or Slack pairing backport
- Discord voice, buttons, leftover-ask in guild channels
- Outbound redelivery queue
- Image attach on Discord
- Per-channel worktrees
- Spec A (`TaskSteer`, worktree report)
- `execute_code`, included gateway, Telegram

---

## Done when

1. `raven discord` with no token exits 1.
2. An unapproved DM does not open a session and replies with `raven pairing approve <code>`.
3. After `raven pairing approve <code>`, that user's next DM opens an engine.
4. The same Discord `message.id` never calls `submitMessage` twice.
5. Guild turns are `dontAsk`. DM leftover-ask times out to deny at 120s.
