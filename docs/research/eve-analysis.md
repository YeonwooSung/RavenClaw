# eve — Prior-Art Analysis for RavenClaw

eve (Vercel, Apache-2.0, beta) is a **filesystem-first framework for durable backend agents**. You author an agent as a directory (`instructions.md`, `tools/`, `skills/`, `channels/`, `schedules/`) and eve compiles and runs it. The product is a **runtime + authoring grammar**, not a coding REPL.

This note extracts architecture and steal-worthy contracts. Steal semantics. Do not copy eve source, prompts, or the Workflow/Nitro host.

Repo analyzed: `/Users/yeonwoosung/Desktop/eve` (read-only). License: Apache-2.0. Style the name `eve`, lowercase.

RavenClaw is the opposite shape: one `queryLoop`, persist-before-execute, leftover-ask, local BYOK coding agent. eve is useful as the **durable-session / HITL / sandbox-split / HTTP session-API** reference — especially if RavenClaw ever grows a web or long-lived host — not as a replacement loop.

Related product shell (hosted Task + Next.js + Kata): `~/Desktop/y0`. y0 is a product. eve is the framework y0-shaped apps would sit on. Do not merge the two into RavenClaw.

---

## 1. What eve is (and is not)

| eve is | eve is not |
|---|---|
| A compile-then-run agent **framework** | A coding TUI you leave in a repo |
| Filesystem slots as the authoring UI | A hidden tool registry |
| Durable sessions (Workflow SDK) that park for days | Persist-before-execute for every tool |
| Runtime (secrets, tools) vs sandbox (bash/files) | A permission mode system (`dontAsk` / leftover-ask) |
| One HTTP session contract + many channel adapters | One loop that hosts must call |

**Package layout**

- `packages/eve` — framework + `eve` CLI (the product)
- `packages/eve-catalog` — unpublished integration catalog
- `packages/eve-self-modification` — opt-in “agent edits its own `agent/`” extension
- `apps/docs`, `apps/templates`, `apps/frameworks`, `apps/benchmarks`, `e2e/`

**Invariant (from `AGENTS.md`):** the core (`execution/`, `harness/`) stays lean; new capability is a file slot, a hook, or an extension. Names come from paths. Do not add `name` fields.

---

## 2. Filesystem grammar

A typical agent:

```text
my-agent/
└── agent/
    ├── agent.ts              # model, limits, compaction
    ├── instructions.md       # always-on system prompt (required)
    ├── tools/                # defineTool modules (slug = tool name)
    ├── skills/               # .md or SKILL.md packages
    ├── channels/             # HTTP / Slack / Discord / …
    ├── connections/          # MCP + OpenAPI
    ├── schedules/            # cron (root only)
    ├── subagents/<id>/       # child agent packages
    ├── hooks/
    ├── memory.ts | memory/
    └── sandbox.ts + sandbox/workspace/**
```

Two layouts: **nested** (`appRoot/agent/`) and **flat**. Discovery walks without importing user code, emits `AgentSourceManifest` (v15), then compile imports selected modules, stamps path-derived identity, and writes `.eve/compile/`.

**Name-from-path:** `tools/billing/refund.ts` → tool `billing-refund` (`/` flattened for model charset). Hooks and schedules keep `/`. Skills take the directory or file slug. TS `defineTool` rejects a `name` field; packaged `SKILL.md` `name` / `allowed-tools` are **accepted and ignored**. Path is identity. Discovery manifest is v15; compiled artifact version is separate (`compiled-manifest-v48`).

**Defaults occupy the same slots.** Framework virtual files (`tools/bash.ts`, `tools/read_file.ts`, `channels/eve.ts`) lose to an authored file at that path. `disableTool()` removes a default only if something remains underneath. Layer order:

```
framework-default < extension-package < extension-override < application
```

**Skills are content, not a new execution surface.** `load_skill` injects markdown. Packaged `SKILL.md` is an agentskills.io **subset**: `name` and `allowed-tools` are ignored. Path is identity.

**Vs RavenClaw:** we already have `discoverSkills`, SKILL.md, `.ravenclaw/`. We do **not** need an `agent/tools/*.ts` compiler. Steal the *slot idea* only if we ever expose project-level tool overrides as files. Do not become a framework.

---

## 3. Session / turn / step

Work nests in three levels:

```
session   durable conversation (days; 30-day default timeout)
  └─ turn    one user delivery + all model/tool work
       └─ step    one Workflow checkpoint: 1 model call + its inline tools
                  (experimental: N model cycles per step)
```

The default harness (`packages/eve/src/harness/tool-loop.ts`) forces AI SDK `ToolLoopAgent` to **one model step**. The outer Workflow loop calls that body again when the last message is a tool result.

