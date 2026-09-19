# Headless permissions (`raven exec`)

`raven exec` (and `serve` / cron fires) force `dontAsk`. Interactive `raven acp` defaults to `default` so the editor can answer leftover asks; pass `--dont-ask` for unattended ACP. That is **not** `bypass`. Leftover asks become denials. There is no yolo / auto-allow-all-Bash mode.

## What `dontAsk` allows

- Read-only tools (`Read`, `Grep`, `Glob`, `ListDir`, `ReadSubtree`, `Skill`, …)
- In-tree `Edit` / `Write` / `ApplyPatch` (path under the session cwd or an `--add-dir` root)
- Bash that `checkPermissions` already allows (clearly read-only commands such as `echo` / `ls`)
- Bash that a **project, user, or session allow rule** matches

## What `dontAsk` still denies

- Leftover mutating Bash (`bun test`, `curl | sh`, anything that still asks)
- Out-of-tree writes (symlink escapes, `../outside`)
- Leftover-ask `Fetch` and `AskUser` (network / host prompt — not auto-allowed just because they are read-only)
- Other leftover-ask mutators (`NotebookEdit`, `Agent`, plugins, …)

`--tools-preset ci` only **puts Bash in the tool pool**. It does not auto-allow commands. Seed a project rule:

```json
[{ "tool": "Bash", "spec": { "command": "bun test" }, "behavior": "allow" }]
```

Write that array to `.ravenclaw/permissions.json`. Prefix match: `bun test` also allows `bun test packages/core`.

## Recipe

```bash
# optional: restrict the pool (omit --allowed-tools to use the preset)
raven exec --dont-ask --tools-preset ci "run bun test"
```

`--tools-preset` is `read` | `write` | `ci` and fills `--allowed-tools` only when that flag is unset.

| Preset | Pool |
|---|---|
| `read` | Read, Grep, Glob, ListDir, ReadSubtree, Skill |
| `write` | read + Edit, Write, ApplyPatch, NotebookEdit |
| `ci` | write + Bash (still needs a project allow rule under `dontAsk`) |

`--allowed-tools Read,Grep` always wins if both flags are present.

## Optional Docker sandbox

The Docker terminal backend runs allowed Bash in a container (`-v cwd:cwd -w cwd`) and jails Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree to that same cwd bind. Grep/Glob still run on the host but refuse paths outside cwd. It is not a substitute for `dontAsk`.

```yaml
# ~/.ravenclaw/config.yaml
terminal:
  backend: docker
  image: bash:5
```

Use it when you want process isolation for the Bash that a project rule already allowed. It is not a substitute for `dontAsk` or for seeding `permissions.json`.

## Verify-on-stop (`--verify-on-stop`)

TUI sessions nudge (at most twice) if a turn edited files without a test/lint command. The loop does **not** run tests itself.

Headless `exec` and cron fires leave this **off** by default so CI is not surprised.

Opt in for a one-shot:

```bash
raven exec --verify-on-stop "implement the fix"
```

A cron job may set `verifyOnStop: true` in `~/.ravenclaw/cron/jobs.json` (or pass `--verify-on-stop` on `raven cron add`). The same nudge cap applies. Default for exec/cron remains false.

## Host delivery policy

Slack, Discord, and `raven serve` serialize inbound with `singleFlight` (`turnPolicy: queue`). They do not abort a live turn. The TUI queues composer input while busy; `/steer` aborts the live turn. Permission answers never steer.

## raven serve bind and token

`raven serve` exits 1 without `GATEWAY_SECRET` / `RAVEN_SERVE_SECRET`.
`--listen` must be loopback (`127.0.0.1`, `localhost`, `::1`).
`POST /v1/turn` requires `Authorization: Bearer <secret>` (`timingSafeEqual`).
It stays dontAsk, one-shot JSON. `?version=`, `?after=`, and `?continuationToken=` on `/v1/turn` are ignored.

Session routes use an engine that does **not** force `dontAsk`. All require the same Bearer token:

