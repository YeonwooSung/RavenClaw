# Changelog

## Unreleased

### Added
- Memory shares Bash’s `TerminalBackend` when kind+image construct docker **and** the memory file sits inside `turn.cwd`: in-tree `.ravenclaw/MEMORY.md` / `USER.md` bytes go through `createWorkspaceFs` (`stat`/`readFile`, `mkdir`, `writeFile` tee+stdin). Omit/local/`createTerminalBackend('docker')` without image stays host `node:fs` (including the `projectCwd` sidecar). Job isolation (`projectCwd` outside `cwd`) on docker returns `Memory failed: outside workspace` with zero exec and no host write. Cap/match refuse issue no write exec. Fail-closed (`Memory failed:`; no host fallback). Turn abort throws `AbortError` / `ABORTED_TEXT`. Leftover-ask unchanged. SDK still includes Memory. TodoWrite, Skill, and file-history writers stay host. Spec: [docs/superpowers/specs/2026-09-22-memory-docker.md](docs/superpowers/specs/2026-09-22-memory-docker.md). Plan: [docs/superpowers/plans/2026-09-22-memory-docker.md](docs/superpowers/plans/2026-09-22-memory-docker.md).
- **Shipped** WorkspaceFs docker I/O (Waves W0–W2). When Bash is actually docker (backend **and** image), Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree exec in that container (`-v cwd:cwd -w cwd`, allowlist env, one exec per WorkspaceFs method). Omit/local/`createTerminalBackend('docker')` without image stays the host WorkspaceFs jail. Jail first; no host fallback. Turn abort throws `AbortError` / `ABORTED_TEXT`. Memory and file-history writers stay host. Spec: [docs/superpowers/specs/2026-09-21-workspacefs-docker.md](docs/superpowers/specs/2026-09-21-workspacefs-docker.md). Plan: [docs/superpowers/plans/2026-09-21-workspacefs-docker.md](docs/superpowers/plans/2026-09-21-workspacefs-docker.md).
- NotebookEdit shares Bash’s `TerminalBackend` when kind+image construct docker: two `backend.exec` calls (`cat` then `tee` with stdin). Omit/local/`createTerminalBackend('docker')` without image stays host `readFileSync`/`writeFileSync` after a new cwd jail (`NotebookEdit failed: outside workspace`). Fail-closed (`NotebookEdit failed:`; no host write). Turn abort throws `AbortError` / `ABORTED_TEXT`. Leftover-ask unchanged; SDK still omits the tool. Spec: [docs/superpowers/specs/2026-09-21-notebookedit-docker.md](docs/superpowers/specs/2026-09-21-notebookedit-docker.md). Plan: [docs/superpowers/plans/2026-09-21-notebookedit-docker.md](docs/superpowers/plans/2026-09-21-notebookedit-docker.md).
- Idle `submitMessage` dismisses owned unpaired leftover-asks (`IGNORED_TEXT`, no execute) then continues the new user text. `liveTurn !== null` still yields `pending permission ask`. Persist-fail is all-or-nothing before the user row. `applyAskAnswer(..., 'ignored')` / Ink `i` still pair only. `clearKeepId` / `rewindLast` still refuse. Esc / I2 stay `ABORTED_TEXT`. Slack/Discord/ACP stay 3-way (a follow-up **message** through `submitMessage` dismisses as a side effect). Schema stays **v11**. Spec: [docs/superpowers/specs/2026-09-21-dismiss-on-message.md](docs/superpowers/specs/2026-09-21-dismiss-on-message.md). Plan: [docs/superpowers/plans/2026-09-21-dismiss-on-message.md](docs/superpowers/plans/2026-09-21-dismiss-on-message.md).
- `/config instructions claude|agents-fallback|both` persists `instructionFiles` in `~/.ravenclaw/config.yaml` (surgical upsert) and rebuilds the context-tier project walk. Default `both` keeps today’s AGENTS.md + CLAUDE.md load. `claude` skips AGENTS.md / AGENTS.local.md. `agents-fallback` uses CLAUDE.md when that file exists in a directory, else AGENTS.md. RavenClaw-native `RAVEN.md` / rules stay on. Spec: [docs/superpowers/specs/2026-09-21-instruction-files-config.md](docs/superpowers/specs/2026-09-21-instruction-files-config.md). Plan: [docs/superpowers/plans/2026-09-21-instruction-files-config.md](docs/superpowers/plans/2026-09-21-instruction-files-config.md).
- **Shipped** bounded LSP depth (handshake honesty + `implementation` / `typeDefinition` / `diagnostic`) on `main` at `6c797d1` (PR #14). Same gated `LSP` tool; 256 KiB frame cap is LSP-client-only. SDK and children still omit. Spec: [docs/superpowers/specs/2026-09-21-lsp-depth.md](docs/superpowers/specs/2026-09-21-lsp-depth.md). Plan: [docs/superpowers/plans/2026-09-21-lsp-depth.md](docs/superpowers/plans/2026-09-21-lsp-depth.md).
- **Shipped** ignored dismiss-and-continue (Waves I0–I2) on `main` at `22a55c1` (PR #15). Parked `'ignored'` persist-then-drops one `IGNORED_TEXT` row (no execute, no model turn). Live `'ignored'` continues (`abortRest: false`). HTTP `POST …/resolve` keeps `{ callId, allow }` and accepts optional `answer` including `'ignored'` and `'allow_always'`; disagreeing fields 400. Ink `i`; OpenTUI `i`/`skip`/`ignored`. Esc / I2 stay `ABORTED_TEXT`. Slack/Discord/ACP stay 3-way. Schema stays **v11**. Spec: [docs/superpowers/specs/2026-09-21-ignored-dismiss.md](docs/superpowers/specs/2026-09-21-ignored-dismiss.md). Plan: [docs/superpowers/plans/2026-09-21-ignored-dismiss.md](docs/superpowers/plans/2026-09-21-ignored-dismiss.md).
- **Shipped** Grep/Glob docker-exec (Waves S0–S2) on `main` at `a52eab1` (PR #16). When Bash is actually docker (backend **and** image), Grep/Glob `docker run` once in that container (`-v cwd:cwd -w cwd`, allowlist env). Omit/local/`createTerminalBackend('docker')` without image stays host `rg`/walk. Jail `stat` first; no host fallback. Turn abort throws `AbortError` / `ABORTED_TEXT`. Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree stay the host WorkspaceFs jail. Spec: [docs/superpowers/specs/2026-09-21-grep-glob-docker-exec.md](docs/superpowers/specs/2026-09-21-grep-glob-docker-exec.md). Plan: [docs/superpowers/plans/2026-09-21-grep-glob-docker-exec.md](docs/superpowers/plans/2026-09-21-grep-glob-docker-exec.md).
- **Shipped** leftover-ask abort-pair completeness + cancel 202/200 (Waves L0–L4) on `main` at `067bfba`. Idle `abort('cancel')` and `abort('interrupt')` abort-pair this session’s leftover-asks (I2 law; leftover flight persist starts on `whenTreeStop()`). Live cancel still owns this-session I2 in the cancelled epilogue (no double write). Parent interrupt still leaves a child leftover-ask. Live `POST …/cancel` is **202** `{ ok: true }` without join; idle + work is **200** after join; idle + nothing and stale live `turnId` stay **200** `no_active_turn`. Spec: [docs/superpowers/specs/2026-09-20-leftover-ask-abort-pair.md](docs/superpowers/specs/2026-09-20-leftover-ask-abort-pair.md). Plan: [docs/superpowers/plans/2026-09-20-leftover-ask-abort-pair.md](docs/superpowers/plans/2026-09-20-leftover-ask-abort-pair.md).
- HTTP `POST /v1/session/:id/clear` on `main` at `a53be93` awaits `engine.clearKeepId()` and returns **200** `{ ok, notice }` (`session cleared` / `clear persist failed` / `pending permission ask`). Unknown session 404, no mint. Spec: [docs/superpowers/specs/2026-09-20-http-post-clear.md](docs/superpowers/specs/2026-09-20-http-post-clear.md).
- Schema v11 `sessions.pending_reset_sha` on `main` at `dc45aec` (dual-write with `job_json.pendingResetSha`). Job rewind compact + flag are one `BEGIN IMMEDIATE`. `createSessionEngine` is async and recovers a pending reset; GET snapshot reads `store.loadSession` only (`live` from `liveRuntimes`). Spec: [docs/superpowers/specs/2026-09-20-rewind-recovery-v11.md](docs/superpowers/specs/2026-09-20-rewind-recovery-v11.md). Plan: [docs/superpowers/plans/2026-09-20-rewind-recovery-v11.md](docs/superpowers/plans/2026-09-20-rewind-recovery-v11.md).
- **Shipped** parent tree-stop (Waves K0–K5) on `main` at `9901d0e`. Parent `abort('cancel')` / `/stop` / `POST …/cancel` abort descendant live turns then persist-before-drop descendant leftover-asks (I2 law). Idle parent still walks descendants; this session’s parked asks stay. Serve idle + descendant work is `200 { ok: true }`; idle + nothing stays `no_active_turn`. Spec: [docs/superpowers/specs/2026-09-18-parent-tree-stop.md](docs/superpowers/specs/2026-09-18-parent-tree-stop.md). Plan: [docs/superpowers/plans/2026-09-18-parent-tree-stop.md](docs/superpowers/plans/2026-09-18-parent-tree-stop.md).
- **Shipped** keep-id `/clear` (Waves K0–K4) on `main` at `edeb611`. `/clear` / `/new` keep `session.id` and the live engine. Persist-first `store.clearConversation` inactivates the transcript (`recordCompact` summary `'clear'`), drops this session’s pending asks and stream events, and wipes followup/lastEnd/todos/title/usage. Mid-turn is `abort('cancel')` then wipe. Unpaired child leftover-asks refuse (`pending permission ask`). Job, worktree, lock, MCP, and children stay. No `POST /v1/session/:id/clear`. Spec: [docs/superpowers/specs/2026-09-18-keep-id-clear.md](docs/superpowers/specs/2026-09-18-keep-id-clear.md). Plan: [docs/superpowers/plans/2026-09-18-keep-id-clear.md](docs/superpowers/plans/2026-09-18-keep-id-clear.md).
- **Shipped** stream protocol `version: 1` and opaque `continuationToken` (Waves V0–V3) on `main` at `c9c4871`. GET snapshot and every NDJSON `/stream` frame stamp `version: 1` at serialize time (not on `StreamEvent` / `payload_json`). `?version=` on snapshot and stream fail-closes unknown/malformed values after Bearer and before session load. `continuationToken` is `base64url({ v:1, s, q })` and resumes the same `seq > q` window as `?after=`. Both resume keys on `/stream` are 400 `resume conflict`. Schema stays **v10**. Spec: [docs/superpowers/specs/2026-09-18-stream-version-token.md](docs/superpowers/specs/2026-09-18-stream-version-token.md). Plan: [docs/superpowers/plans/2026-09-18-stream-version-token.md](docs/superpowers/plans/2026-09-18-stream-version-token.md).
- **Shipped** no-job todo revert (Waves J0–J3) on `main` at `be5a4a7`. No-job success turns stamp a sha-less `todoSnapshot` on the last assistant (`checkpoint_json`, no schema bump). `/rewind` on a cwd session persist-then-undo stays; after a successful drop it persist-first restores `session.todos` from the remaining snapshot (or `[]` with no remaining assistant) and re-projects `.ravenclaw/todo.json`. Legacy unstamped assistants leave todos. Job rewind ignores sha-less checkpoints. Spec: [docs/superpowers/specs/2026-09-18-no-job-todo-revert.md](docs/superpowers/specs/2026-09-18-no-job-todo-revert.md). Plan: [docs/superpowers/plans/2026-09-18-no-job-todo-revert.md](docs/superpowers/plans/2026-09-18-no-job-todo-revert.md).
- Architecture and slash-command references: [ARCHITECTURE.md](ARCHITECTURE.md) / [ARCHITECTURE.ko.md](ARCHITECTURE.ko.md), [SLASH_COMMANDS.md](SLASH_COMMANDS.md) / [SLASH_COMMANDS.ko.md](SLASH_COMMANDS.ko.md). Docs match the waist: schema version **11** (`pending_asks`, session todos, `job_json` / checkpoints, `stream_events`, `last_end_json`, `job_error`, `followup_text`, `pending_reset_sha`), `applyAskAnswer`, `clearKeepId` (`POST …/clear`), async `createSessionEngine` recover, GET snapshot `loadSession` only, and session routes `GET /v1/session/:id` (`version` / `continuationToken`), `GET …/stream?after=` / `?continuationToken=`, `POST …/{submit,resolve,cancel,compact,clear,pr,followup,edit}`, `DELETE …/followup`, `GET …/diff`.
- **Shipped** cancel abort-pair / reset-on-resume / follow-up persist (Waves I0–I4) on `main` at `5eefdde`. Live `abort('cancel')` abort-pairs **this** session’s leftover-asks (drop-only when already transcript-paired; unpaired persist one `ABORTED_TEXT` then drop). No live turn / `abort('interrupt')` / child leftover-ask unchanged; stream emits `cancelled, ask still pending` only if a row remains. Job rewind writes `pendingResetSha` after compact and before `git reset --hard`; the first later `submitMessage` / `rewindLast` / host `/diff` finishes it via `maybeFinishRewindReset` (`createSessionEngine` stays sync; GET snapshot does not reset). `writeFollowup` persist-then-assign. Spec: [docs/superpowers/specs/2026-09-18-cancel-reset-followup.md](docs/superpowers/specs/2026-09-18-cancel-reset-followup.md). Plan: [docs/superpowers/plans/2026-09-18-cancel-reset-followup.md](docs/superpowers/plans/2026-09-18-cancel-reset-followup.md).
- **Shipped** job-host state (Waves G0–G4) on `main` at `6e56764` (merge of PR #9 / `feat/job-host-state`): schema **10** (`last_end_json`, `job_error`, `followup_text`); GET snapshot fields `title`, `jobAutoCommit`, `lastEnd`, `jobError`, `queued`; `POST/DELETE …/followup`; `POST …/edit`; `GET …/diff`; TUI `/follow`, `/retry`, and job-range `/diff`. Follow-up runs only after this submit wrote `lastEnd` and skips owned leftover-asks. Spec: [docs/superpowers/specs/2026-09-17-job-host-state-roadmap.md](docs/superpowers/specs/2026-09-17-job-host-state-roadmap.md). Plan archive: [docs/superpowers/plans/2026-09-17-job-host-state-implementation.md](docs/superpowers/plans/2026-09-17-job-host-state-implementation.md).
- **Shipped** rewind persist-before-reset / `todo.json` projection (Waves H0–H3) on `main` at `048deff`. Job rewind persists the transcript drop (`recordCompact`) **before** `git reset --hard`. Persist fail leaves HEAD and the last user. Reset fail after persist keeps the drop and sets `jobError`. Successful job rewind re-projects project `.ravenclaw/todo.json` from `session.todos` (`originalCwd ?? cwd`); write failure is a notice suffix, not a `jobError`. Spec: [docs/superpowers/specs/2026-09-18-rewind-persist-and-todo-projection.md](docs/superpowers/specs/2026-09-18-rewind-persist-and-todo-projection.md). Plan: [docs/superpowers/plans/2026-09-18-rewind-persist-todo-projection.md](docs/superpowers/plans/2026-09-18-rewind-persist-todo-projection.md).
- **Shipped** session-as-job horizon (Waves F0–F4) on `main` at `ea56edd`: named `raven/*` shadow job, opt-in turn-end commit, checkpoint `/rewind`, reconnectable serve (`seq` / `?after=` / GET snapshot), cancel ≠ fail (`turnId` / `no_active_turn`, parked asks stay), optional `/pr` and `POST …/pr`. Spec: [docs/superpowers/specs/2026-09-16-session-as-job-roadmap.md](docs/superpowers/specs/2026-09-16-session-as-job-roadmap.md). Plan archive: [docs/superpowers/plans/2026-09-16-session-as-job-implementation.md](docs/superpowers/plans/2026-09-16-session-as-job-implementation.md). Prior-art: [docs/research/y0-analysis.md](docs/research/y0-analysis.md) ([한국어](docs/research/y0-analysis.ko.md)).
- **Shipped** session-as-job closeout on `main` at `0ef1554` (merge of `feat/session-as-job-closeout`). Four honesty holes: ACP `session/load` and `session/prompt` drain `replayPendingAsks` after waiter timeout (H1; same-RPC timeout still `abandonSubmit` + `cancelled`); `TodoWrite failed:` does not `applyWrittenTodos` and returns `ok: false`; `/pr` upserts one `draft_pr` content block plus the human `Draft PR:` line; stacked-child cleanup runs `git branch -D` on the `raven/*` shadow when the worktree is pruned (dirty keep-path reports `leftoverBranch`). Plan archive: [docs/superpowers/plans/2026-09-17-session-as-job-closeout.md](docs/superpowers/plans/2026-09-17-session-as-job-closeout.md).
- **Shipped** eve-inspired horizon (Waves E1–E4) and leftover-ask hole PRs #2–#8 on `main` at `d4c73d4`: durable HITL parking, sandbox-port, session HTTP, eval contracts. Plan archive: [docs/superpowers/plans/2026-09-15-eve-inspired-implementation.md](docs/superpowers/plans/2026-09-15-eve-inspired-implementation.md). Spec: [docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md](docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md). Prior-art: [docs/research/eve-analysis.md](docs/research/eve-analysis.md) ([한국어](docs/research/eve-analysis.ko.md)).

### Changed
- Built-in model catalog now matches the current Claude and OpenAI flagship lineups (`claude-sonnet-5`, `claude-opus-5`, `claude-fable-5-1`, `claude-haiku-4-5`, `gpt-6-astra`, `gpt-5.6-sol` / `gpt-5.6`, `gpt-5.6-terra`, `gpt-5.6-luna`). Defaults go through `defaultModelId(family, role)` so generation bumps touch one table. Vendor-prefixed and dated aliases still resolve. README Models section and CONTRIBUTING catalog-update steps document the pattern.
- `/add-dir` and `/effort` help and notices say they do not add a root or persist effort. README lists `/team-onboarding`.
- `/model <id>` reloads the session profile (context, prices, thinking) for the next turn.
- README: `/model` is no longer described as string-only; `raven discord` and `raven pairing` are in the CLI table; Local gateway no longer says Slack/Discord are missing; builtin skills include `frontend-design` and `mcp-builder`.

## 0.1.33 — 2026-09-11

v1.x product surfaces land, then leftover-ask, one-shot Bash, Fetch, and resume gates are tightened.

### Added
- Leftover-ask for Edit/Write/Agent/Bash/MCP; file hooks; slash registry (`/clear` `/model` `/reload` `/permissions` `/mcp` `/skills` `/config` `/context`)
- `Fetch` and `TodoWrite`; disk agents; `.ravenclaw/rules` and `RAVEN.local.md`
- 413 compact-retry, Bash `persistPath`, plan.md restore, LLM `/compact`

### Fixed
- Command-runner persists then runs Bash through `decidePermission`; disk agents are spawnable
- `dontAsk` / `raven exec` allow in-tree Edit/Write and read-only Bash
- Fetch blocks IPv6-mapped loopback and pins DNS; hooks run in the session cwd
- `placementRequired` is new-session only; second 413 is `context_full`
- AdDock no longer steals Enter; `/reload` rebuilds system parts
- Shared privacy sentence in ads, README, and CLI help

### Try it

```bash
git clone --branch v0.1.33 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun test
bun run raven --version
```

## 0.1.32 — 2026-09-11

ACP and resume keep included funding paired with the right provider, and paid-plan ads stop selling the cap.

### Fixed
- `raven acp` boots without an orphan session; `session/new` uses that store id; `session/load` resumes
- Resume picks the provider from `session.funding` (`remainingSessions: 0` does not block an included load)
- Gateway `remainingSessions` no longer inflates the local daily ledger
- `tryRecordIncludedSession` denies the slot when the ledger write fails
- Explicit `--provider` stays BYOK even if the included probe admits
- Paid-plan house ads drop the cap upsell (`hasPaidCapacityPlan`)
- OpenTUI mounts the included ad dock

### Try it

```bash
git clone --branch v0.1.32 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun test
bun run raven --version
```

## 0.1.31 — 2026-09-11

Skill allow-lists jail execute, worktree children keep parent project policy, and included resume no longer burns the daily cap.

### Fixed
- Skill `allowed-tools` now jails execute and `Agent` children (hidden names do not run)
- `isolation: worktree` loads project permissions and skills from the parent cwd
- OpenAI-compat defers tool-result images until after a contiguous tool run
- Responses maps tool-result images as a follow-up `input_image` user item
- `included.gatewayUrl` with or without `/v1` probes `…/v1/entitlement` and chats `…/v1/chat/completions`
- `raven resume` does not create an orphan session or increment the included daily cap
- Local included-cap reserve is atomic (mkdir lock)

### Try it

```bash
git clone --branch v0.1.31 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun test
bun run raven --version
```

## 0.1.30 — 2026-09-11

Catalog coerce keeps the gateway entitlement model, and worktree children resume from the parent cwd.

### Fixed
- Included-gateway catalog coerce retries with entitlement `defaultModel` before `included.defaultModel` / `config.model`
- `Agent` `isolation: worktree` persists the parent cwd so child resume does not point at a deleted worktree

### Try it

```bash
git clone --branch v0.1.30 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun test
bun run raven --version
```

## 0.1.29 — 2026-09-11

The leftover v1.x seams: optional included gateway, embeddable SDK, plan.md, skill tool pools, worktrees, images, Responses, local plugins.

### Added
- `included.enabled` (default false), daily session cap, and catalog coerce on the included-model gateway client
- `@ravenclaw/sdk` `createRavenSession` — same engine as the CLI, no Ink/ads
- Plan mode may Edit/Write only `.ravenclaw/plan.md`; ExitPlanMode fills the stub from assistant text
- Skill `allowed-tools` intersects and shrinks the live pool; builtin prefix stays contiguous
- `Agent` `isolation: worktree` (git worktree, removed after the child)
- Image tool results (`Read` of small png/jpeg/gif/webp) mapped on OpenAI and Anthropic
- `createProvider({ provider: 'openai_responses' })` for the OpenAI Responses API
- Local plugins from `~/.ravenclaw/plugins/<name>/plugin.json` (user-installed only; leftover ask, so `dontAsk` denies)
- OpenAI-compat keeps tool-result images off `role: tool` (follow-up user part instead)

### Try it

```bash
git clone --branch v0.1.29 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun test
bun run raven --version
```

## 0.1.28 — 2026-09-11

Local LLM smoke is text-only, and `raven doctor` probes Ollama / vLLM.

### Changed
- `raven smoke` sends no tools (`maxRounds: 1`) so a small local model can reply `pong`

### Added
- `raven doctor` reaches Ollama `/api/tags` or vLLM `/models` when that provider is configured
- Env-gated live tests: `OLLAMA_HOST` / `VLLM_BASE_URL` (optional `OLLAMA_MODEL` / `VLLM_MODEL`)

### Try it

```bash
ollama pull llama3.2:1b
git clone --branch v0.1.28 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
echo 'OLLAMA_HOST=http://127.0.0.1:11434' >> ~/.ravenclaw/.env
bun run raven smoke --provider ollama --model llama3.2:1b
bun run raven doctor
```

## 0.1.27 — 2026-09-11

Local LLMs via Ollama and vLLM, plus `raven skills rm`.

### Added
- `--provider ollama` (default `http://127.0.0.1:11434/v1`, model `llama3.2`)
- `--provider vllm` (default `http://127.0.0.1:8000/v1`, model `local-model`)
- Infer from `OLLAMA_HOST` / `VLLM_BASE_URL`; no cloud API key
- `raven setup` choices 3 and 4 write those env vars
- `raven skills rm <name>` deletes a user or `--project` skill (realpath-confined)

### Try it

```bash
ollama pull llama3.2
git clone --branch v0.1.27 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
echo 'OLLAMA_HOST=http://127.0.0.1:11434' >> ~/.ravenclaw/.env
bun run raven exec --provider ollama --model llama3.2 "Reply with the single word pong"
```

## 0.1.26 — 2026-09-11

Scaffold a skill.

### Added
- `raven skills new <name>` writes `~/.ravenclaw/skills/<name>/SKILL.md`
- `--project` writes `.ravenclaw/skills/<name>/SKILL.md` in the current repo
- Names are `a-z0-9_-` only; existing files are not overwritten

### Try it

```bash
git clone --branch v0.1.26 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven skills new demo
bun run raven skills
```

## 0.1.25 — 2026-09-11

List discovered skills.

### Added
- `raven skills` lists user (`~/.ravenclaw/skills`) and project (`.ravenclaw/skills`) skills
- A project skill of the same name wins
- Descriptions are clipped to 60 characters
- Empty dirs print `no skills`

### Try it

```bash
git clone --branch v0.1.25 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven skills
```

## 0.1.24 — 2026-09-11

Probe MCP servers and list their tools.

### Added
- `raven mcp tools` (alias `probe`) spawns each configured server, prints tool names, then closes
- Fail-open: a server that cannot start is `(no tools or failed)`
- Empty config still prints `no mcp servers`

### Try it

```bash
git clone --branch v0.1.24 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven mcp tools
```

## 0.1.23 — 2026-09-11

List configured MCP servers without spawning them.

### Added
- `raven mcp` / `raven mcp list` prints name, command, args
- Env is shown as key names only, never values
- Empty config prints `no mcp servers`

### Try it

```bash
git clone --branch v0.1.23 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven mcp
```

## 0.1.22 — 2026-09-11

CI smokes no-key CLI commands.

### Added
- Spawn tests for `--help`, `--version`, `sessions`, `config`, `init`, `completions`, `doctor`
- GitHub Actions repeats the same surface on Ubuntu
- `raven smoke` is still not run in CI

### Try it

```bash
git clone --branch v0.1.22 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun test packages/cli/src/ci-cli.test.ts
```

## 0.1.21 — 2026-09-11

Security policy and Dependabot.

### Added
- [SECURITY.md](SECURITY.md): do not paste keys; use GitHub Security Advisories for exfil / path-escape / permission-bypass
- Weekly Dependabot updates for GitHub Actions

### Try it

https://github.com/YeonwooSung/RavenClaw/security/advisories/new

## 0.1.20 — 2026-09-11

GitHub issue and pull request templates.

### Added
- Bug form: version, repro, `raven doctor` (no secrets)
- Feature form: problem, proposal, whether a key is required
- PR checklist: tests, no keys in the diff, ads isolation, pairing tests

### Try it

https://github.com/YeonwooSung/RavenClaw/issues/new/choose

## 0.1.19 — 2026-09-11

Contributor guide.

### Added
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, package layout, tests, CLI command checklist, release process
- README Develop section links to it

### Try it

```bash
git clone --branch v0.1.19 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## 0.1.18 — 2026-09-11

Shell completion for the CLI.

### Added
- `raven completions bash` and `raven completions zsh` print a script to stdout
- Completes commands, `--provider`, and `--tui`
- Unknown shell exits 2 with usage

### Try it

```bash
git clone --branch v0.1.18 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
eval "$(bun run raven completions bash)"
# or
eval "$(bun run raven completions zsh)"
```

## 0.1.17 — 2026-09-11

Scaffold project instructions.

### Added
- `raven init` writes `AGENTS.md` in the current directory when missing
- Does not overwrite an existing file

### Try it

```bash
git clone --branch v0.1.17 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
cd /path/to/your-project
bun run /path/to/RavenClaw/packages/cli/src/index.ts init
```

## 0.1.16 — 2026-09-11

Print resolved settings without leaking secrets.

### Added
- `raven config` shows home, provider, model, modes, MCP server names, and key presence
- API keys are `set (N chars)` or `unset`, never the value
- Works before `raven setup`

### Try it

```bash
git clone --branch v0.1.16 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven config
```

## 0.1.15 — 2026-09-11

Check the local install without printing secrets.

### Added
- `raven doctor` reports home, `.env`, `config.yaml`, `state.db`, and Bun
- Prints key name and length only, never the value
- Exit 1 if any check fails; missing `state.db` is ok

### Try it

```bash
git clone --branch v0.1.15 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven setup
bun run raven doctor
```

## 0.1.14 — 2026-09-11

Set a session title from the shell or the TUI.

### Added
- `raven title <id> <name>` updates the stored title (prefix ok)
- `/title <name>` in Ink and OpenTUI
- No API key required

### Try it

```bash
git clone --branch v0.1.14 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven title <id> Fix the login bug
bun run raven sessions
```

## 0.1.13 — 2026-09-11

Export a session as Markdown, and list times in ISO-8601.

### Added
- `raven export <id>` prints a Markdown transcript with full tool bodies
- Session lists (`sessions`, `show`, `/resume`) use ISO-8601 instead of unix milliseconds

### Try it

```bash
git clone --branch v0.1.13 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven export <id> > session.md
```

## 0.1.12 — 2026-09-11

Search saved sessions from the shell.

### Added
- `raven search <query>` runs FTS5 over this directory's sessions
- `--all` searches every session in the database
- No API key required; empty query exits 2 with usage

### Try it

```bash
git clone --branch v0.1.12 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven search pairing
bun run raven search --all persist
```

## 0.1.11 — 2026-09-11

Resume a saved session from the shell.

### Added
- `raven resume` with no id lists sessions (same as `raven sessions`)
- `raven resume <id>` opens that session in the TUI (prefix ok)
- `--tui opentui` works on resume
- Listing needs no key; opening a session does

### Try it

```bash
git clone --branch v0.1.11 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven resume
bun run raven resume <id>
```

## 0.1.10 — 2026-09-11

Delete a saved session from the shell.

### Added
- `raven rm <id>` deletes a session, its child Agent sessions, messages, and permission rules
- Accepts an id prefix; missing ids exit 1
- `SessionStore.deleteSession` on SQLite and memory stores
- No API key required

### Try it

```bash
git clone --branch v0.1.10 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven sessions
bun run raven rm <id>
```

## 0.1.9 — 2026-09-11

Print a saved session transcript from the shell.

### Added
- `raven show <id>` prints header + user/assistant/tool lines
- Accepts an id prefix; ambiguous prefixes error
- Tool output longer than 200 characters is clipped
- No API key required

### Try it

```bash
git clone --branch v0.1.9 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven sessions
bun run raven show <id>
```

## 0.1.8 — 2026-09-11

List sessions from the shell without a TUI or API key.

### Added
- `raven sessions` prints recent top-level sessions for this directory
- Child Agent sessions are omitted
- Empty home prints `no sessions` and exits 0

### Try it

```bash
git clone --branch v0.1.8 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven sessions
```

## 0.1.7 — 2026-09-11

One-command live turn check.

### Added
- `raven smoke` / `bun run smoke` asks the model for `pong`
- Without a key, prints the setup hint and exits 1
- CI does not run this

### Try it

```bash
git clone --branch v0.1.7 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven setup
bun run smoke
```

## 0.1.6 — 2026-09-11

CLI, MCP, and ACP versions come from each package.json.

### Changed
- `readPackageVersion(import.meta.url)` walks up to the nearest `package.json`
- `raven --version`, MCP `clientInfo`, and ACP `agentInfo` no longer hardcode 0.1.x

### Try it

```bash
git clone --branch v0.1.6 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven --version
```

## 0.1.5 — 2026-09-11

Read-only memory review can persist to the project.

### Added
- `forkMemoryReview` appends a dated section to `.ravenclaw/MEMORY.md` (8k cap)
- Does not run Edit / Write / Bash; empty or failed reviews do not write
- `/review` in Ink and OpenTUI

### Try it

```bash
git clone --branch v0.1.5 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
# after a session:
# /review
```

## 0.1.4 — 2026-09-11

First-run setup no longer echoes the API key.

### Added
- TTY `raven setup` / first-run uses raw mode and prints `*` per character
- Backspace and Ctrl-C on the secret prompt
- The key is never written back to the prompt stream

### Try it

```bash
git clone --branch v0.1.4 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven setup
```

## 0.1.3 — 2026-09-11

CI covers a real stdio MCP filesystem server, not just echo.

### Added
- In-repo `fs_list` / `fs_read` MCP fixture confined to `MCP_ROOT`
- Live spawn test: list, read, and reject `../` escape
- Shared Content-Length framing with the echo fixture

### Try it

```bash
git clone --branch v0.1.3 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun test packages/cli/src/mcp-fs-live.test.ts
```

## 0.1.2 — 2026-09-11

Editor ACP can resume a saved session.

### Added
- `session/load` on `raven acp` (`loadSession: true` when a loader is wired)
- Failed loads return JSON-RPC invalid params; missing loader stays method-not-found

### Try it

```bash
git clone --branch v0.1.2 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven acp
```

## 0.1.1 — 2026-09-11

CLI usability patch on top of 0.1.0. Same agent loop; easier to start without reading the README.

### Added
- `raven --help` / `--version` (`-h`, `-V`) without booting a session or needing a key
- `raven setup` and first-run prompt write `~/.ravenclaw/.env` (mode 0600)
- `/help` and `/?` inside Ink and OpenTUI list slash commands

### Try it

```bash
git clone --branch v0.1.1 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven --help
bun run raven setup
bun run raven
```

## 0.1.0 — 2026-09-11

First public release. RavenClaw is a local coding agent: it reads and edits a workspace, runs a shell, and resumes after a crash. Bring your own API key. There is no RavenClaw backend.

### Highlights

- Streaming agent loop that persists tool calls before they run, and never leaves an unpaired `tool_use`
- Permission modes: `default`, `acceptEdits`, `plan`, `dontAsk`
- Autocompact and SQLite WAL sessions (`/resume` after a crash does not re-run Bash)
- Built-in tools: Read, Grep, Glob, Edit, Write, Bash, Skill, Agent, plan mode
- Nested `Agent` plus `file-finder` and `command-runner` specialists
- Optional MCP stdio servers from `config.yaml` (builtin names win on collision)
- FTS5 `/search`, `USER.md` / `MEMORY.md` snapshots, Docker Bash backend
- Editor hook: `raven acp` (newline JSON-RPC)
- Ads only on admitted included-model sessions; BYOK never shows them

### Try it

```bash
git clone --branch v0.1.0 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
mkdir -p ~/.ravenclaw
printf 'ANTHROPIC_API_KEY=sk-ant-...\n' > ~/.ravenclaw/.env
chmod 600 ~/.ravenclaw/.env
bun run raven
```

Also: `bun run raven exec "…"`, `bun run raven --tui opentui`, `bun run raven acp`.

### Packages

`@ravenclaw/core`, `@ravenclaw/providers`, `@ravenclaw/ads`, `@ravenclaw/cli`, `@ravenclaw/tui-opentui`, `@ravenclaw/acp`

### Known limits

- First public tag is BYOK-only unless you run your own included-model gateway
- `--tui opentui` is a line-mode StreamEvent view, not a native OpenTUI widget tree
- This process is the same OS user as you; there is no network sandbox
- Live model paths are env-gated in CI; run `bun test` locally with a key to exercise them

Apache-2.0. See the [README](README.md) for config, permissions, and MCP.
