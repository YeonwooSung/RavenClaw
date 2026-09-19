# RavenClaw next-horizon roadmap (stream version / continuationToken)

Date: 2026-09-18  
Status: implemented  
Shipped on `main` at `c9c4871`. Combined waist with keep-id `/clear` and parent tree-stop is on `main` at `9901d0e`.  
Reviewed against tree at `be5a4a7` (`origin/main` after no-job todo revert).  
Successor to `2026-09-18-no-job-todo-revert.md` (Status: implemented at `be5a4a7`). Does not reopen that spec’s closed doors. Amends prior OUT for stream `version` / `continuationToken` **only**.

Implementation plan: [2026-09-18-stream-version-token.md](../plans/2026-09-18-stream-version-token.md).

Sources: current tree + [eve-analysis.md](../../research/eve-analysis.md) (read-only steal of contract: versioned NDJSON, unknown version fails, client cursor `{ sessionId, streamIndex }`, HTTP resume is a cursor not a second log). Eve’s HTTP API rejects `continuationToken` in the body and keeps channel tokens (`slack:channel:threadTs`) behind the channel boundary; its stream resume is `?startIndex=`. Do not copy eve source, event names, `meta.id` ULIDs, or protocol version 25.

Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework. Do not become a hosted Task runner. Do not add a web UI.

---

## Where we are

The waist is shipped: leftover-ask, session-as-job, job-host, persist-before-reset rewind, project `todo.json` projection, live cancel abort-pair, reset-on-resume, follow-up persist-first, no-job todo revert (`be5a4a7`).

Serve already reconnects on **one** event log:

- `GET /v1/session/:id/stream` NDJSON `{ seq } & StreamEvent`
- omit `after` = live tail; `?after=<seq>` replays `seq > after` then tails; `after=0` from start
- `GET /v1/session/:id` snapshot includes `lastSeq`
- `stream_events` table (schema v9; current schema is **v10**)
- Closing the stream is detach, not cancel
- No `?after=` on `/v1/turn`
- `StreamEvent` kinds are RavenClaw names (`permission_ask`, not eve `input.requested`)
- Replays of the same `permission_ask.callId` reuse the same `seq` (`appendStreamEventRow`)

A job host that drops TCP can already concatenate `?after=` without gaps. What it cannot do is **fail closed** when the wire is a future protocol, or resume with a host-facing handle that is not a raw integer the host must mint.

That was parked on the job-host horizon as eve leftover: unknown version fails; `continuationToken`. Job-host said “stream `version` / `continuationToken` 400”. Those two words are the only OUT this spec unparks.