```
workflowEntry
  createSession + claim inboxes
  loop:
    runTurnOwnedWorkflow
      loop:
        turnStep ("use step")
          resume HITL / OAuth / coordination
          preamble (session.started / turn.started / message.received)
          maybeCompact
          model + inline tools
          park | continue | done
        persist DurableSessionSnapshot
    nextTurnDelivery   # unbounded wait, no compute
```

**Durability:** completed `"use step"` results never re-run. A crash **mid-step** re-runs the whole model+tool cycle. That is the opposite of RavenClaw persist-before-execute. HITL / OAuth / workflow-tool waits **do** persist a pending batch and park with no compute.

**Turn policy** is on the delivery command, default `steer`:

| Policy | Active turn + new message |
|---|---|
| `steer` | Buffer replacement, cooperative cancel, new `turnId`. Side effects not rolled back. |
| `queue` | Wait until settle; adjacent same-auth messages may coalesce. |
| `inputResponses` | Never steer. Routed to the open HITL they address. |

There is **no durable FIFO mailbox** of arbitrary user messages — only the session command inbox. RavenClaw already has a durable mailbox + `/queue`. Steal the **policy-on-delivery** rule so Slack/Discord/serve cannot desync cancel intent from the message.

---

## 4. Streaming contract

Every surface speaks the same ID-addressed HTTP API (`/eve/v1/session`). Stream is NDJSON. Envelope: `meta.id` (ULID, minted once at durable write), `meta.at`.

| Event | Meaning |
|---|---|
| `session.started` / `session.waiting` / `session.completed` / `session.failed` | Session lifecycle |
| `turn.started` / `turn.completed` / `turn.failed` / `turn.cancelled` | Turn lifecycle. Cancel is **not** failure; always followed by `session.waiting` |
| `message.received` / `message.appended` / `message.completed` | User accept + assistant text |
| `reasoning.appended` / `reasoning.completed` | Reasoning deltas / finalized block |
| `result.completed` | Structured output when the turn requested a schema |
| `step.started` / `step.completed` / `step.failed` | Model step |
| `actions.requested` / `action.input.appended` / `action.partial` / `action.result` | Tools (calls stream **before** execute when streamed) |
| `input.requested` / `input.resolved` | HITL park / answer |
| `authorization.required` / `authorization.completed` | Connection OAuth |
| `compaction.requested` / `compaction.completed` | Compact |
| `subagent.called` / `subagent.completed` | Child session (`childSessionId`) |
| `context.cleared` | History wipe, identity kept |

Protocol also has `approval.candidate` / `approval.settled` and `subagent.started` / `subagent.event` (not all appear in the public docs table). Stream contract version is currently **25**.

Client state is `{ sessionId, streamIndex }`; the HTTP query is `?startIndex=`. App chat rows (`chatId`) are **not** `sessionId`.

**Channel continuation tokens** (`slack:channel:threadTs`) stay behind the channel boundary. The HTTP API **rejects** `continuationToken` in the body.

The eve channel is the **`/eve/v1` session family**: `POST /session`, `POST /session/:id`, `GET …/stream`, cancel/clear/compact/reset — plus health/info, subagent stream, and capability-token callbacks.

RavenClaw `StreamEvent` already covers TUI (including `permission_ask`). Steal this catalog as the **host contract** for extending `raven serve` / a future web client: ID-addressed session, versioned events, HITL as first-class events, cancel ≠ fail.

---

## 5. Tools, HITL, sandbox

### Default / opt-in tools

| Tool | Default? | Runs |
|---|---|---|
| `bash`, `read_file`, `write_file` | yes (optional) | App runtime, **proxy into sandbox** |
| `web_fetch` | yes | App runtime; HTTPS + SSRF checks |
| `web_search` | if provider supports | Provider |
| `todo` | yes | Durable session state |
| `ask_question` | if session can request input | Parks (`input.requested`) |
| `agent` + `task_cancel` | root only | Background child session |
| `load_skill` | if skills exist | Injects markdown |
| `connection_search` | if connections exist; **cannot disable** | Promotes `<conn>__<tool>` |
| `glob`, `grep`, `sleep` | opt-in | Sandbox / workflow |

Omitted `approval` = `never()` — **auto-execute**. Helpers: `never()` / `once()` / `always()` / custom policy (`user-approval` | `approved` | `denied` | `not-applicable`). `once()` is per-session allow-after-first (pending siblings stay independent). `always()` is also how they make replay-safe charges.

HITL persist shape (`PendingInputBatch`): requests + withheld assistant messages + emit coordinates. Resume matches `requestId`. Single open question + a new user message = **dismiss-and-continue** (`status: "ignored"` tool results). Approvals do not dismiss-on-message in task mode.

