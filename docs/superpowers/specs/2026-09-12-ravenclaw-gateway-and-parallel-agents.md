# RavenClaw gateway + parallel agents

Date: 2026-09-12  
Status: implemented (G0–G3 Slack/Discord + pairing/ledger; A0–A3 TaskSteer on live Agent)
Sources: Hermes Agent (`/Users/yeonwoosung/Desktop/hermes-agent`, MIT) — steal contracts, do not copy code. RavenClaw stays Apache-2.0, BYOK, no company backend.

This spec covers two v1.x seams:

1. External invocation (Discord / Slack / webhook / local HTTP).
2. Subagent parallelism (fan-out, detach, join).

Messaging was a v1 non-goal in `2026-09-08-ravenclaw-coding-agent-design.md`. This document is the implementable next product, not a 25-adapter museum.

---

## Constraints

- One `queryLoop` / `SessionEngine.submitMessage`. Hosts are clients of that waist.
- Persist-before-execute stays law. Adapters must not execute tools then log.
- Unattended surfaces (`exec`, ACP, cron, chat bots, webhooks) use `dontAsk`. Leftover-ask → deny except in-tree Edit/Write and read-only tools. There is no `bypass`.
- Secrets in `~/.ravenclaw/.env` (0600). No RavenClaw Relay / Portal / enrollment.
- Steal Hermes patterns; write TypeScript. Do not vendor `gateway/` or `delegate_tool.py`.

---

## 1. External invocation

### What Hermes actually does

One long-lived `hermes gateway` process fronts ~25 adapters. Each adapter normalizes inbound to `MessageEvent` + `SessionSource`, then:

```
admit → allowlist/pairing → session_key → claim lease
  → AIAgent.run_conversation (same loop as CLI)
  → send / edit / draft
```

Session key (Hermes):

```
agent:<profile>:<platform>:<chat_type>[:slack_team][:chat_id][:thread_id][:user]
```

Default: DMs per chat; groups **per user**; threads **shared**. Discord guild is stored but not in the key; Slack workspace is in the key.

Auth is **default deny**. Tokens stay on disk. Unauthorized DMs get a local pairing code (`hermes pairing approve`), not an open bot. Channels require `@mention` unless a free-response allowlist says otherwise.

Streaming: first `send`, then `edit` that message id. If edit fails, post a new message. Slack can use native streams later (prefix-stable frames).

Webhook/HTTP: HMAC, 202 + fire-and-forget, **one session per delivery**, `dontAsk`, **restricted toolset** (no Bash/files unless the operator widened the route — and the agent cannot self-grant).

### What RavenClaw already has

| Surface | Role |
|---|---|
| Ink / OpenTUI | Interactive `ask` |
| `raven exec` | Headless `dontAsk` |
| `raven acp` | Editor JSON-RPC, `dontAsk`, drops `permission_ask` |
| `@ravenclaw/sdk` | `createRavenSession`; default ask = deny |
| `raven cron watch` | Long-lived process that already fires jobs |

There is no Discord/Slack/Telegram code.

### Portable design

**Package:** `packages/gateway` (or `packages/cli` command `raven serve`) — a **thin local host**, not a hosted connector.

**Adapter interface (MVP):**

```
connect / disconnect
send(chatId, text, { replyTo?, threadId? }) → { ok, messageId }
edit(chatId, messageId, text) → { ok }   // false ⇒ send new
normalize inbound → InboundEvent
```

**InboundEvent:** `{ platform, chatId, chatType, userId, threadId?, text, messageId }`

**Session map:** durable JSON under `~/.ravenclaw/gateway/sessions.json`

```
<platform>:<chatType>:<chatId>[:threadId][:userId] → raven session id
```

Reuse `SessionStore`. One `SessionEngine` per live conversation; ACP already holds a `Map<sessionId, engine>`.

**Auth (fail closed):**

- `{PLATFORM}_ALLOWED_USERS` and/or `{PLATFORM}_ALLOW_ALL_USERS`
- Empty allowlist + allow-all false → drop
- Guild/channel: require mention unless `FREE_RESPONSE_CHANNELS`
- DMs: allowlisted users only
- Optional later: pairing file + `raven pairing approve`

**CWD:** the workspace the gateway was launched from. Do not invent per-channel worktrees in the first cut.

**Permissions:** `dontAsk`. No mid-turn Discord buttons in MVP. Owner DMs may later use `default` + a reply-to-approve protocol; webhooks stay `dontAsk` + webhook-safe tools (`Read`/`Grep`/`Glob`/`Fetch`/`WebSearch` only unless config widens).

**Streaming MVP:** post a placeholder, edit as `text_delta` accumulates (throttle ~1s). Final edit. Collapse tool rows.

**Process:** `raven serve [--discord] [--slack] [--webhook]` long-lived, same home as CLI. `cron watch` can share the process later. Detached from TUI (Hermes lesson: desktop `serve` dies with the app).

### Ship order

| Slice | What |
|---|---|
| **G0** | Local HTTP: `POST /v1/turn` with a shared secret, maps to `submitMessage`, JSONL or final text. Loopback bind default. |
| **G1** | Webhook adapter: HMAC, 202, one-shot session, safe toolset. |
| **G2** | One chat bot: Slack Socket Mode **or** Discord gateway (pick Slack first — no public URL). Allowlist + mention + send/edit. |
| **G3** | The other chat bot. Pairing CLI. Delivery ledger if crash-redelivery matters. |

### Skip