This horizon **unparks only stream `version` / `continuationToken`**. It does not unpark keep-id `/clear`, cancel `202`/`200` polish, parent-tree-stop, schema v11, or async `createSessionEngine`.

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer for operator answers.
2. Default prefix stays small and frozen. No new always-on tool. Stream version and resume stay **serve-wire**, not tools and not engine ops.
3. `dontAsk` never becomes `bypass`.
4. BYOK is the product. Ads never touch BYOK.
5. Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
6. `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
7. Leftover-ask still wins rewind. Edit-resubmit stays host composition (`rewindLast` then `submitMessage`).
8. Cancel / detach stay as shipped: closing the stream is detach, not cancel. Live `abort('cancel')` abort-pairs this session’s leftover-asks. `abort('interrupt')` and child leftover-asks stay unchanged.
9. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent. Do not implement in this worktree as part of writing this spec.

---

## Do not build

- Web chat UI, Next.js BFF, Prisma Task, Socket.IO
- keep-id `/clear`
- Cancel `202` vs `200` envelope polish
- parent-tree-stop / parent-cancels-child-ask
- Schema version bump (no new column; v11 stays parked). A constant protocol version is not a sqlite version.
- A second event log, `stream_tokens` table, persisted resume rows, or a new seq space on reconnect
- Renaming `StreamEvent` kinds to eve names (`input.requested`, `turn.started`, …)
- A `stream_open` / hello `StreamEvent` kind
- Putting `version` on core `StreamEvent` / `SequencedStreamEvent`, hub `publish`, `stream_events.payload_json`, or `raven exec --json`
- HMAC / encrypted tokens, `X-Raven-Stream-Version`, `Accept` version negotiation
- `?after=` on `/v1/turn` (already forbidden; still forbidden)
- Reading `continuationToken` from any POST body
- Changing `appendStreamEvent` reuse of `permission_ask` seq
- Changing cancel, detach, `applyAskAnswer`, or `createSessionEngine` (stays sync)
- Default-on auto-commit / auto-PR

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

### Protocol version

1. **`STREAM_PROTOCOL_VERSION` is the integer constant `1`.** It is a serve-wire protocol number, not a per-session value, not a sqlite column, not the package semver, not eve’s 25. One process speaks one protocol. Do not store it on `SessionRecord`.
2. **Stamp `version: 1` on the GET snapshot and on every sequenced NDJSON frame.** Not snapshot-only. Not first-frame-only. There is no hello frame and no new `StreamEvent` kind. Serve adds the field at HTTP serialize time: `{ version: 1, ...sequencedEvent }`. Hub subscribers still receive `SequencedStreamEvent` without `version`. Idle live-tail with no events yet has no frame; a host that must fail closed before any event **GET**s the snapshot or passes `?version=`.
3. **Clients declare version with `?version=` on `GET /v1/session/:id` and `GET /v1/session/:id/stream`.** No header. Omit `?version=` means “I speak 1” (curl and today’s tests). Present `?version=` must be a non-negative safe integer matching `/^\d+$/` (same digit rule as `parseAfterParam`).
4. **Unknown / missing-when-required / future version is 400. Do not silently ignore.**
   - `?version=` present and not `/^\d+$/` or not a safe integer → **400** `{ error: 'invalid version' }`
   - `?version=` present and integer `!== 1` (including `0`, `2`, `25`) → **400** `{ error: 'unsupported stream version' }`
   - `continuationToken` decodes but `v` is a number `!== 1` → **400** `{ error: 'unsupported stream version' }`
   - `continuationToken` decodes but `v` is missing or not a number → **400** `{ error: 'invalid continuationToken' }` (`v` is required inside a token)
   - Server responses never omit `version`. A later protocol 2 is a new spec; this horizon 400s it.
5. **Parse protocol queries after Bearer and before session load.** Unauthenticated → **401** `{ error: 'unauthorized' }` even if `version=2`. Bad version / after / token → **400** even if the session id is unknown (do not 404 a protocol error). Then `loadSession` → **404** `{ error: 'not found' }` as today.
6. **`POST /v1/turn` ignores `?version=`, `?after=`, and `?continuationToken=`.** It stays dontAsk one-shot JSON. `GET /health` has no version. Other POST routes do not grow resume or version queries.

### Resume handle

7. **One log, two aliases, one handle per request.** The durable cursor is still `stream_events.seq`. `?after=<seq>` stays the curl query (same semantics as today). `?continuationToken=` is the host-facing alias for the same cursor. Do not create a second event log. Do not accept resume on any path except `GET /v1/session/:id/stream`.
8. **`continuationToken` is opaque to hosts.** Serve encodes and decodes. Hosts treat the string as a blob; they must not parse JSON or split on `.`. Encoding is **not** HMAC and **not** a secret (loopback + Bearer already auth). v=1 encoding is frozen:
   ```
   base64url(JSON.stringify({ v: 1, s: sessionId, q: lastSeq }))
   ```
   UTF-8 JSON object. Encoder may omit padding; decoder accepts padded or unpadded base64url. Extra JSON keys are ignored (forward compat under `v: 1` only). `v` must be the number `1`. `s` must be a non-empty string. `q` must be a number that is a non-negative safe integer (not a string).
9. **Token session must match the path.** Decode then require `s === :id`. Mismatch → **400** `{ error: 'invalid continuationToken' }` (same string as garbage; do not advertise cross-session). Opening `/stream` with a token does not create a session.
10. **Token resume equals `after=q`.** Omit both `after` and `continuationToken` → live tail (today). Token `{ q: 0 }` → same as `after=0` (replay from start, then tail). Token `{ q: N }` → replay `seq > N`, then tail. `q` greater than the session tip → empty replay, then tail (same as a large `after`; not 400). Reconnect **must not** call `appendStreamEvent` / `publish` except the existing `publishParkedAsks` path, which still reuses `permission_ask` seq.
11. **Both resume query params present → 400.** If the request URL has both `after` and `continuationToken` (keys present, including empty values) → **400** `{ error: 'resume conflict' }`, before decode. One handle per request. Curl uses `after`. Hosts use the token from the last snapshot (or last frame’s `seq` re-encoded by serve — hosts should prefer the snapshot field).
12. **GET snapshot does not resume.** `?after=` and `?continuationToken=` on `GET /v1/session/:id` are ignored (not a replay, not 400). `?version=` on snapshot is honored (ruling 3–4) so a host can fail closed before opening the stream.
13. **Never read `continuationToken` from a POST body.** Extra JSON keys on `/submit`, `/turn`, `/edit`, `/followup`, `/cancel`, `/resolve`, `/pr` stay ignored. Steal eve’s “channel token stays off the session command body” without adding a new submit 400.

### Snapshot, frames, seq

14. **GET snapshot adds `version` and `continuationToken`.** Shape becomes  
    `{ id, title?, job?, jobAutoCommit, pendingAsks, lastSeq, permissionMode, live, lastEnd?, jobError?, queued, version: 1, continuationToken }`.  
    `continuationToken` is always a string, including `lastSeq === 0` (encodes `{ v: 1, s: id, q: 0 }`). It is the current tip. Existing optional fields keep today’s presence rules.
15. **Every 200 NDJSON line from `GET …/stream` includes `version: 1` and the existing `seq` + `StreamEvent` fields.** Replay lines and live lines. Tests that today expect `{ seq, type, … }` must expect `version: 1` after V1. `content-type` stays `application/x-ndjson`.
16. **Replays of the same fact keep the same seq.** Already law. Token / version / reconnect must not allocate a new seq space, must not rewrite `payload_json`, must not bump schema. `permission_ask` with the same `callId` still returns the existing seq and does not insert a second row.
17. **No rename of `StreamEvent` kinds.** No web UI. No Socket.IO second loop. Core `StreamEvent` / `SequencedStreamEvent` stay as in `packages/core/src/types.ts` at `be5a4a7`.
18. **This spec amends earlier OUT rulings** for stream `version` / `continuationToken` only: `2026-09-17-job-host-state-roadmap.md` Do-not-build “stream `version` / `continuationToken` 400”, `2026-09-18-rewind-persist-and-todo-projection.md`, `2026-09-18-cancel-reset-followup.md`, and `2026-09-18-no-job-todo-revert.md` Do-not-build / Out-of-horizon bullets. Other parked doors stay closed.

### Enumerated 400s (stream + snapshot version)

All are `Content-Type: application/json` with `{ error: string }`. No other status for these cases (not 409, not 422, not 426).

| Request | Status | `error` |
|---|---|---|
| `?after=` present and not `/^\d+$/` or not a safe integer (`''`, `-1`, `foo`, `1.5`) | 400 | `invalid after` (already shipped) |
| `?version=` present and not `/^\d+$/` or not a safe integer | 400 | `invalid version` |
| `?version=` present and integer `!== 1` | 400 | `unsupported stream version` |
| `after` and `continuationToken` both present on `/stream` | 400 | `resume conflict` |
| `?continuationToken=` not valid base64url, not a JSON object, missing/empty `s`, `q` not a non-negative safe integer number | 400 | `invalid continuationToken` |
| token `s !== :id` | 400 | `invalid continuationToken` |
| token `v` missing or not a number | 400 | `invalid continuationToken` |
| token `v` is a number `!== 1` | 400 | `unsupported stream version` |
| no Bearer | 401 | `unauthorized` (unchanged; wins before 400) |

Not 400: omit `?version=`; omit both resume params (live tail); `after=0`; token `q` past the tip; `?after=` / `?continuationToken=` on GET snapshot (ignored); extra keys on POST bodies.

---

## Per-slice board

Board as of `c9c4871` on `main`. Combined waist `9901d0e`. Pre-ship “not on `main`” wording is historical.

| ID | Status vs tree |
|---|---|
| V0.1 docs point at this spec | **done** |
| V1.1 constant + `?version=` parse + snapshot `version` | **done** |
| V1.2 every stream frame stamped; version 400 matrix | **done** |
| V2.1 encode / decode `continuationToken` | **done** |
| V2.2 snapshot `continuationToken` at tip | **done** |
| V2.3 stream `?continuationToken=` alias + 400 matrix | **done** |
| V2.4 no second log; seq reuse on reconnect | **done** |
| V3.1 serve tests lock the wire | **done** |

---

## Waves

```
Wave V0  docs pointer
Wave V1  protocol version              (independent of V2 encode tests)
Wave V2  continuationToken             (needs V1 stamp + parse)
Wave V3  serve test lock
```

V1.1 before V1.2 (parse + snapshot field first). V2.1 before V2.2 / V2.3. Do not parallel V2.3 and V2.4 — same `/stream` handler. V3 last.

---

## Wave V0 — Docs point here

### V0.1 Pointers

**Why.** ARCHITECTURE / headless / remaining-roadmap / job-host and later specs still list stream `version` / `continuationToken` as OUT, or describe the stream as `{ seq } & StreamEvent` only.

**Contract.**

- Mark this file as the next horizon from `2026-09-18-no-job-todo-revert.md`, `2026-09-17-job-host-state-roadmap.md` (the parked “stream version / continuationToken 400” bullet becomes “amended by this spec”), `2026-09-12-ravenclaw-remaining-roadmap.md`, `ARCHITECTURE.md` / `.ko.md`, `docs/headless.md`.
- Historical OUT lines stay; add a one-line amendment at the top / Do-not-build bullet. Do not rewrite shipped wave text.
- Do not claim the wire already has `version` or `continuationToken` until V1/V2 land.

**Done when.** Those files link here. The hole is no longer described as permanently parked.

---

## Wave V1 — Protocol version

Goal: a reconnect client can refuse an unknown protocol. Serve never silently accepts `version=2`.

### V1.1 Constant, parse, snapshot field

**Why.** Eve clients fail unknown stream contract versions. RavenClaw snapshot at `be5a4a7` has `lastSeq` and no `version`.

**Contract.**

```ts
export const STREAM_PROTOCOL_VERSION = 1 as const

