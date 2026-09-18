# Stream version / continuationToken — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fail-closed serve reconnect on the existing event log. Stamp `version: 1` on GET snapshot and every NDJSON frame. Hosts resume with an opaque `continuationToken` that is the same cursor as `?after=`.

**Architecture:** Serve-wire only. `STREAM_PROTOCOL_VERSION = 1` is a process constant, not a sqlite column. Serialize `{ version: 1, ...sequencedEvent }` at HTTP write time. Encode `continuationToken` as `base64url(JSON.stringify({ v: 1, s, q }))`. One log. Schema stays v10.

**Tech Stack:** Bun, TypeScript, existing `handleServeRequest` + memory-store stream rows.

**Spec:** `docs/superpowers/specs/2026-09-18-stream-version-token.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer for operator answers.
- Default prefix stays small and frozen. Stream version and resume stay **serve-wire**, not tools and not engine ops.
- `dontAsk` never becomes `bypass`.
- BYOK is the product. Ads never touch BYOK.
- Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
- `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
- Leftover-ask still wins rewind. Edit-resubmit stays host composition.
- Cancel / detach stay as shipped. Closing the stream is detach, not cancel.
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push.
- Do **not** edit `session-engine.ts`, `followup.ts`, `rewind.ts`, sqlite schema/migrations.

### Plan rulings

1. **`STREAM_PROTOCOL_VERSION = 1 as const` lives in `packages/cli/src/serve-stream-protocol.ts`.** Not in `packages/core/src/types.ts`. Not a sqlite column. Not on `SessionRecord`. Not on hub `publish` or `payload_json`.

2. **Stamp at serialize time only.** Snapshot JSON and every `/stream` `write()` emit `version: 1`. Hub subscribers still receive `SequencedStreamEvent` without `version`.

3. **Parse protocol queries after Bearer and before `loadSession`.** 401 → 400 → 404. `POST /v1/turn` ignores `?version=`, `?after=`, and `?continuationToken=`. GET snapshot honors `?version=` and **ignores** `after` / `continuationToken` (not 400).

4. **`parseVersionParam` matches `parseAfterParam` digits:** omit/`null` = speak 1; not `/^\d+$/` or not a safe integer → `invalid version`; integer `!== 1` → `unsupported stream version`.

5. **One handle per `/stream` request.** Both `after` and `continuationToken` keys present (including empty) → 400 `resume conflict` before decode. Token resume equals `after=q`. Token `s !== :id` → 400 `invalid continuationToken`. Token `v` number `!== 1` → 400 `unsupported stream version`.

6. **Token encoding is frozen, not HMAC:** `base64url(JSON.stringify({ v: 1, s: sessionId, q: lastSeq }))`. Decoder accepts padded or unpadded. Extra JSON keys ignored under `v: 1`. Snapshot always includes a tip token, including `lastSeq === 0`.

7. **Docs (Task 4) after code.** Spec Status → implemented (leave SHA blank until land). Pointers + CHANGELOG. Historical OUT lines stay; add a one-line amendment.

## File map

| File | Role |
|---|---|
| `packages/cli/src/serve-stream-protocol.ts` | constant, `parseVersionParam`, encode/decode |
| `packages/cli/src/serve-stream-protocol.test.ts` | helper unit tests |
| `packages/cli/src/serve.ts` | parse after Bearer; stamp snapshot + frames; token alias |
| `packages/cli/src/serve.test.ts` | wire 400s, concat, no-alloc, turn ignore |
| docs listed in Task 4 | pointers + honesty |

---

### Task 1: Protocol version (V1)

**Files:** `serve-stream-protocol.ts`, `serve-stream-protocol.test.ts`, `serve.ts`, `serve.test.ts`

- [ ] **Step 1: Write the failing helper + serve tests**