Hermes Relay / Nous Portal / Photon, 25 adapters, unofficial WhatsApp/Weixin, Discord voice, hosted rooms, token-lock fleets, ads on BYOK chat.

---

## 2. Parallel subagents

### What Hermes actually does

One tool: `delegate_task`. Parallelism is `tasks[]`. There is no catalog `agent=` field; children inherit parent tools minus a deny list. Depth default **1** (flat). Root always **background**; nested orchestrators (if depth > 1) wait in-turn.

Background: return `{ status: dispatched, subagent_ids }` immediately. When the child finishes, a **new parent turn** is injected (`async_delegation` mailbox). The model is told not to poll. If the session cannot receive a later turn (one-shot, cron), **fall back to sync** and say so. Do not queue at capacity.

Caps: `max_concurrent_children` default 10; reject, do not queue. Worktree isolation is opt-in and **keeps dirty trees**.

Control: same tool `action=list|steer|stop`. Steer queues text onto the **next** tool result.

Teammate “swarm” in Hermes is Bot Mode DMs between profiles — a different product.

### What RavenClaw already has

| Piece | Contract |
|---|---|
| `Agent` + `subagent` catalog | `general`, `file-finder`, `command-runner`, `reviewer`, `researcher-web` + disk agents |
| `agents[]` | `Promise.allSettled`, parent blocked |
| `run_in_background` | `TaskRegistry` `type: agent`, poll via `TaskOutput`/`TaskStop`/`/tasks` |
| Depth | Hard one level (`NESTING_DENIED` includes `Agent`) |
| Worktree | Per-call `isolation: worktree`; **force-remove** on cleanup |
| Result | Last assistant or `SetOutput`, 32k bound |

Gaps vs Hermes: no mailbox (completion does not wake the parent), no fan-out cap, background ignored when `agents[]` is set, worktree always deleted even if dirty, no steer, TaskOutput copy still says “Bash”.

### Portable design

Keep **one nesting level** and the **catalog**. Steal Hermes **mailbox + caps + keep-dirty worktrees**, not orchestrator trees.

**A. Two modes, one tool**

- `agents[]` = sync fan-out (parent blocked). Cap length (`maxParallelChildren`, start at 6).
- `run_in_background` = detach. Return JSON `{ status, taskId, childSessionId }`.
- If `agents[]` **and** background: run the batch detached as **one** mailbox unit, or reject the combination. Do not silently ignore background.

**B. Mailbox (the important steal)**

- On child terminal: enqueue a **between-turn** parent attachment (synthetic user notice: summary + session id). Drain only when the parent is idle (same place `/queue` and `/loop` already drain).
- If the host cannot receive a later turn (`exec`, ACP one-shot): run sync and include a `note`.
- `TaskOutput` / `TaskStop` stay for poll/kill. Fix the Bash-only description.

**C. Isolation**

- Keep per-call `isolation: worktree`.
- Cleanup: prune only if the tree is clean; else keep path and return `{ path, dirty, pruned: false }`.
- Do not share `ctx.tasks` into the child unless the child is allowed to start its own background Bash.

**D. Caps (fail closed)**

- `maxParallelChildren` on `agents[]` and live background agent slots.
- At capacity: reject new background (optional sync fallback + note).
- Keep `childMaxRounds`.

**E. Control**

- v1: `/tasks` + `TaskStop` is enough.
- Steer later: inject onto the child’s next tool result (already have `enqueueSteer` on the parent engine; children need the same mailbox).

**F. Skip**

HMAC plugin lifecycle, durable SQLite delivery ledger (unless `raven serve` outlives the TUI), live transcript files, credential pools, Bot Mode teams, `max_spawn_depth > 1`.

### Ship order

| Slice | What |
|---|---|
| **A0** | Cap `agents[]`; JSON background handle; TaskOutput text fix. |
| **A1** | Mailbox: completed background Agent becomes a queued parent user line. |
| **A2** | Keep-dirty worktree + report path. |
| **A3** | Optional child `enqueueSteer` via `Task` / Agent `action`. |

---

## 3. How the two seams meet

`raven serve` and TUI share `SessionStore` and `TaskRegistry` **per process**. A Slack thread is one RavenClaw session. If that session’s model calls `Agent.agents[]`, fan-out is in-process. Background children complete into the **same** session mailbox; the gateway’s next outbound message is the parent’s next assistant text (including the mailbox notice).

Do not give Discord its own agent tree. The channel is a host, not an orchestrator.

Unattended Slack/webhook + `Agent` leftover-ask: **denied** under `dontAsk`. Owner-operated bots that need spawn must use `acceptEdits` **or** a session rule that allows `Agent`. Document that. Webhook-safe toolsets should omit `Agent`.

---

## 4. Suggested layout

```
packages/gateway/          # raven serve + adapters
  src/types.ts             # InboundEvent, Adapter
  src/session-map.ts
  src/authz.ts
  src/http.ts              # G0 local turn API
  src/webhook.ts           # G1
  src/slack.ts             # G2
  src/discord.ts           # G3
packages/core/src/tools/agent.ts   # A0–A3
packages/core/src/tasks/mailbox.ts # A1
```

CLI: `raven serve` does not require a TUI. Same `.env` keys as `raven`. Bot tokens: `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `GATEWAY_ALLOWED_USERS`.

---

## 5. Out of scope

Electron desktop, plugin marketplace, computer-use, Hermes Relay, 25 chat networks, teammate swarms / SendMessage buses, `bypassPermissions`.