export function parseVersionParam(
  raw: string | null,
): { ok: true; version?: number } | { ok: false; error: 'invalid version' | 'unsupported stream version' }
```

- Export the constant from `packages/cli/src/serve.ts` or a serve-local helper (`packages/cli/src/serve-stream-protocol.ts`). Do not add it to `packages/core/src/types.ts`.
- `parseVersionParam(null)` → `{ ok: true }` (omit = speak 1).
- `parseVersionParam` uses the same `/^\d+$/` + `Number.isSafeInteger` rule as `parseAfterParam`. Bad digits → `invalid version`. Digit string whose number `!== 1` → `unsupported stream version`.
- `GET /v1/session/:id` JSON includes `version: 1` on every 200. 401/404 unchanged.
- `GET /v1/session/:id?version=2` → 400 `{ error: 'unsupported stream version' }` without creating a session.

**Files.** `packages/cli/src/serve.ts`, optional `packages/cli/src/serve-stream-protocol.ts`, `serve.test.ts` (and a helper test file if extracted).

**Done when.** Snapshot 200 has `version === 1`. `?version=2` on snapshot is 400. Core `StreamEvent` type is unchanged.

### V1.2 Stamp every stream frame

**Contract.**

- `GET /v1/session/:id/stream` `write()` serializes `{ version: STREAM_PROTOCOL_VERSION, ...event }`. Replay and live. No hello line. No persist of `version`.
- `?version=` on `/stream` uses the same parser as V1.1. 400 body strings are exactly `invalid version` / `unsupported stream version`.
- Parse `version` (and later token/after) after Bearer, before `loadSession`.
- Existing `?after=` semantics unchanged. `POST /v1/turn?version=2` still 200 JSON (ignored).
- Update existing serve stream tests to expect `version: 1` on each line.

**Files.** `packages/cli/src/serve.ts`, `serve.test.ts`.

**Done when.** Live tail, `after=0`, and `after=N` lines all carry `version: 1`. `?version=foo` and `?version=25` are 400 before 404. `stream_events.payload_json` still has no `version` key.

---

## Wave V2 — continuationToken

Goal: a host resumes with an opaque handle that serve already understands as `after=lastSeq`. No second log.

### V2.1 Encode / decode

**Why.** Eve’s HTTP resume is a cursor (`startIndex`), not a second stream. Channel `continuationToken` stays off the HTTP body. RavenClaw’s host-facing name is `continuationToken`; the value is our cursor, not eve’s `slack:channel:threadTs`.

**Contract.**

```ts
export type ContinuationCursor = {
  version: typeof STREAM_PROTOCOL_VERSION
  sessionId: string
  lastSeq: number
}

