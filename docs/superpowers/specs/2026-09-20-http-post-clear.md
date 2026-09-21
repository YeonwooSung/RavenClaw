# RavenClaw next-horizon roadmap (HTTP `POST /v1/session/:id/clear`)

Date: 2026-09-20  
Status: implemented  
Shipped sha: `a53be93` on `main`.  
Reviewed against tree at `a707249` (`origin/main`).  
Successor to `2026-09-18-keep-id-clear.md` (Status: implemented at `edeb611`). Amends prior OUT for `POST /v1/session/:id/clear` **only**. Does not reopen that spec’s wipe/keep table, mid-turn abort-then-wipe, or child leftover refuse.

Implementation plan: [2026-09-20-http-post-clear.md](../plans/2026-09-20-http-post-clear.md). Isolated worktree only.

Sources: current tree. Steal contracts. No copy of eve, y0, Claude, Hermes, or Freebuff source.

Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework. Do not become a hosted Task runner. Do not add a web UI.

---

## Where we are

Keep-id `/clear` is shipped on `main` at `edeb611`. Combined waist with stream version/token and parent tree-stop is on `main` at `9901d0e`. Tree at write is `a707249`.

`SessionEngine.clearKeepId()` is the composition. TUI Ink and OpenTUI already `await engine.clearKeepId()`. Persist-first wipe, same `session.id`, mid-turn `abort('cancel')` then idle then wipe, unpaired child leftover-ask refuse (`pending permission ask`), persist-fail (`clear persist failed`) are engine law. Schema stays **v10**.

There is still no HTTP route. At `a707249`:

- `SESSION_PATH` in `packages/cli/src/serve.ts` is `/^\/v1\/session\/([^/]+)\/(stream|cancel|compact|resolve|submit|pr|followup|edit|diff)$/` — no `clear`.
- `ServeEngine` has `abort` / `whenTreeStop` / `compactNow` / `applyAskAnswer` and does **not** require `clearKeepId`.
- `runServe` help prints `POST /v1/session/:id/submit|/cancel|/compact|/resolve`.
- `docs/headless.md` and `ARCHITECTURE.md` / `.ko.md` say there is no `POST /v1/session/:id/clear`.
- Keep-id spec ruling 12 forbade adding the route that horizon: “The engine method is the host composition so serve can call it in a later door.”