`packages/cli/src/serve-stream-protocol.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import {
  STREAM_PROTOCOL_VERSION,
  parseVersionParam,
} from './serve-stream-protocol'

describe('parseVersionParam', () => {
  test('omit means speak 1', () => {
    expect(STREAM_PROTOCOL_VERSION).toBe(1)
    expect(parseVersionParam(null)).toEqual({ ok: true })
  })

  test('1 is accepted', () => {
    expect(parseVersionParam('1')).toEqual({ ok: true, version: 1 })
  })

  test('bad digits are invalid version', () => {
    for (const raw of ['', 'foo', '1.5', '-1']) {
      expect(parseVersionParam(raw)).toEqual({ ok: false, error: 'invalid version' })
    }
  })

  test('other integers are unsupported', () => {
    for (const raw of ['0', '2', '25']) {
      expect(parseVersionParam(raw)).toEqual({
        ok: false,
        error: 'unsupported stream version',
      })
    }
  })
})
```

In `serve.test.ts`, add `version: 1` to every existing NDJSON `toEqual`, and add:

```ts
test('GET snapshot includes version 1; ?version=2 is 400 before 404', async () => {
  const secret = gatewaySecret({ GATEWAY_SECRET: 'secret' })
  const ctx = makeServeCtx(secret)
  const auth = { authorization: 'Bearer secret' }
  const ok = await handleServeRequest(new Request('http://127.0.0.1/v1/session/s1', { headers: auth }), ctx)
  expect(ok.status).toBe(200)
  expect(((await ok.json()) as { version: number }).version).toBe(1)

  const noAuth = await handleServeRequest(new Request('http://127.0.0.1/v1/session/missing?version=2'), ctx)
  expect(noAuth.status).toBe(401)

  const bad = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/missing?version=2', { headers: auth }),
    ctx,
  )
  expect(bad.status).toBe(400)
  expect(await bad.json()).toEqual({ error: 'unsupported stream version' })
})

test('stream ?version= matrix is 400 before 404; frames stamp version 1', async () => {
  const secret = gatewaySecret({ GATEWAY_SECRET: 'secret' })
  const ctx = makeServeCtx(secret)
  const auth = { authorization: 'Bearer secret' }
  for (const raw of ['', 'foo', '1.5', '-1']) {
    const res = await handleServeRequest(
      new Request(`http://127.0.0.1/v1/session/missing/stream?version=${raw}`, { headers: auth }),
      ctx,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid version' })
  }
  for (const raw of ['0', '2', '25']) {
    const res = await handleServeRequest(
      new Request(`http://127.0.0.1/v1/session/missing/stream?version=${raw}`, { headers: auth }),
      ctx,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'unsupported stream version' })
  }
})

test('POST /v1/turn ignores ?version=', async () => {
  const secret = gatewaySecret({ GATEWAY_SECRET: 'secret' })
  const ctx = makeServeCtx(secret)
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/turn?after=0&version=2', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: JSON.stringify({ text: 'hi' }),
    }),
    ctx,
  )
  expect(res.status).toBe(200)
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/yeonwoosung/Desktop/RavenClaw/.worktrees/stream-version-token-spec
bun test ./packages/cli/src/serve-stream-protocol.test.ts ./packages/cli/src/serve.test.ts
```

Expected: FAIL — helper module missing; snapshot has no `version`; stream lines lack `version: 1`; `?version=2` is not 400.

- [ ] **Step 3: Implement the minimum**

`serve-stream-protocol.ts`: export `STREAM_PROTOCOL_VERSION` and `parseVersionParam` (same `/^\d+$/` + `Number.isSafeInteger` rule as `parseAfterParam`).

`serve.ts`: import them. After Bearer on GET snapshot and GET stream, parse `?version=` and 400 the locked strings. Snapshot 200 includes `version: 1`. Stream `write()` serializes `{ version: STREAM_PROTOCOL_VERSION, ...event }`. Do not persist `version`. Do not parse version on `/v1/turn`.

- [ ] **Step 4: Re-run tests**

Same command. Expected: FAIL only on later token cases if already written; otherwise pass existing + V1 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve-stream-protocol.ts packages/cli/src/serve-stream-protocol.test.ts packages/cli/src/serve.ts packages/cli/src/serve.test.ts
git commit -m "$(cat <<'EOF'
feat: stamp stream protocol version 1 on snapshot and NDJSON

Serve-wire only. ?version= fail-closes unknown/malformed values
after Bearer and before session load. Hub payload_json unchanged.
EOF
)"
```

---

### Task 2: continuationToken (V2 + V3 lock)

**Files:** same helper + `serve.ts` + `serve.test.ts`