export function encodeContinuationToken(
  cursor: { sessionId: string; lastSeq: number },
): string

export function decodeContinuationToken(
  raw: string,
):
  | { ok: true; cursor: ContinuationCursor }
  | { ok: false; error: 'invalid continuationToken' | 'unsupported stream version' }
```

- `encodeContinuationToken` writes exactly `{ v: 1, s, q }` then base64url. `lastSeq` must be a non-negative safe integer (throw or refuse in unit tests if the caller passes garbage; serve only encodes `lastSeq` from `lastStreamSeq` / `0`).
- `decodeContinuationToken` maps ruling 8–9 failures to the two error strings above. Round-trip: decode(encode({ sessionId, lastSeq })) equals `{ version: 1, sessionId, lastSeq }`.
- Unit tests: bad base64, JSON array, `{ v: 1 }` missing `s`/`q`, `q: "3"`, `v: "1"`, `v: 2`, empty `s`.

**Files.** serve-local helper + its test (preferred) or `serve.ts` + `serve.test.ts`.

**Done when.** Those cases are pinned. No sqlite write.

### V2.2 Snapshot token

**Contract.** After computing today’s `lastSeq`, set `continuationToken: encodeContinuationToken({ sessionId, lastSeq })`. Always present on 200. `lastSeq === 0` still emits a token. Do not persist the string.

**Files.** `packages/cli/src/serve.ts`, `serve.test.ts`.

**Done when.** GET snapshot after two published events has `lastSeq === 2` and a token that decodes to `{ version: 1, sessionId, lastSeq: 2 }`.

### V2.3 Stream alias and 400s

**Contract.**

```
parse Bearer
parse ?version=          → 400 invalid / unsupported
if after key AND continuationToken key present → 400 resume conflict
parse ?after=            → 400 invalid after (existing)
parse ?continuationToken= → 400 invalid / unsupported
  require cursor.sessionId === :id else 400 invalid continuationToken
  effectiveAfter = cursor.lastSeq