This horizon **unparks only HTTP `POST /v1/session/:id/clear`**. Serve calls `engine.clearKeepId()` and returns the engine `{ ok, notice }`. It does not reimplement wipe. It does not mint.

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer for operator answers. Clear is not a model turn and must not call `applyAskAnswer`.
2. Default prefix stays small and frozen. No new always-on tool. HTTP clear is a **serve-wire session op**, not a tool and not a new engine method.
3. `dontAsk` never becomes `bypass`.
4. BYOK is the product. Ads never touch BYOK. Included resume stays fail-closed. This route must not call `openNewSession` / `resolveIncludedAccess({ consumeCap: true })`.
5. Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
6. `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
7. Leftover-ask still wins rewind. Parent-tree-stop stays on `/cancel`. This door does not abort, close, or abort-pair children. Child unpaired leftover-ask refuse stays inside `clearKeepId`.
8. Persist-first stays engine law. Serve awaits the result and does not advertise empty UI of its own.
9. No schema bump. v10 stays. Do not edit `packages/core/src/loop/session-engine.ts`.
10. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent. Do not implement in this worktree as part of writing this spec.

---

## Do not build

- Web chat UI, Next.js BFF, Prisma Task, Socket.IO
- Reimplementing wipe in serve (`recordCompact`, `clearConversation`, `deleteSession`, message `DELETE`)
- Calling `openNewSession` / `close` / `mcpCloser` / `deleteSession` / `createSession` on this path
- ACP `session/new` clear, Slack/Discord/exec HTTP twins, TUI changes (TUI already calls `clearKeepId`)
- Changing the keep-id wipe/keep table
- Changing `clearKeepId` order, notices, or child leftover refuse
- `singleFlight` on `/clear`
- `abortCachedDescendants` / `whenTreeStop` on `/clear` (those stay `/cancel`)
- Fire-and-forget **202**, empty **204**, or mapping persist-fail / `pending permission ask` / `session closed` to 4xx/5xx
- Missing-session mint (submit’s `createSession` path is not this route)
- Schema v11, async `createSessionEngine`, compact-then-die, cancel-without-live, interrupt abort-pair, cancel `202`/`200` polish
- Hard-delete of message rows, deleting `raven/*` worktrees, changing `openNewSession`
- Default-on auto-commit / auto-PR

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

### Route and auth

1. **Route is `POST /v1/session/:id/clear`.** Add `clear` to `SESSION_PATH`. Same Bearer as other session routes (`requireBearer`). Unauthenticated → **401** `{ error: 'unauthorized' }` (existing `unauthorized()`). GET / PUT / DELETE on this path stay **404** `{ error: 'not found' }` (fall through the existing session-route 404).
2. **Same `loadSessionRuntime` attach as cancel/compact/submit.** Unknown id → **404** `{ error: 'not found' }`. Lock → **409** via existing `sessionOpenErrorResponse`. Other resume errors → existing 500. Do **not** call `ctx.createSession`. Do not invent a missing-session mint.
3. **`ServeEngine.clearKeepId` is required.**

```ts
clearKeepId(): Promise<{ ok: true; notice: string } | { ok: false; notice: string }>
```

Production `CliRuntime.engine` already forwards it (`packages/cli/src/engine.ts`). Serve must type it on `ServeEngine` so the handler cannot compile without the method. Do not add a second engine method. Do not edit `session-engine.ts`.

### Envelope (locked)

4. **Success is HTTP 200 `{ ok: true, notice: 'session cleared' }`.** That is the engine happy-path string. Empty body is not 204. Clear is not a model turn; do not return 202.
5. **Engine `{ ok: false, notice }` is also HTTP 200 `{ ok: false, notice }`.** Pass the engine notice through as-is: `clear persist failed`, `pending permission ask`, `session closed`, and any later engine string. Do **not** map those to 4xx/5xx. HTTP 200 for both `ok: true` and `ok: false` matches rewind/diff/pr.
6. **Serve echoes the engine result verbatim.** `return Response.json({ ok: result.ok, notice: result.notice })`. Do not rewrite, drop, or default `notice`. If the engine returns `{ ok: true, notice: 'session cleared; todo.json write failed: <detail>' }`, that string is the HTTP notice (`ok` stays true). Tests lock the happy path as `{ ok: true, notice: 'session cleared' }`.
7. **Enumerated statuses for this route:**

| Request | Status | Body |
|---|---|---|
| no Bearer | 401 | `{ error: 'unauthorized' }` |
| unknown session (`runtimeForSession` undefined / `PersistError` not found) | 404 | `{ error: 'not found' }` |
| session lock | 409 | existing `sessionOpenErrorResponse` |
| other resume error | 500 | existing |
| body present and `JSON.parse` throws | 400 | `{ error: 'invalid json' }` |
| GET / other method on `/clear` | 404 | `{ error: 'not found' }` |
| `clearKeepId` `{ ok: true, notice }` | **200** | `{ ok: true, notice }` |
| `clearKeepId` `{ ok: false, notice }` | **200** | `{ ok: false, notice }` |

Not 204. Not 202. Not 422. Not 409 for persist-fail. Not 409 for leftover-ask.

### Body and queries

8. **No query params required. Extra queries ignored** (`?version=`, `?after=`, `?continuationToken=`, `?turnId=`). Not 400. `/clear` is not a stream resume and not cancel.
9. **No JSON body required.** Empty body and whitespace-only body are OK (same empty-body rule as cancel/pr: `req.text()`, `raw.trim() === ''` skips parse).
10. **`JSON.parse` throw → 400 `{ error: 'invalid json' }`.** Same string as cancel. Parsed JSON is **ignored** (including `{}`, `{ turnId }`, `{ text }`, arrays, `null`). Do not use `readJsonBody` (that 400s empty bodies). Parse after Bearer and after `loadSessionRuntime` (unknown session with garbage body is 404, same as cancel).

### Composition (serve does not wipe)

11. **Engine method is already the composition.** Handler is:

```
requireBearer → 401
loadSessionRuntime → 404/409/500
empty body OK; else JSON.parse → 400 invalid json; parsed value discarded
await engine.clearKeepId()
200 { ok, notice }
```

Do not call `store.clearConversation`. Do not call `openNewSession`, `close`, `mcpCloser`, `deleteSession`, `createSession`. Do not `abort('cancel')` from serve — `clearKeepId` already does that when `liveTurn !== null`.

12. **Do not `singleFlight` `/clear`.** Compact queues behind a live turn. Submit fire-and-forgets through `turnFlights`. Clear must not wait on `turnFlights`: `clearKeepId` aborts then wipes. Wrapping it in `singleFlight(ctx.turnFlights, id, …)` would wait for the live submit to finish without aborting. Do not add a second flights map.

13. **Do not `abortCachedDescendants` / `whenTreeStop` on `/clear`.** Those stay `/cancel` (parent-tree-stop). Keep-id refuses unpaired **child** leftover-asks before abort and leaves child rows. Serve must not tree-stop on this path. Child leftover refuse is **200** `{ ok: false, notice: 'pending permission ask' }`.

14. **Mid-turn: await `clearKeepId`, not 202.** `clearKeepId` is already async: abort `'cancel'`, wait until `liveTurn === null`, then wipe or refuse. The HTTP response is that result. Do not fire-and-forget. A second concurrent `/clear` is serialized inside the engine (`clearTail`); serve may await both.

15. **Leftover-ask closer stays `/resolve`.** Clear must not `applyAskAnswer` / `settleAsk`. This-session parked asks are dropped by the wipe. Child unpaired leftover-asks refuse. File overlap with leftover-ask is `packages/cli/src/serve.ts` only (`SESSION_PATH`, `requireBearer`, `loadSessionRuntime`). Do not edit `/resolve`.

### Hosts and schema

16. **Do not add ACP/Slack/Discord/exec routes.** Those stay on current mint/resume. TUI already calls `clearKeepId` in-process.
17. **No schema bump. No new engine method.** v10 stays. `createSessionEngine` stays sync. If `loadSessionRuntime` still uses the sync factory, this door does not change that.
18. **This spec amends earlier OUT rulings for `POST /v1/session/:id/clear` only:** `2026-09-18-keep-id-clear.md` ruling 12 / Do-not-build / Out “`POST /v1/session/:id/clear`”, and the same bullet on keep-id plan Global Constraints, `docs/headless.md` “There is no `POST /v1/session/:id/clear`”, `ARCHITECTURE.md` / `.ko.md` “There is no `POST /v1/session/:id/clear` this horizon”. Other parked doors stay closed.

---

## Per-slice board

Board as of `a53be93` on `main`. C0–C2 done.

| ID | Status vs tree |
|---|---|
| C0.1 docs point at this spec | **this file** (spec commit). Other-file amendments are C2. |
| C1.1 `SESSION_PATH` + `ServeEngine.clearKeepId` + POST handler | **done** |
| C1.2 `serve.test.ts` wire lock | **done** |
| C2.1 help printer + headless + ARCHITECTURE + keep-id OUT | **done** |

---

## Waves

```
Wave C0  docs pointer              (this spec; other files in C2)
Wave C1  route + tests             (TDD; one handler)
Wave C2  help / ARCHITECTURE / OUT
```

C1.1 and C1.2 are one TDD cycle (failing tests, then handler). Do not parallel C1 with a second serve handler. C2 after C1 is green. Do not implement production code as part of writing this spec.

---

## Wave C0 — Docs point here

### C0.1 Pointers

**Why.** Keep-id ruling 12, `docs/headless.md`, and `ARCHITECTURE.md` / `.ko.md` still forbid or omit `POST /v1/session/:id/clear`. Remaining-roadmap successor line still ends at parent tree-stop.

**Contract.**

- This file is the next horizon from `2026-09-18-keep-id-clear.md`. Historical OUT lines stay; C2 adds a one-line amendment (`amended by 2026-09-20-http-post-clear.md`) at the keep-id Do-not-build / Out-of-horizon `POST /v1/session/:id/clear` bullets. Do not rewrite shipped K-wave text. Do not reopen the wipe/keep table.
- `docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md`: successor pointer only. Do not rewrite shipped wave text.
- Do not claim the route exists until C1 lands.

**Done when.** This spec exists. C2 links the other files here.

---

## Wave C1 — Route and tests

Goal: a reconnect host can `POST /v1/session/:id/clear` and get the engine `{ ok, notice }` on HTTP 200. Same id. No mint. No wipe reimplementation.

### C1.1 `SESSION_PATH`, type, handler

**Why.** Keep-id shipped the engine so serve could call it. `SESSION_PATH` does not match `/clear`. `ServeEngine` does not require the method.

**Contract.**

```ts
const SESSION_PATH =
  /^\/v1\/session\/([^/]+)\/(stream|cancel|compact|resolve|submit|pr|followup|edit|diff|clear)$/

export type ServeEngine = {
  // existing fields…
  clearKeepId: () => Promise<{ ok: true; notice: string } | { ok: false; notice: string }>
  // existing fields…
}
```

Handler (only `POST` + `action === 'clear'`):

```
if (!requireBearer) return unauthorized()          // already done for the sessionRoute
loaded = await loadSessionRuntime(ctx, sessionId)
if (!loaded.ok) return loaded.res
raw = await req.text()
if (raw.trim() !== '') {
  try { JSON.parse(raw) } catch { return 400 { error: 'invalid json' } }
  // parsed value ignored
}
result = await loaded.runtime.engine.clearKeepId()
return Response.json({ ok: result.ok, notice: result.notice })   // 200
```

- Do not `singleFlight`. Do not `abortCachedDescendants`. Do not `whenTreeStop`. Do not `ctx.createSession`.
- Do not call `openNewSession` / `close` / `mcpCloser` / `deleteSession` / `createSession` / `applyAskAnswer`.
- `makeServeCtx` and `stubRuntime` in `serve.test.ts` must stub `clearKeepId` once the type requires it.

**Files.** `packages/cli/src/serve.ts`, `packages/cli/src/serve.test.ts` (`makeServeCtx`, `stubRuntime`).

**Done when.** `POST /v1/session/s1/clear` with Bearer hits `engine.clearKeepId` and returns 200 `{ ok, notice }`. Unknown id is 404. `SESSION_PATH` without `clear` no longer matches.

### C1.2 Wire tests

**Contract.** Targeted `bun test ./packages/cli/src/serve.test.ts`. Pin at least:

| Case | Assert |
|---|---|
| success wipe, same id | 200 `{ ok: true, notice: 'session cleared' }`; `engine.session.id` unchanged; stub/store transcript empty (`loadMessages` `[]` or `lastStreamSeq === 0` and this-session asks gone); `createSession` not called |
| persist fail | stub `{ ok: false, notice: 'clear persist failed' }` → **200** same JSON; not 4xx/5xx |
| child unpaired leftover | stub `{ ok: false, notice: 'pending permission ask' }` → **200** same JSON; `abortCalls === 0`; cached child runtime not aborted |
| missing Bearer | 401 `{ error: 'unauthorized' }` |
| invalid JSON body | `POST` with body `{` → 400 `{ error: 'invalid json' }` |
| empty body | 200 via `clearKeepId` (no 400) |
| parsed JSON ignored | body `{ turnId: 'x', text: 'nope' }` still calls `clearKeepId` once and 200s the engine result |
| unknown session | `runtimeForSession` undefined → 404 `{ error: 'not found' }`; `createSession` spy 0 |
| mid-turn await | `clearKeepId` holds a promise; `handleServeRequest` does not resolve until release; final status **200** not 202; `turnFlights.size === 0` |
| not tree-stop | `/clear` does not increment parent `abortCalls` from serve itself; `whenTreeStop` not required for the 200 |

Existing cancel / compact / submit / resolve / stream tests stay green. Mid-turn abort-then-wipe remains an engine contract (`session-engine.test.ts`); HTTP only awaits.

**Done when.** That command fails if the envelope, 400 string, 404-no-mint, or “await not 202” contract regresses.

---

## Wave C2 — Help and architecture

### C2.1 Printer, headless, ARCHITECTURE, keep-id OUT

**Why.** Help still prints `submit|/cancel|/compact|/resolve`. Headless and ARCHITECTURE still say there is no `POST …/clear`. Keep-id ruling 12 is historical OUT.

**Contract.**

- `runServe` help line becomes `POST /v1/session/:id/submit|/cancel|/compact|/resolve|/clear` (add `/clear` only; do not restack followup/edit/pr onto this one line unless already there).
- `docs/headless.md`: add a bullet `POST /v1/session/:id/clear` — no required body; 200 `{ ok: true, notice: 'session cleared' }` or 200 `{ ok: false, notice }` with the engine string; awaits `engine.clearKeepId()`; unknown session 404, no mint; invalid JSON 400 `invalid json`. Replace “There is no `POST /v1/session/:id/clear`.”
- `ARCHITECTURE.md` / `.ko.md` serve list: same bullet. `clearKeepId()` sentence: hosts include serve `POST …/clear`; still must not `openNewSession` / `close` / `mcpCloser`.
- Keep-id spec: historical ruling 12 stays; one-line amendment that HTTP `POST /v1/session/:id/clear` is unparked by this spec only and must call `engine.clearKeepId()`. Out-of-horizon list drops that route as a parked door (or marks it amended). Do not rewrite K1–K4.
- Remaining-roadmap: successor pointer to this spec. Do not rewrite shipped waves.
- `CHANGELOG.md` Unreleased: this-branch HTTP `POST …/clear`. Schema stays **v10**.

**Files.** `packages/cli/src/serve.ts` (~1088), `docs/headless.md`, `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`, `docs/superpowers/specs/2026-09-18-keep-id-clear.md`, `docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md`, `CHANGELOG.md`, this spec Status → implemented at `a53be93`.

**Done when.** Those files link here. Help and headless no longer omit `/clear`. Keep-id no longer forbids the route as a future door.

---

## Out of this horizon

Web chat UI, Next.js BFF, Prisma Task, Socket.IO, y0 Shadow wiki / indexer, eve compiler, OpenAPI connections, memory slots, `defineState`, credential brokering, self-mod, any new chat network, sandbox network policy, Grep/Glob docker-exec, `ignored`, schema v11, async `createSessionEngine`, compact-then-die, cancel-without-live abort-pair, interrupt abort-pair, cancel `202`/`200` polish, changing `clearKeepId` wipe/keep table, hard-delete of message rows, deleting `raven/*` worktrees from `/clear`, changing `openNewSession`, ACP/Slack/Discord/exec clear routes, TUI `/clear` rewrite.

If a later product wants ACP or chat-network clear, it still calls `engine.clearKeepId()` and does not mint a new id.

---

## Suggested order

1. **C0.1** with this spec file (this commit).
2. **C1.1 + C1.2** TDD in `serve.test.ts` / `serve.ts`.
3. **C2.1** after C1 is green.

---

## Success checks

A slice that does not move one of these is out of scope.

1. `POST /v1/session/:id/clear` exists, Bearer-gated, `loadSessionRuntime` 404, no mint (C1).
2. Happy path is **200** `{ ok: true, notice: 'session cleared' }`; persist-fail and `pending permission ask` are **200** `{ ok: false, notice }` (C1).
3. Serve calls `engine.clearKeepId()` only; no wipe reimplementation; no `openNewSession` / `close` / `mcpCloser` / `deleteSession` / `createSession` (C1).
4. Empty body OK; `JSON.parse` throw is 400 `{ error: 'invalid json' }`; parsed JSON ignored (C1).
5. Mid-turn awaits `clearKeepId` (not 202); no `singleFlight`; no `abortCachedDescendants` / `whenTreeStop` (C1).
6. Help, headless, ARCHITECTURE, and keep-id OUT name the route (C2).
7. Schema stays v10. `session-engine.ts` unchanged (C1, C2).
8. `bun test ./packages/cli/src/serve.test.ts` fails if 2, 3, 4, or 5 regress (C1.2).

---

## Key decisions

1. **Theme is serve-wire for an already-shipped engine op, not a new clear product.** Keep-id already decided wipe/keep, abort-then-wipe, and child leftover refuse. This door is a route.
2. **Envelope is 200 `{ ok, notice }` both ways.** Persist-fail and leftover refuse are engine outcomes, not HTTP client errors. 204 would hide the notice. 202 would lie that clear is a turn.
3. **Await, do not queue.** `singleFlight` on `/clear` would invert mid-turn law (wait for the turn instead of aborting it). `clearKeepId` already serializes concurrent clears.
4. **Tree-stop stays `/cancel`.** Walking descendants from `/clear` would reopen keep-id ruling 8–10. HTTP passes through `pending permission ask`.
5. **Unknown session 404, no mint.** Submit may create. Clear must not — wiping a minted empty id is a different product and would consume an included cap if it went through `openNewSession`.
6. **Body is optional and ignored.** Hosts that POST `{}` or a leftover cancel body must not 400. Only broken JSON is 400, same string as cancel.
7. **This spec amends earlier OUT rulings for `POST /v1/session/:id/clear` only.** Other parked doors stay closed.
