# RavenClaw next-horizon roadmap (eve-inspired)

Date: 2026-09-15  
Status: **implemented** on `main` at `d4c73d4` (Waves E1–E4 + leftover-ask hole PRs #2–#8). Per-slice board below is the pre-ship audit, kept for history.  
Next horizon: [`2026-09-16-session-as-job-roadmap.md`](2026-09-16-session-as-job-roadmap.md).  
Reviewed against tree at `f64779f` (`f64779f82cfb54e2a4324e1f0f6fcce88bc5cdc9`).  
Supersedes nothing already shipped. Successor to `2026-09-12-ravenclaw-remaining-roadmap.md` (Status: implemented).

Sources: current tree, [eve analysis](../../research/eve-analysis.md) (`/Users/yeonwoosung/Desktop/eve`, Apache-2.0, read-only), y0 analysis (hosted product shell, not a loop).

Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework.

Implementation plan: [2026-09-15-eve-inspired-implementation.md](../plans/2026-09-15-eve-inspired-implementation.md) (15 TDD tasks; source-reviewed 2026-09-15). Binding plan rulings live at the top of that file (one row per `call_id`, `applyAskAnswer` is the only non-`submitMessage` entry, `/v1/turn` stays dontAsk, docker v1 = cwd bind jail, no `ignored`, no stream `?after=`). Stream `?after=` was deferred there; [session-as-job](2026-09-16-session-as-job-roadmap.md) adds seq and amends that ruling. `ignored` as a leftover-ask / live `askUser` result is implemented by [`2026-09-21-ignored-dismiss.md`](2026-09-21-ignored-dismiss.md); dismiss-on-message stays parked. Do not rewrite E1.1.

---

## Where we are

The remaining-roadmap waves (daily quality, Ink chrome, Slack/Discord hosts, ship path) are on `main`. The waist is still:

- One `queryLoop`. Hosts call `submitMessage`. Persist-before-execute. Pairing. No `bypass`.
- `dontAsk` ≠ leftover-allow-all.
- Frozen default prefix. Skills + MCP + `isEnabled` for growth.
- Slack, Discord + pairing, ACP, `raven serve`, cron, children via `SessionEngine`.

What is left is **not** “missing a loop” and **not** “add eve’s compiler.” It is making leftover-ask **decisions** survive process death (today resume pair-repairs open asks to `incomplete`), making the optional Docker backend apply to **files as well as Bash**, and extending `raven serve` (`POST /v1/turn` already exists) into a **stream + ask-resolve** contract so a later web client does not invent a second loop.

eve’s lesson: durable session + HITL park + runtime/sandbox split + ID-addressed NDJSON.  
eve’s trap: Workflow-as-loop (re-executes tools), a large channel adapter zoo, filesystem-authored `agent/tools/*.ts`.

y0’s lesson (separate note): Task-as-job UX. Not this spec.

### Already in tree (do not rebuild)

| Piece | Where |
|---|---|
| Persist-before-execute of `tool_use`; resume pair-repairs unpaired calls to `incomplete` | `phases.ts`, `loop/repair.ts`, `pairing.ts` |
| `permission_ask` StreamEvent | `packages/core/src/types.ts` |
| Slack/Discord leftover UI in RAM (Slack 120s buttons; Discord timer) | `slack/adapter.ts`, `discord/adapter.ts` |
| Slack/Discord/serve serialize inbound with `singleFlight` (implicit queue, no abort) | `serve.ts`, Slack/Discord `run.ts` |
| TUI mid-turn queue + `/steer` | `message-queue.ts`, `enqueueSteer` |
| Discord pairing ledger + durable `deliveries`; Slack Socket Mode (no Slack HMAC) | `pairing.ts`, `session/deliveries.ts` |
| Serve loopback + required secret + `GET /health` + `POST /v1/turn` + HMAC webhook | `cli/src/serve.ts`, `core/src/gateway/` |
| Per-turn `readFiles` / `readFileMtimes`; Edit / ApplyPatch / NotebookEdit refuse unread or mtime-stale paths | `tools/read-files.ts` |
| Docker Bash + env allowlist (`PATH/HOME/TERM/LANG` only) | `tools/terminal-backend.ts` |
| Compact: Bash tool-result budget → microcompact stubs → skip LLM if under threshold | `compact/prune.ts`, `phases.ts` `maybeCompact` |
| System prefix (MEMORY.md snapshot) is not inside the compact summary | `prompt/memory.ts`, `assembleRequest` |
| Child `SessionEngine` inherits parent `askUser` + `permissionMode`; `TaskSteer` | `tools/agent.ts` |
| Child→parent `agent_mail` mailbox (not a host inbound queue) | `session/`, `tasks/mailbox.ts` |
| `permission_rules` = allow-always, not open asks | schema v4 |

### Per-slice board

| ID | Status vs tree |
|---|---|
| E1.1 pending-ask row | **missing** (tool_use persist exists; resume closes asks as `incomplete`) |
| E1.2 `turnPolicy` field | **partial** (`singleFlight` / TUI queue exist; no field on `UserSubmitInput`) |
| E1.3 channel auth tests + `headless.md` | **partial** (serve/Discord mostly done; Slack is Socket Mode, not HMAC) |
| E2.1 file tools on docker | **missing** |
| E2.2 Write + session-scope / hash | **partial** (Edit/ApplyPatch/NotebookEdit + mtime this-turn) |
| E3.1 generalize trim + queue `/compact` | **partial** (Bash-only budget; `/compact` splices live) |
| E3.2 memory out of summarizer | **done as regression test** |
| E3.3 child ask event + `childSessionId` | **partial** (shared `askUser` already fires; no parent event id) |
| E4.1 stream + ask-resolve on serve | **partial** (`/v1/turn` is one-shot JSON; `dontAsk` denies leftover-ask) |
| E4.2 `raven eval` | **missing** (pairing already gated by `bun test`) |

---

## Constraints (unchanged)

1. One `queryLoop`. Every host (Ink, OpenTUI, exec, ACP, serve, Slack, Discord, later HTTP) only calls `submitMessage`.
2. Default prefix stays small and frozen. No new always-on tool unless this doc says so.
3. `dontAsk` never becomes `bypass`. Headless Bash needs a project rule or a sandbox that **actually applies**.
4. BYOK is the product. Ads never touch BYOK.
5. Clean-room. Steal semantics. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**.

---

## Do not build

- eve’s inline execute-then-persist step (conflicts with persist-before-execute)
- Nitro / Vercel Workflow / `eve/v1` clone as a product name
- Telegram, Teams, Twilio, Linear, Photon, Linq, Chat SDK, MCP-as-channel
- Self-modification (“agent edits its own agent/”)
- OpenAPI connections as a new core tool
- Project `agent/tools/*.ts` compile surface
- Default auto-approve (`approval: never()` as product default)
- Second query loop in Next.js or Socket.IO

---

## Waves

Do the waves in order. Inside a wave, slices in the same box may run in parallel (disjoint files).

```
Wave E1  durable HITL + host delivery policy     (unattended Slack/Discord)
Wave E2  sandbox port + write hygiene            (honest docker backend)
Wave E3  compact / memory / child HITL           (long session quality)
Wave E4  session HTTP contract + raven eval      (serve waist; quality net)
```

Do not start a web UI in this spec. E4 is the prerequisite, not the product.

---

## Wave E1 — Durable leftover-ask and delivery policy

Goal: kill -9 or a six-hour Slack delay does not drop pairing or steal a leftover answer.

### E1.1 Persist pending permission / AskUser batches

**Why.** eve parks on `PendingInputBatch` and holds no compute. RavenClaw already persists the `tool_use` row before `askUser`. The **open decision** is RAM-only (Ink `askRef`, Slack `permits` Map 120s, Discord timer). Kill mid-ask then `loadSession` → `repairRoleAlternation` writes `incomplete` and does **not** re-ask. There is no `ignored` dismiss-and-continue today (eve steal). Slack non-allow/deny text is a later `singleFlight` turn.

**Contract.**

- After persist-before-execute of `tool_use`, if the decision is leftover-ask or AskUser, persist a **new** pending-ask record (not `permission_rules`): `{ sessionId, callIds, kind, withheldAssistantId, createdAt }`.
- Hosts render from that row, not from RAM only.
- Resume / next `submitMessage` / Slack button must `requestId`-match. Unmatched leftover responses re-queue. Unmatched open asks get a real `tool` deny (or an explicit new `ignored` result — **not current behavior**). Pairing stays 1:1.
- Approvals do **not** dismiss-on-message.
- Resume must **not** flush an open pending-ask as `incomplete`.

**Files.** `packages/core/src/permissions/`, `packages/core/src/session/`, `loop/phases.ts` `executeCall`, `loop/repair.ts`, Slack/Discord adapter Maps.

**Done when.** Kill mid-ask; `raven --resume` shows the same ask and a later answer pairs. No unpaired `tool_use`.

### E1.2 `turnPolicy` on host deliveries

**Why.** eve puts `steer | queue` on the delivery so cancel cannot desync. Slack/Discord/serve already serialize with `singleFlight` (wait, do not abort) — Slack follow-ups **already** cannot cancel a live turn. TUI is the only steer + `/queue` host. `UserSubmitInput` has no `turnPolicy`. Mailbox (`agent_mail`) is child→parent mail, not a host inbound queue.

**Contract.**

- Every host inbound message carries `turnPolicy: 'steer' | 'queue'` on `submitMessage` / the host flight, not on `agent_mail`.
- Default for TUI: `steer` (current interrupt). Default for Slack/Discord/serve: document the existing `queue` (`singleFlight`); do not add a second serializer.
- Permission answers (`tryResolvePermit` / Discord buttons) never steer.

**Files.** `packages/core/src/types.ts` `UserSubmitInput`, TUI `message-queue.ts`, Slack/Discord `singleFlight`, `raven serve`.

**Done when.** A queued Slack message still cannot cancel a live turn; a steered TUI message still aborts; the policy is explicit on the delivery.

### E1.3 Channel auth invariants (tests, not new networks)

**Why.** eve: HMAC on raw body, `timingSafeEqual`, never trust body `principalId`. Serve already exits 1 without a secret, rejects non-loopback, 401s missing Bearer (`checkBearer` + `timingSafeEqual`), and HMAC-verifies webhooks on the raw body. Discord identity is gateway `author.id` + pairing ledger + durable `deliveries`. Slack is **Socket Mode app-token**, not Slack signing-secret HMAC; `userId` comes from the trusted socket. `docs/headless.md` does not yet document serve bind/token law.

**Contract.**

- Slack/Discord/serve: identity from verified socket/gateway/pairing or HMAC, never from a JSON field the body claims.
- Serve: keep loopback + required secret + 401. Document in `docs/headless.md`.
- Add tests: Slack does not honor a forged body `user`; Discord does not honor a forged `author.id`; serve `/v1/turn` without Bearer is 401 (already true — pin it).

**Files.** `packages/core/src/gateway/{http,webhook}.ts`, `cli/src/serve.ts`, Slack/Discord admit, `docs/headless.md`.

**Done when.** Forged body identity cannot act. `headless.md` states serve bind/token law. Slack HMAC is **not** a requirement (Socket Mode).

---

## Wave E2 — Sandbox port and write hygiene

Goal: `terminal.backend: docker` means **the model’s filesystem is the container**, not “Bash is in Docker and Write still hits the host.”

### E2.1 File tools honor the terminal backend

**Why.** eve’s `read_file` / `write_file` / `bash` all proxy into one sandbox. RavenClaw Docker is Bash-only. That is a lie if `dontAsk` is sold as isolation.

**Contract.**

- When `terminal.backend === 'docker'`, Read / Write / Edit / ApplyPatch / ListDir / Grep / Glob / ReadSubtree execute against the same workspace mount the Bash job uses (`-v cwd:cwd -w cwd` today is acceptable v1).
- Secrets: keep the existing docker env allowlist (`PATH/HOME/TERM/LANG`). Do not pass `ANTHROPIC_API_KEY` / MCP headers into the container.
- Local backend unchanged. `docs/headless.md` already says Docker “only changes where allowed Bash runs” — update that sentence when this ships.
- No new default tool.

**Files.** `packages/core/src/tools/terminal-backend.ts`, Read/Write/Edit/Grep/Glob (today `node:fs` on the host), optional thin `WorkspaceFs` port, `docs/headless.md`.

**Done when.** Docker session: Write creates the file inside the container mount; host-only paths outside cwd fail closed. Tests with a fake `runCommand`.

**Shipped pointer (2026-09-21).** Grep/Glob docker-exec landed on `main` at `a52eab1` ([`2026-09-21-grep-glob-docker-exec.md`](2026-09-21-grep-glob-docker-exec.md)): search shares Bash’s `TerminalBackend` (one `docker run` per call). WorkspaceFs docker I/O is unparked by [`2026-09-21-workspacefs-docker.md`](2026-09-21-workspacefs-docker.md) (Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree share that same port). NotebookEdit docker unparked by [`2026-09-21-notebookedit-docker.md`](2026-09-21-notebookedit-docker.md): notebook bytes share that same port (`cat` then `tee`+stdin) when kind+image. Memory in container, file-history docker, `ignored` dismiss-on-message, LSP museum, and web UI stay OUT. `ignored` leftover-ask result landed at `22a55c1` ([`2026-09-21-ignored-dismiss.md`](2026-09-21-ignored-dismiss.md); dismiss-on-message stays parked). Bounded LSP depth landed at `6c797d1` ([`2026-09-21-lsp-depth.md`](2026-09-21-lsp-depth.md); handshake museum stays OUT).

### E2.2 Read-before-write + stale hash

**Why.** eve `write_file` refuses a write if the file was never read or the hash drifted. RavenClaw already has `Turn.readFiles` / `readFileMtimes` (`tools/read-files.ts`). Edit, ApplyPatch, and NotebookEdit already error “path must be Read first” / “file changed since last Read” (**mtime**, this `submitMessage` only). `Write.execute` still overwrites with no check. Compact does not reset a session map because the map dies with the turn.

**Contract.**

- Add the same unread / stale check to **Write** (new files still ok).
- Keep **mtime** as the law unless a follow-up explicitly switches to content hash.
- Do **not** silently change the cache to session-scoped in this slice (that would change current this-turn Edit semantics). If we later want “since last compact,” that is a separate contract.
- Compact (E3.1) only needs to reset a map if we introduce session scope.

**Files.** `packages/core/src/tools/write.ts`, `read-files.ts`, `write.test.ts`.

**Done when.** Write without Read on an existing file is a tool error, not a silent clobber. Pairing still 1:1. Edit/ApplyPatch behavior unchanged.

---

## Wave E3 — Compact, memory, child HITL

Goal: a 2-hour session after compact still has todos, does not re-clobber unread files, and a child’s leftover-ask appears on the parent host.

### E3.1 Compact: trim tool results, then summarize

**Why.** eve caps oversized tool results before the LLM summary. RavenClaw already runs `applyToolResultBudget` → `microcompact` → skip LLM if under threshold (`phases.ts` `maybeCompact`). Default `llmSummarize` is false (`mechanicalSummary`). Gaps: budget is **Bash-only** (100k, first 400 chars); `microcompact` stubs Read/Grep/Glob/Bash/Agent to `[cleared …]`; no compaction-prompt token envelope; `/compact` → `compactNow()` **splices the live transcript**; todos live in `.ravenclaw/todo.json` and are not re-injected.

**Contract.**

- Generalize tool-result budget beyond Bash; keep head+tail (not first 400 only).
- Include a compaction-prompt token envelope in the threshold.
- Manual `/compact`: if a turn is live, **queue** (do not splice). Idle `/compact` still runs immediately.
- Optional: restore-note for current todos (do not add a tool). Do not reset a session read map unless E2.2 grows one.

**Files.** `packages/core/src/compact/prune.ts`, `summarize.ts`, `phases.ts` `maybeCompact`, `session-engine.ts` `compactNow`.

**Done when.** A session with one 200k non-Bash tool result trims mechanically and can skip the LLM when the rest fits.

### E3.2 Memory out of the summarizer

**Why.** eve excludes attributed memory from compact, then recalls after. RavenClaw already injects MEMORY.md via `buildSystemParts` / `loadMemorySnapshot` as a **separate** `ProviderRequest.system`. Compact summarizes the message middle only (`runAutocompact` / `summarizeSpan`). The frozen snapshot stays until `/reload`; compact does **not** rewrite it and does **not** need to rebuild from disk each request.

**Contract.**

- Add a regression test: after compact, the next API call’s `system` still equals the captured MEMORY/instructions snapshot (not the compact summary).
- Do not invent memory slots/providers. Do not change frozen-until-`/reload`.

**Files.** `packages/core/src/prompt/memory.ts`, compact tests.

**Done when.** That test exists and fails if compact ever copies MEMORY into the summary as the new system prefix.

### E3.3 Child leftover-ask proxies to the parent host

**Why.** eve bubbles child `input.requested` to the parent stream. RavenClaw children already `createSessionEngine` with the **parent `askUser`** and inherited `permissionMode`. A **foreground** child ask can already pop the parent dialog — with no `childSessionId` on `permission_ask`. Background children use `TaskSteer` (text inject), not leftover-ask proxy. Channel/cron children are `dontAsk` → leftover-ask becomes deny.

**Contract.**

- Child leftover-ask / AskUser emits a parent-visible `permission_ask` (or `child_ask`) with `childSessionId` + `callId`.
- The parent host can approve/deny. The answer is the child’s tool result (pairing on the **child** transcript).
- No new child kernel. No `execute_code`.

**Files.** `packages/core/src/tools/agent.ts`, `task.ts` `TaskSteer`, Ink/OpenTUI/Slack ask UI, `StreamEvent` type.

**Done when.** TUI labels a child Bash leftover-ask with the child id and answering it unblocks the child without a second loop.

---

## Wave E4 — Session HTTP contract and evals

Goal: `raven serve` speaks a documented session API a future web client can implement. Quality net for the waist.

### E4.1 Versioned session routes on `raven serve`

**Why.** eve’s waist is `POST /session` + `GET /session/:id/stream` (NDJSON) + cancel/compact/clear. RavenClaw already has loopback, required secret, `GET /health`, `POST /v1/turn` (Bearer JSON via `runExec`), HMAC `POST /webhooks/:route`, and a session map at `~/.ravenclaw/gateway/sessions.json`. Missing: NDJSON stream, cancel/compact routes, leftover-ask resolve. Serve forces `dontAsk`, so leftover-ask is deny today. A web UI that talks Socket.IO+Prisma (y0) would still grow a second loop.

**Contract.**

- Keep loopback + required secret + existing `/v1/turn` + webhook.
- Add stream + cancel + compact. Reuse `StreamEvent` including `permission_ask` — do **not** invent `input.requested` aliases unless we add them as synonyms.
- Leftover-ask over HTTP requires either dropping `dontAsk` on that API or an explicit resolve route (call that out in the impl).
- No channel continuation tokens. Hosts still only `submitMessage`.

**Files.** `packages/cli/src/serve.ts`, `packages/core/src/gateway/`, `docs/headless.md`.

**Done when.** `curl` create/turn + stream + leftover-ask resolve works against loopback without the TUI.

### E4.2 `raven eval` fixture runner (minimal)

**Why.** eve evals are path-identity cases that drive a real session. We have `bun test` (no model) and `smoke` (live, not CI). We need a third: fixture agents + recorded or mock-model assertions on stream facts.

**Contract.**

- `evals/<name>/` or `packages/core/src/eval/fixtures/<name>/` with a case file (prompt + expected tool names / deny / pairing).
- Runner drives `createSessionEngine` in-process (not a network eve clone). Mock or recorded provider.
- Assertions: gate (fail CI) only on pairing, leftover-ask persist, sandbox cwd, compact-not-touching-system-prefix. No LLM-as-judge in v1.
- Path is identity. No authored `id` field required.
- Existing `bun test` pairing/resume/pipeline cases stay; eval is a fixture runner, not the first pairing CI.

**Files.** new `packages/core/src/eval/` or `packages/cli/src/eval/`, a few fixtures for E1/E2.

**Done when.** `bun test` or `bun run raven eval` fails if leftover-ask persist is broken, without calling a vendor.

---

## Out of this horizon

Web chat UI, Next.js BFF, y0 Task/PR/wiki, eve compiler, OpenAPI connections, memory slots/providers, `defineState`, credential brokering, self-mod, any new chat network.

If a later product wants a browser, it implements E4.1. It does not add a second loop.

---

## Suggested order

1. **E1.1 + E1.2** — pending-ask row + explicit turnPolicy (Slack overnight). E1.2 is mostly documenting `singleFlight`.
2. **E1.3** — pin serve/Discord tests + `headless.md` (small).
3. **E2.2 then E2.1** — Write unread check first (small); then docker file port.
4. **E3.1 + E3.3**; E3.2 is a regression test only.
5. **E4.1 then E4.2** — extend `/v1/turn`, then evals that lock E1/E2.

---

## Success checks

A slice that does not move one of these is out of scope.

1. Kill mid-leftover-ask; resume answers the same ask (E1.1).
2. Slack follow-up with `queue` does not abort a live turn (E1.2).
3. Docker backend: Write is not a host-only side channel (E2.1).
4. Existing-file Write without Read is a tool error (E2.2).
5. Huge tool result compact does not require an LLM when trim is enough (E3.1).
6. Child leftover-ask is visible on the parent TUI (E3.3).
7. `curl` loopback stream can resolve an ask (E4.1).
8. An eval fixture fails CI if pairing or ask persist regresses (E4.2).