loadSession              → 404
replay seq > effectiveAfter then tail   (same buffer-during-replay code as today)
```

- `?continuationToken=` of a snapshot taken at seq 3 concatenates like `?after=3`.
- Empty `?continuationToken=` → 400 `invalid continuationToken`.
- Token for another session id → 400 `invalid continuationToken`.
- `GET /v1/session/:id?continuationToken=…` still 200 snapshot (ignored; ruling 12).

**Files.** `packages/cli/src/serve.ts`, `serve.test.ts`.

**Done when.** Token resume concatenates without gaps or dupes. The 400 table rows that mention `continuationToken` are green.

### V2.4 No second log

**Contract.**

- Opening `/stream` with a token does not increment `lastSeq` by itself.
- Republish of the same `permission_ask` during `publishParkedAsks` still returns the original seq (existing `ask_call_id` lookup).
- No new migration. Schema stays **v10**. `009_stream_events.sql` unchanged.
- `POST /v1/turn` with `continuationToken` in the JSON body still runs the turn (ignored). Query `?continuationToken=` on `/v1/turn` ignored.

**Files.** `packages/cli/src/serve.ts`, `serve.test.ts`. Do not touch `packages/core/src/migrations/` or `stream-events.ts` unless a test proves a persist bug already on `main` (out of scope; do not “fix” by adding a column).

**Done when.** lastSeq before and after a token reconnect (no new publish) is equal. Same `callId` still one seq.

---

## Wave V3 — Serve test lock

### V3.1 Wire tests

**Contract.** Targeted `bun test ./packages/cli/src/serve.test.ts` (plus the helper test file if V2.1 extracted one). No new eval fixture (engine is unchanged). Pin at least:

| Case | Assert |
|---|---|
| snapshot fields | 200 has `version === 1` and a decodable tip token |
| frame stamp | every NDJSON line from live / `after=0` / token resume has `version === 1` |
| version 400 | `?version=` `''`, `foo`, `1.5`, `-1` → 400 `invalid version`; `0`, `2`, `25` → 400 `unsupported stream version` |
| token 400 | garbage, other session, `v: 2` → the locked `error` strings |
| resume conflict | `?after=1&continuationToken=…` → 400 `resume conflict` |
| concat | second stream with snapshot token equals `?after=lastSeq`; concat has unique seq 1…N |
| no alloc | token reconnect does not bump `lastSeq` until a new `publish` |
| turn ignore | `POST /v1/turn?after=0&version=2` still 200 JSON |

Existing after / detach / cancel / snapshot field tests stay green (with `version` added to stream fixtures).

**Done when.** That command fails if any 400 string, token opacity (hosts need not parse — serve decode is the only reader under test), or seq-reuse contract regresses.

---

## Out of this horizon

Web chat UI, Next.js BFF, Prisma Task, Socket.IO, y0 Shadow wiki / indexer, eve compiler, OpenAPI connections, memory slots, `defineState`, credential brokering, self-mod, any new chat network, sandbox network policy, Grep/Glob docker-exec, `ignored`, keep-id `/clear`, cancel `202`/`200` polish, parent-tree-stop, parent-cancels-child-ask, interrupt abort-pair, schema v11, async `createSessionEngine`, no-job git checkpoint, `fileHistory` todo frames, eve event-name aliases, HMAC tokens.

If a later product wants protocol 2, it is a new spec that may accept `?version=1` and `?version=2` or 400 the old one. It still must not invent a second event log. Schema v11 still needs a column this horizon does not have.

---

## Suggested order

1. **V0.1** with the spec file.
2. **V1.1** then **V1.2**.
3. **V2.1** then **V2.2** then **V2.3 + V2.4**.
4. **V3.1** last.

---

## Success checks

A slice that does not move one of these is out of scope.

1. GET snapshot 200 includes `version: 1` and a tip `continuationToken` (V1.1, V2.2).
2. Every `/stream` NDJSON line includes `version: 1`; `payload_json` does not (V1.2).
3. Unknown / malformed / future `?version=` is 400 with the locked body; omit still works (V1).
4. `?continuationToken=` resumes the same `seq > q` window as `?after=q` with no gaps or dupes (V2.3).
5. Malformed token, other-session token, and both handles at once are 400 with the locked bodies (V2.3).
6. Reconnect does not allocate a new seq space; same `permission_ask` keeps its seq (V2.4).
7. Schema stays v10. Core `StreamEvent` kinds unchanged. `/v1/turn` still ignores resume/version queries (V2.4, V3).
8. Serve tests fail if 3, 4, 5, or 6 regress (V3).

---

## Key decisions

1. **Theme is fail-closed reconnect on the existing serve log, not a new stream.** Hosts still GET snapshot + GET `/stream`. No new route.
2. **`version` is a process-wide constant, so there is no v11.** Stamping at serialize time is enough. A per-session column would imply mixed-protocol rows this tree does not have.
3. **Every frame carries `version`, not only the first.** A live-tail client that skips snapshot still sees the protocol on the first event. A hello kind would be a new `StreamEvent` and a fake first seq. Idle tail without events uses snapshot or `?version=`.
4. **`?after=` stays; `continuationToken` is the opaque alias.** Eve’s HTTP cursor is `startIndex`; its body `continuationToken` is a channel identity we do not copy. We steal fail-closed version + “one cursor, not a second log,” and we steal “do not read a continuation token from POST bodies.”
5. **Opacity is “hosts do not parse,” not cryptography.** Loopback + Bearer is the authn. Frozen `base64url({ v, s, q })` is enough to 400 a foreign or future token.
6. **Both handles on one request 400 even when they agree.** One resume handle per request. No silent precedence.
7. **This spec amends earlier OUT rulings** for stream `version` / `continuationToken` only. Other parked doors stay closed.