**Map onto RavenClaw**

| eve | RavenClaw |
|---|---|
| omitted / `never()` | `dontAsk` in-tree promote / leftover-deny is stricter |
| `once()` | `allow_always` for that tool this session |
| `always()` | leftover-ask every time |
| `ask_question` | `AskUser` |
| dismiss-and-continue | leftover-ask ignore path |

Steal the **named policy + durable pending batch**. Do not steal default-auto-execute.

### Sandbox split (the web-relevant idea)

```
App runtime (trusted)          Sandbox (untrusted compute)
  process.env, tools, MCP        /workspace, bash, files
  model calls, Workflow          no secrets, no path back
  connection tokens (memory)     network policy
```

Backends, picked once per process: Vercel Sandbox (if `VERCEL`) → Docker → microsandbox (Apple Silicon or Linux KVM) → just-bash (VFS fallback). Default network policy is **`allow-all`**. Credential brokering (header injection at the firewall) exists on **Vercel Sandbox and microsandbox only**; Docker is allow-all / deny-all.

RavenClaw already has `terminal.backend: docker` for **Bash only**. Read/Write/Edit still hit the host. Steal: **when a sandbox backend is on, file tools go through the same port**. Secrets stay out of the container env (we already allowlist docker env).

`write_file` enforces **read-before-write + stale hash**. Cheap. RavenClaw Edit/Write should adopt this without becoming eve.

There is **no host command jail** and no `/workspace`-only default on file tools (absolute paths pass through inside the sandbox). Isolation is the backend, not a denylist.

---

## 6. Channels and hosts

**One runtime host** (Nitro). Fronts: TUI (`eve dev`), ACP stdio, Next/Nuxt/SvelteKit same-origin proxy, browser `useEveAgent`.

Authored channels (file stem = id): first-class `eve`, Slack, Discord, GitHub, Linear, Telegram, Teams, Twilio, MCP-as-server, Photon, Linq, optional Chat SDK, plus custom `defineChannel`. Default root also supplies `channels/eve.ts` and `channels/home.ts` (GET `/` landing) if you omit those files. Photon, Linq, and Chat SDK are **three** adapters, not one wrap.

Auth walk **fails closed**. Scaffold `placeholderAuth()` 401s in production until replaced. Channel adapters verify HMAC on the **raw body** (`timingSafeEqual`) and **never trust body `principalId`**.

ACP is a process-local UUID mapped onto an eve `ClientSession` on first prompt. Not a second loop. Same idea as `packages/acp`.

**Do not copy the adapter zoo.** RavenClaw already has Slack, Discord, ACP, `raven serve`. Steal: sessionId vs continuation token, fail-closed serve auth, signature+principal invariants.

---

## 7. Memory, subagents, schedules, evals

**Memory** is slots + providers, not one markdown file. Recalled records are **user-role messages with ids** (supersede on update), never system prompt. Lifecycle:

```
turn.started              recall
compaction.requested      capture  (throw aborts compact)
compaction.completed      recall again
turn.completed            capture  (log-only on throw)
session.clear()           wipe recalled messages; provider store stays
```

Scope comes from **trusted auth**, never the model. `null` disables the slot. File memory is one provider (`<slot>__save_memory` / `<slot>__remove_memory`).

RavenClaw `MEMORY.md` / `USER.md` can stay the default document. Steal the **compact sandwich** (exclude memory from the summarizer; re-inject after) and fail-closed recall.

**Subagents:** handle (`agentId`, parked child session) ≠ task (`taskId`, one job). Declared `subagents/<id>/` get their own skills/tools/sandbox. Copies via root `agent` share the parent sandbox. Successes of overlapping background work form a **cohort** and wake the parent once.

RavenClaw `SessionEngine` children + `TaskSteer` already exist. Steal: **child leftover-ask proxies to the parent host**; handle vs task naming; do not inherit parent skills into specialists.

**Schedules:** path-derived cron. Markdown mode = new task session that **cannot park** (no zombie HITL). Handler mode dispatches through channels. `eve dev` never fires cron (explicit fire route).

**Evals:** `evals/<path>.eval.ts` is one imperative case (`test(t)`). Path is identity. Assertions are **gate** (CI fail) vs **soft/scored** (judge, never fail unless `--strict`). Drive the real HTTP session, not a fake loop. Highest-leverage quality idea we do not have.

**`defineState`:** session-scoped durable scratch. Isolated from children. Do not overload `MEMORY.md` for counters.

---

## 8. Compaction

Default threshold 90% of context, including the compaction-prompt envelope so a just-compacted session cannot immediately re-trigger.

Order:

1. Cap oversized **tool results** in older history (keep structure).
2. If still over: LLM-summarize older region; keep recent tail; previous checkpoint passed out-of-band.
3. Reset read-before-write tracking (summarized reads are gone).
4. Re-inject the active todo list.
5. Memory: capture → exclude attributed records → summarize → recall.

Manual `compact()` / `clear()` are session commands. If a turn is running they **queue**; they do not splice the live prompt.

RavenClaw already has LLM compact + mechanical fallback. Steal steps 1, 3, 4, 5. Keep our persist-before-execute and pairing.

---

## 9. Comparison table

| Concern | eve | RavenClaw |
|---|---|---|
| Product | Framework for durable agents | Local BYOK coding agent |
| Loop | Workflow step = model + inline tools | `queryLoop` rounds, persist-before-execute |
| Crash mid-Bash | Re-runs the step | Never re-runs; resume pairs |
| Permissions | Per-tool `never/once/always` (default never) | leftover-ask / `dontAsk` leftover-deny / no `bypass` |
| Sandbox | Default; file+bash proxy | Optional Docker for Bash only |
| Authoring | Directory grammar + compile | Config + SKILL.md + tools in core |
| Hosts | Nitro + first-class adapters (eve, Slack, Discord, GitHub, Linear, Telegram, Teams, Twilio, MCP, Photon, Linq, Chat SDK) + custom | Ink, OpenTUI, exec, ACP, serve, Slack, Discord |
| Session API | `/eve/v1` session family + NDJSON | TUI events; serve is loopback `POST /v1/turn` + HMAC webhook |
| HITL | Durable park, days, no compute | `tool_use` persisted; **decision** is RAM-only (resume pair-repairs to `incomplete`) |
| Memory | Slots + providers + compact lifecycle | MEMORY.md / USER.md, frozen until next session |
| Evals | First-class `eve eval` | `bun test` + optional smoke |
| Kitchen sink | Channel zoo, self-mod, Workflow worlds | Explicitly refused |

---

## 10. Steal / skip

### Steal (contracts only)

1. **Runtime vs sandbox split** — secrets and MCP stay trusted-side; file+bash share one sandbox port.
2. **Durable HITL batch** — persist pending approvals/questions; park; resume by `requestId`; leftover responses re-queue; dismiss-and-continue for a single question.
3. **`turnPolicy` on the delivery** — steer vs queue cannot desync from cancel.
4. **ID-addressed session + NDJSON catalog** — `sessionId` ≠ app `chatId` ≠ channel token. Cancel ≠ fail.
5. **Channel auth** — HMAC on raw body, constant-time compare, never trust body identity. Serve fail-closed.
6. **Compact hygiene** — trim tool results first; reset file-read cache; re-inject todos; memory out of the summarizer.
7. **Read-before-write + stale hash** on writes.
8. **Child HITL proxy** + handle vs task.
9. **`raven eval` shape** — path-identity cases, gate vs soft, drive a real session.
10. **Name-from-path / no authored `name`** for any new skill or schedule files.

### Skip (kitchen-sink or conflicts with law)

- Workflow SDK as the loop (breaks persist-before-execute)
- Inline-tool execute-then-persist
- The full channel adapter zoo (Telegram, Teams, Twilio, Linear, Photon, Linq, Chat SDK)
- Self-modification / agent-edits-`agent/`
- `agent/tools/*.ts` compiler (we are not a framework)
- Default `approval: never()`
- OpenAPI connections as a new core tool
- Nitro / Vercel lock-in, `placeholderAuth` branding
- `execute_code`, marketplace, Electron (already refused)

### Park

- `defineState` (session scratch typed API)
- OpenAPI as an MCP-shaped connection later
- Filesystem project tool overrides
- Credential brokering (needs a real sandbox firewall)

---

## 11. Implications for a RavenClaw web/fullstack path

If we ever add a browser client, **eve’s session API is the right waist**, not y0’s Socket.IO+Prisma Task:

1. Keep one `queryLoop`. Hosts (including HTTP) only `submitMessage`.
2. Persist leftover-ask so a tab close or Slack overnight does not lose the pairing.
3. Expose a versioned NDJSON stream keyed by `sessionId`.
4. Put file+bash behind a sandbox when the session is multi-tenant or unattended.
5. App UI owns `chatId` → `{ sessionId, streamIndex }`. Do not invent a second loop in Next.js.

y0 still teaches Task-as-job UX (shadow branch, PR, wiki). eve teaches the **runtime contract** that makes that UX safe across process death. Neither replaces the waist.

That eve-inspired horizon is implemented. Next: `docs/superpowers/specs/2026-09-16-session-as-job-roadmap.md` (y0 session-as-job + leftover eve waist: reconnectable stream, cancel ≠ fail, compact/todo truth).