- [ ] **Step 1: Write the failing encode/decode + wire tests**

Helper cases: round-trip; bad base64; JSON array; `{ v: 1 }` missing `s`/`q`; `q: "3"`; `v: "1"`; `v: 2`; empty `s`; padded decode.

Serve cases from spec V3.1: snapshot tip token; token resume concat equals `?after=lastSeq`; resume conflict; garbage / other-session / `v: 2` 400s; empty token; snapshot ignores after/token; token reconnect does not bump `lastSeq`; parked `permission_ask` keeps seq; `/v1/turn` body `continuationToken` ignored.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/cli/src/serve-stream-protocol.test.ts ./packages/cli/src/serve.test.ts
```

Expected: FAIL — encode/decode missing; snapshot has no token; `/stream?continuationToken=` is not an after alias.

- [ ] **Step 3: Implement the minimum**

```ts
export type ContinuationCursor = {
  version: typeof STREAM_PROTOCOL_VERSION
  sessionId: string
  lastSeq: number
}

export function encodeContinuationToken(cursor: { sessionId: string; lastSeq: number }): string
export function decodeContinuationToken(
  raw: string,
):
  | { ok: true; cursor: ContinuationCursor }
  | { ok: false; error: 'invalid continuationToken' | 'unsupported stream version' }
```

Encode `{ v: 1, s, q }` then base64url (unpadded). Refuse non-negative-safe `lastSeq` / empty `s` in encode. Decode accepts padded or unpadded; extra keys ignored; `v` number `!== 1` → unsupported; missing/non-number `v`, empty `s`, non-number `q` → invalid.

`serve.ts` GET snapshot: `continuationToken: encodeContinuationToken({ sessionId, lastSeq })`.

GET stream after version parse:

```
if after key AND continuationToken key → 400 resume conflict
parse ?after= → 400 invalid after
parse ?continuationToken= → 400 invalid / unsupported
  require cursor.sessionId === :id else 400 invalid continuationToken
  effectiveAfter = cursor.lastSeq
loadSession → 404
replay seq > effectiveAfter then tail
```

- [ ] **Step 4: Re-run tests**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve-stream-protocol.ts packages/cli/src/serve-stream-protocol.test.ts packages/cli/src/serve.ts packages/cli/src/serve.test.ts
git commit -m "$(cat <<'EOF'
feat: resume serve streams with opaque continuationToken

Token is base64url({ v:1, s, q }) and equals ?after=q on one log.
Both handles on one request are 400. Schema stays v10.
EOF
)"
```

---

### Task 3: Docs pointers (V0, after code)

**Files:** spec status; remaining-roadmap; job-host + later specs OUT amendments; `ARCHITECTURE.md` / `.ko.md`; `docs/headless.md`; `CHANGELOG.md`.

- [ ] **Step 1: Amend pointers**

Historical OUT lines stay. Add a one-line amendment (`amended by 2026-09-18-stream-version-token.md`) on job-host / rewind / cancel-reset / no-job Do-not-build and Out-of-horizon bullets. Point remaining-roadmap + ARCHITECTURE related-docs at this spec.

Update headless + ARCHITECTURE serve bullets to the shipped wire: snapshot `{ …, version: 1, continuationToken }`; every NDJSON line `{ version: 1, seq, … }`; `?version=` fail-closed; `?continuationToken=` alias of `?after=`; both keys 400 `resume conflict`. Do not claim HMAC or a second log.

CHANGELOG Unreleased Added: this-branch stream version / continuationToken. Schema stays **v10**.

Spec Status → implemented on this branch (SHA blank until land). Board V0.1–V3.1 → done.

- [ ] **Step 2: Commit**

```bash
git add docs ARCHITECTURE.md ARCHITECTURE.ko.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: point the waist at stream version and continuationToken

Amend prior OUT bullets only. Serve wire is version 1 plus an
opaque tip token; schema stays v10.
EOF
)"
```

---

## Verify

```bash
cd /Users/yeonwoosung/Desktop/RavenClaw/.worktrees/stream-version-token-spec
bun test ./packages/cli/src/serve.test.ts ./packages/cli/src/serve-stream-protocol.test.ts
```

Do not push. Do not merge to main. Do not implement parent-tree-stop or keep-id `/clear`.