- `GET /v1/session/:id` — reconnect snapshot `{ id, title?, job?, jobAutoCommit, pendingAsks, lastSeq, permissionMode, live, lastEnd?, jobError?, queued, version: 1, continuationToken }`. 404 if unknown (does not create). `live` is true while a turn is in process. `jobAutoCommit` is always a boolean (`true` only when enabled). `queued` is the pending followup text or `null`. `lastEnd` / `jobError` appear when set on the session. `version` is the serve-wire protocol (`1`). `continuationToken` is an opaque tip handle for the same cursor as `lastSeq` (`base64url({ v:1, s, q })`, including `lastSeq === 0`). `?version=` fail-closes unknown/malformed values (400 `invalid version` / `unsupported stream version`) after Bearer and before session load. `?after=` / `?continuationToken=` on the snapshot are ignored (not 400).
- `GET /v1/session/:id/stream` — NDJSON `{ version: 1, seq } & StreamEvent`. Omit `after` and `continuationToken` for a live tail. `?after=<seq>` replays `seq > after` then tails. `after=0` replays from the start. `?continuationToken=` is the host-facing alias for the same cursor (`after=q`). Both resume keys on one request → 400 `resume conflict`. `?version=` uses the same fail-closed parser as the snapshot. Parse order: Bearer (401) → version / after / token (400) → session load (404). Closing the stream is detach, not cancel. There is no second event log; `payload_json` does not store `version`.
- `POST /v1/session/:id/submit` — `{ text }` → `submitMessage` with `turnPolicy: queue` (202 accepted; leftover-ask parks for `/resolve`). Missing sessions are created with `default` permission mode (not `dontAsk`).
- `POST /v1/session/:id/cancel` — optional `{ turnId }` from `round_start`. Calls `engine.abort('cancel')` when the live turn matches (or any live turn if `turnId` is omitted). Stale `turnId` or no live turn → **200** `{ ok: true, status: 'no_active_turn' }` (not an error) and does not touch leftover-asks. Live `abort('cancel')` abort-pairs **this** session’s leftover-asks (drop-only when already transcript-paired; unpaired persist one `ABORTED_TEXT` then drop). `abort('interrupt')` and child leftover-asks are unchanged. The stream emits `cancelled, ask still pending` only if a row remains. Cancel is not failure — the session accepts the next `submit`.
- `POST /v1/session/:id/compact` — `engine.compactNow()`
- `POST /v1/session/:id/resolve` — `{ callId, allow: boolean }` → live waiter or `applyAskAnswer`; 200 `{ status }` or 404 if unmatched
- `POST /v1/session/:id/pr` — optional `{ title, body }` → draft PR from the session shadow (default off; never a model turn). 200 `{ ok, notice, snapshot? }`. Missing job or dirty tree is a notice, not 5xx.
- `POST /v1/session/:id/followup` — `{ text }` → one-slot `setFollowup` (persist-then-assign); 200 `{ ok: true, queued }` or 400 if text is missing/empty. `DELETE …/followup` clears the same way; 200 `{ ok: true, queued: null }`. Does not call `submitMessage`. After a real persisted `lastEnd`, serve may auto-run the slot in-process (`runFollowupAfterSubmit`); owned leftover-asks skip. Not `/queue`, not `SuggestFollowups`.
- `POST /v1/session/:id/edit` — `{ text }` → `rewindLast()` then `submitMessage`. Empty text → 400. Rewind refuse → 200 `{ ok: false, notice, droppedText? }`. Success → **202** `{ accepted, sessionId, droppedText? }` then fire-and-forget submit (same follow-up epilogue as `/submit`). Last user turn only. Job rewind writes `pendingResetSha` after compact and before `git reset --hard`; the first later `submitMessage` / `rewindLast` / host `/diff` finishes a mid-crash reset. `createSessionEngine` stays sync. GET snapshot does not reset.
- `GET /v1/session/:id/diff` — finishes a pending job rewind reset first (`maybeFinishRewindReset`), then read-only job range: `baseCommitSha...HEAD` ∪ dirty via `jobDiff`. 200 `JobDiff` (`ok: true`, files with `create|update|delete|rename`) or `{ ok: false, notice }` (no job / git fail). Not a model turn.

There is no `POST /v1/session/:id/clear`. Keep-id wipe is `engine.clearKeepId()` (TUI `/clear` / `/new`). Same `session.id`. A later serve route must call that method; it must not mint a new id.

Crash-resolve: after process death, `POST …/resolve` → `applyAskAnswer` **pairs only** (writes the tool result row). It does not resume the model. The client must `POST …/submit` to continue. Live `/resolve` that hits an in-process waiter still unblocks that turn.

Webhooks verify `X-Raven-Signature` over the raw body.
Slack uses Socket Mode (app token); there is no Slack signing-secret HMAC.
Discord identity is Gateway `author.id` plus the pairing ledger.
Never trust a JSON `userId` / `principalId` the body claims.
