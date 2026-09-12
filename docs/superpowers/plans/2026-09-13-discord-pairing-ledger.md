# Discord + pairing + inbound ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `raven discord` as a Slack sibling: allowlist + DM pairing CLI, inbound event-id dedupe, Slack-matching leftover-ask.

**Architecture:** Clone the Slack adapter shape (`run` / admit / session-key / send-then-edit / `turnFlights` + 15s mailbox) without editing Slack. Pairing is a home-dir JSON module Slack does not call. The inbound ledger is a SQLite sibling of SessionStore (`deliveries` table, schema_version 4). Tests inject a fake Gateway stream and a fake REST API — no live Discord.

**Tech Stack:** Bun, TypeScript, official Discord Gateway (HTTPS + WebSocket) in production, `bun:sqlite` for deliveries, existing `bootCli` / `openNewSession` / `singleFlight`.

**Spec:** `docs/superpowers/specs/2026-09-12-ravenclaw-discord-pairing-ledger.md`

## Global Constraints

- One `queryLoop`. Discord only calls `submitMessage`.
- Persist-before-execute and pairing (tool_use / tool_result) stay law.
- `dontAsk` is not `bypass`. Guild channels are `dontAsk`. DMs leftover-ask, 120s deny.
- Empty `allowFrom` is deny-all except a pairing-approved user id.
- No company backend. Tokens in `~/.ravenclaw/.env` (0600). Token env: `DISCORD_BOT_TOKEN`.
- Ads never on BYOK chat sessions.
- Slack package (`packages/cli/src/slack/**`) is **read-only**. Do not refactor Slack.
- Targeted `bun test` only. Never run full-repo `bun test` (Docker hang).
- No discord.js-sized SDK. No voice, buttons, outbound send queue, image attach, or per-channel worktrees.
- Live Discord cloud is not a done-condition.

## File map

| File | Responsibility |
|---|---|
| `packages/cli/src/pairing.ts` | pairing.json / pairing-pending.json + list/approve/revoke/issue |
| `packages/core/src/session/deliveries.ts` | `seen(id)`, `gc(olderThan)` |
| `packages/core/src/migrations/004_deliveries.sql` | `deliveries` table; bump schema to 4 |
| `packages/core/src/types.ts` | add `'discord'` to `SessionLockHolderName` |
| `packages/core/src/config.ts` | `DiscordConfig` under `discord:` |
| `packages/cli/src/discord/session-key.ts` | `raven:discord:{guildId\|dm}:{channelId}[:threadId]` |
| `packages/cli/src/discord/admit.ts` | channel / DM / pairing / bot / empty |
| `packages/cli/src/discord/types.ts` | inbound, config, gateway, API |
| `packages/cli/src/discord/api.ts` | create/edit message (fetch) |
| `packages/cli/src/discord/gateway.ts` | official Gateway; injectable for tests |
| `packages/cli/src/discord/adapter.ts` | event path + handleTurn |
| `packages/cli/src/discord/run.ts` | `runDiscord`, `DISCORD_LOCK_HOLDER` |
| `packages/cli/src/args.ts` `index.ts` `help.ts` `completions.ts` | `raven discord`, `raven pairing` |

---

### Task 1: Pairing file + CLI functions

**Files:**
- Create: `packages/cli/src/pairing.ts`
- Test: `packages/cli/src/pairing.test.ts`

**Interfaces:**
- Consumes: `ravenclawHome()`, `node:fs` (`readFileSync` / `writeFileSync` / `chmodSync` / `mkdirSync`)
- Produces:

```ts
export const PAIRING_TTL_MS = 10 * 60 * 1000

export type PairingPlatform = 'discord'

export type PairingStore = {
  discord: Record<string, { approvedAt: number; note?: string }>
}

export type PairingPending = {
  [code: string]: { platform: PairingPlatform; userId: string; expiresAt: number }
}

export function pairingPaths(home: string): { store: string; pending: string }

export function loadPairingStore(home: string): PairingStore
export function loadPairingPending(home: string): PairingPending
export function isPairingApproved(home: string, platform: PairingPlatform, userId: string): boolean

export function issueOrReusePending(
  home: string,
  platform: PairingPlatform,
  userId: string,
  opts?: { now?: () => number; randomCode?: () => string },
): { code: string; reused: boolean }

export function approvePairingCode(
  home: string,
  code: string,
  opts?: { now?: () => number },
): { ok: true; platform: PairingPlatform; userId: string } | { ok: false; error: string }

export function revokePairing(
  home: string,
  platform: PairingPlatform,
  userId: string,
): boolean

export function formatPairingList(home: string, opts?: { now?: () => number }): string

export function handlePairingCli(
  args: string[],
  opts?: { home?: string; now?: () => number },
): Promise<number>
```

Corrupt JSON → empty fail-closed store (`{ discord: {} }`) and empty pending (`{}`). `isPairingApproved` is then false for everyone.

Writes use mode `0o600`. Directory is `home` (already created by `ensureHomeDir`).

`issueOrReusePending`: if a pending row exists for the same `platform`+`userId` with `expiresAt > now()`, return that code with `reused: true`. Else generate a 6-digit code (`100000`–`999999`), store `{ platform, userId, expiresAt: now + PAIRING_TTL_MS }`, return `reused: false`.

`approvePairingCode`: trim code; missing or `expiresAt <= now` → `{ ok: false, error: 'unknown or expired code' }`. Else write `store.discord[userId] = { approvedAt: now() }`, delete pending row.

`revokePairing`: delete `store.discord[userId]`; return whether it existed. Does not touch config `allowFrom`.

`handlePairingCli`:
- `[]` or `list` → write `formatPairingList` to stdout, return 0
- `approve <code>` → approve; ok print `approved discord <userId>\n` return 0; fail print error to stderr return 1
- `revoke discord <userId>` → revoke; missing print `not paired\n` to stderr return 1; ok print `revoked discord <userId>\n` return 0
- anything else → stderr `usage: raven pairing [list|approve <code>|revoke discord <userId>]\n` return 2

`formatPairingList`: approved lines `discord <userId> approved` plus pending `pending <code> discord <userId> expires <iso>`. No tokens.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/pairing.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:os'
import { tmpdir } from 'node:os'
import {
  PAIRING_TTL_MS,
  approvePairingCode,
  formatPairingList,
  handlePairingCli,
  isPairingApproved,
  issueOrReusePending,
  revokePairing,
} from './pairing'

function tempHome(): string {
  const dir = join(tmpdir(), `raven-pairing-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('pairing', () => {
  test('issues, reuses, expires, approves, revokes, and fail-closes', async () => {
    const home = tempHome()
    let now = 1_000_000
    const clock = () => now
    const first = issueOrReusePending(home, 'discord', 'U1', {
      now: clock,
      randomCode: () => '123456',
    })
    expect(first).toEqual({ code: '123456', reused: false })
    const again = issueOrReusePending(home, 'discord', 'U1', {
      now: clock,
      randomCode: () => '999999',
    })
    expect(again).toEqual({ code: '123456', reused: true })
    expect(isPairingApproved(home, 'discord', 'U1')).toBe(false)

    now = 1_000_000 + PAIRING_TTL_MS + 1
    expect(approvePairingCode(home, '123456', { now: clock })).toEqual({
      ok: false,
      error: 'unknown or expired code',
    })
    const fresh = issueOrReusePending(home, 'discord', 'U1', {
      now: clock,
      randomCode: () => '654321',
    })
    expect(fresh.reused).toBe(false)
    expect(approvePairingCode(home, '654321', { now: clock })).toEqual({
      ok: true,
      platform: 'discord',
      userId: 'U1',
    })
    expect(isPairingApproved(home, 'discord', 'U1')).toBe(true)
    expect(revokePairing(home, 'discord', 'U1')).toBe(true)
    expect(isPairingApproved(home, 'discord', 'U1')).toBe(false)

    writeFileSync(join(home, 'pairing.json'), '{not-json', 'utf8')
    expect(isPairingApproved(home, 'discord', 'U1')).toBe(false)

    const listed = formatPairingList(home, { now: clock })
    expect(listed).not.toMatch(/sk-|token|xoxb/i)
  })

  test('handlePairingCli approve unknown exits 1', async () => {
    const home = tempHome()
    const code = await handlePairingCli(['approve', '000000'], { home, now: () => 1 })
    expect(code).toBe(1)
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test packages/cli/src/pairing.test.ts`
Expected: FAIL — `./pairing` does not exist.

- [ ] **Step 3: Implement `packages/cli/src/pairing.ts`**

Use `JSON.parse` in try/catch; on throw return `{ discord: {} }` / `{}`. `writeFileSync(path, json, { encoding: 'utf8', mode: 0o600 })` then `chmodSync(path, 0o600)`.

Default `randomCode`:

```ts
function defaultCode(): string {
  return String(100000 + Math.floor(Math.random() * 900000))
}
```

- [ ] **Step 4: Re-run tests**

Run: `bun test packages/cli/src/pairing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/pairing.ts packages/cli/src/pairing.test.ts
git commit -m "feat: add local pairing file and approve/revoke CLI helpers"
```

---

### Task 2: Inbound deliveries ledger (schema 4)

**Files:**
- Create: `packages/core/src/migrations/004_deliveries.sql`
- Create: `packages/core/src/session/deliveries.ts`
- Modify: `packages/core/src/session/schema.ts` — add migration version 4
- Modify: `packages/core/src/session/schema.test.ts` and `sqlite-store.test.ts` — `schema_version` **4** (was 3)
- Test: `packages/core/src/session/deliveries.test.ts`
- Export from `packages/core/src/index.ts`: `createMemoryDeliveries`, `createSqliteDeliveries`

**Interfaces:**
- Consumes: `bun:sqlite` `Database`; existing `applyMigrations`
- Produces:

```ts
export const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000

export interface DeliveryLedger {
  seen(id: string): boolean
  gc(olderThan: number): number
}

export function createMemoryDeliveries(opts?: { now?: () => number }): DeliveryLedger
export function createSqliteDeliveries(db: Database, opts?: { now?: () => number }): DeliveryLedger
export function deliveryKey(source: string, messageId: string): string
```

`deliveryKey('discord', id)` → `discord:<id>`.

`seen(id)`: INSERT OR IGNORE `(id, source, seen_at)`. `source` is the prefix before the first `:` (`discord` for `discord:123`). Return `true` if the row is **new**, `false` if it already existed. If insert throws → return `false` (do not open a turn twice).

`gc(olderThan)`: delete rows with `seen_at < olderThan`; return deleted count.

`004_deliveries.sql`:

```sql
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_seen_at ON deliveries(seen_at);
```

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/session/deliveries.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { applyMigrations } from './schema'
import { DELIVERY_TTL_MS, createMemoryDeliveries, createSqliteDeliveries, deliveryKey } from './deliveries'

describe('deliveryKey', () => {
  test('prefixes the source', () => {
    expect(deliveryKey('discord', 'm1')).toBe('discord:m1')
  })
})

describe('createMemoryDeliveries', () => {
  test('second seen is duplicate; gc drops old rows', () => {
    let now = 1_000
    const ledger = createMemoryDeliveries({ now: () => now })
    expect(ledger.seen('discord:m1')).toBe(true)
    expect(ledger.seen('discord:m1')).toBe(false)
    now = 1_000 + DELIVERY_TTL_MS + 1
    expect(ledger.gc(now - DELIVERY_TTL_MS)).toBe(1)
    expect(ledger.seen('discord:m1')).toBe(true)
  })
})

describe('createSqliteDeliveries', () => {
  test('persists across instances and migrates to schema 4', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('4')
    const first = createSqliteDeliveries(db)
    expect(first.seen('discord:abc')).toBe(true)
    expect(first.seen('discord:abc')).toBe(false)
    const again = createSqliteDeliveries(db)
    expect(again.seen('discord:abc')).toBe(false)
  })
})
```

Update `packages/core/src/session/schema.test.ts` and `sqlite-store.test.ts` strings `'3'` → `'4'` and the test titles that say `schema_version 3`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test packages/core/src/session/deliveries.test.ts packages/core/src/session/schema.test.ts`
Expected: FAIL — `deliveries` module missing and schema still 3.

- [ ] **Step 3: Implement migration + both ledgers**

Memory map: `Map<string, { source: string; seen_at: number }>`.

SQLite:

```ts
const insert = db.query(
  'INSERT OR IGNORE INTO deliveries (id, source, seen_at) VALUES (?, ?, ?)',
)
const changes = insert.run(id, sourceOf(id), now())
return changes.changes === 1
```

On throw, return `false`.

- [ ] **Step 4: Re-run tests**

Run: `bun test packages/core/src/session/deliveries.test.ts packages/core/src/session/schema.test.ts packages/core/src/session/sqlite-store.test.ts packages/core/src/session/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/migrations/004_deliveries.sql packages/core/src/session/deliveries.ts packages/core/src/session/deliveries.test.ts packages/core/src/session/schema.ts packages/core/src/session/schema.test.ts packages/core/src/session/sqlite-store.test.ts packages/core/src/index.ts
git commit -m "feat: add inbound delivery ledger (schema 4)"
```

---

### Task 3: Discord session key, types, lock holder

**Files:**
- Create: `packages/cli/src/discord/types.ts`
- Create: `packages/cli/src/discord/session-key.ts`
- Test: `packages/cli/src/discord/session-key.test.ts`
- Modify: `packages/core/src/types.ts` — `'discord'` on `SessionLockHolderName`
- Create: `packages/cli/src/discord/run.ts` (holder constant only in this task)

**Interfaces:**
- Consumes: `SessionLockHolderName`
- Produces:

```ts
export const DISCORD_LOCK_HOLDER: SessionLockHolderName = 'discord'
export const DISCORD_PERMISSION_TIMEOUT_MS = 120_000

export function discordSessionKey(opts: {
  guildId?: string
  channelId: string
  threadId?: string
  isDm: boolean
}): string

export function discordEventIsDm(opts: { guildId?: string }): boolean
```

Keys (verbatim spec):
- DM: `raven:discord:dm:<channelId>`
- Guild: `raven:discord:<guildId>:<channelId>`
- Thread: `raven:discord:<guildId>:<channelId>:<threadId>`

`discordEventIsDm`: `guildId` missing or `''` → true.

`types.ts` (this task):

```ts
export interface DiscordInbound {
  id: string
  channelId: string
  userId: string
  content: string
  guildId?: string
  threadId?: string
  mentioned: boolean
  isBot: boolean
}

export interface DiscordConfig {
  enabled: boolean
  token: string
  allowFrom: string[]
  channels: string[]
  mentionOnly: boolean
}
```

- [ ] **Step 1: Write the failing tests**

`packages/cli/src/discord/session-key.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { sessionLockedMessage } from '@ravenclaw/core'
import { discordEventIsDm, discordSessionKey } from './session-key'
import { DISCORD_LOCK_HOLDER } from './run'

describe('discordSessionKey', () => {
  test('guild, thread, and dm shapes', () => {
    expect(discordSessionKey({ guildId: 'G1', channelId: 'C1', isDm: false })).toBe(
      'raven:discord:G1:C1',
    )
    expect(
      discordSessionKey({ guildId: 'G1', channelId: 'C1', threadId: 'T9', isDm: false }),
    ).toBe('raven:discord:G1:C1:T9')
    expect(discordSessionKey({ channelId: 'D1', isDm: true })).toBe('raven:discord:dm:D1')
    expect(discordEventIsDm({})).toBe(true)
    expect(discordEventIsDm({ guildId: 'G1' })).toBe(false)
  })
})

describe('lock holder', () => {
  test("is 'discord', not 'serve'", () => {
    expect(DISCORD_LOCK_HOLDER).toBe('discord')
    const expiresAt = Date.parse('2026-09-13T00:00:00.000Z')
    expect(sessionLockedMessage(DISCORD_LOCK_HOLDER, expiresAt)).toBe(
      'session locked by discord until 2026-09-13T00:00:00.000Z',
    )
  })
})
```

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/cli/src/discord/session-key.test.ts`
Expected: FAIL — modules missing / `'discord'` not in the union.

- [ ] **Step 3: Implement**

Add `'discord'` to `SessionLockHolderName` in `packages/core/src/types.ts`.

`run.ts` for this task is only:

```ts
import type { SessionLockHolderName } from '@ravenclaw/core'
export const DISCORD_LOCK_HOLDER: SessionLockHolderName = 'discord'
```

- [ ] **Step 4: Re-run**

Run: `bun test packages/cli/src/discord/session-key.test.ts packages/core/src/types.test.ts packages/cli/src/slack/run.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/discord/types.ts packages/cli/src/discord/session-key.ts packages/cli/src/discord/session-key.test.ts packages/cli/src/discord/run.ts packages/core/src/types.ts
git commit -m "feat: add Discord session keys and lock holder"
```

---

### Task 4: Discord admit

**Files:**
- Create: `packages/cli/src/discord/admit.ts`
- Test: `packages/cli/src/discord/admit.test.ts`

**Interfaces:**
- Consumes: `DiscordInbound`, `DiscordConfig` from Task 3; `isUserAllowed` from `@ravenclaw/core`; `isPairingApproved` from Task 1
- Produces:

```ts
export type DiscordAdmit =
  | 'ok'
  | 'pair-dm'
  | 'deny-allowFrom'
  | 'ignore-channel'
  | 'ignore-mention'
  | 'ignore'

export function admitDiscordEvent(
  event: DiscordInbound,
  config: DiscordConfig,
  opts?: { home?: string },
): DiscordAdmit
```

Rules (spec §2):
- `isBot === true` or `content.trim() === ''` → `'ignore'`
- Guild (`!discordEventIsDm`): `channels.length === 0` or channel not in list → `'ignore-channel'`. `mentionOnly && !mentioned` → `'ignore-mention'`. Author not in `allowFrom` and not `isPairingApproved(home, 'discord', userId)` → `'deny-allowFrom'`. Else `'ok'`.
- DM: `allowFrom` contains user **or** pairing-approved → `'ok'`. Else `'pair-dm'`.

`home` defaults to `ravenclawHome()`. Tests pass a temp home.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { approvePairingCode, issueOrReusePending } from '../pairing'
import { admitDiscordEvent } from './admit'
import type { DiscordConfig, DiscordInbound } from './types'

function home(): string {
  const dir = join(tmpdir(), `raven-admit-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function cfg(over: Partial<DiscordConfig> = {}): DiscordConfig {
  return {
    enabled: true,
    token: 't',
    allowFrom: ['U1'],
    channels: ['C1'],
    mentionOnly: true,
    ...over,
  }
}

function ev(over: Partial<DiscordInbound> = {}): DiscordInbound {
  return {
    id: 'm1',
    channelId: 'C1',
    userId: 'U1',
    content: 'hi',
    guildId: 'G1',
    mentioned: true,
    isBot: false,
    ...over,
  }
}

describe('admitDiscordEvent', () => {
  test('drops bots, empty, missing mention, empty allowFrom channels, and unapproved DMs', () => {
    const h = home()
    expect(admitDiscordEvent(ev({ isBot: true }), cfg(), { home: h })).toBe('ignore')
    expect(admitDiscordEvent(ev({ content: '  ' }), cfg(), { home: h })).toBe('ignore')
    expect(admitDiscordEvent(ev({ mentioned: false }), cfg(), { home: h })).toBe('ignore-mention')
    expect(admitDiscordEvent(ev(), cfg({ channels: [] }), { home: h })).toBe('ignore-channel')
    expect(admitDiscordEvent(ev({ userId: 'U9' }), cfg({ allowFrom: [] }), { home: h })).toBe(
      'deny-allowFrom',
    )
    expect(
      admitDiscordEvent(ev({ guildId: undefined, channelId: 'D1', userId: 'U9' }), cfg({ allowFrom: [] }), {
        home: h,
      }),
    ).toBe('pair-dm')
  })

  test('pairing-approved DM is ok', () => {
    const h = home()
    const issued = issueOrReusePending(h, 'discord', 'U9', { randomCode: () => '111111' })
    expect(approvePairingCode(h, issued.code).ok).toBe(true)
    expect(
      admitDiscordEvent(
        ev({ guildId: undefined, channelId: 'D1', userId: 'U9', content: 'hello' }),
        cfg({ allowFrom: [] }),
        { home: h },
      ),
    ).toBe('ok')
  })
})
```

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/cli/src/discord/admit.test.ts`
Expected: FAIL — `admit` missing.

- [ ] **Step 3: Implement `admit.ts`**

Use `isUserAllowed(userId, { allowedUsers: config.allowFrom })` **or** `isPairingApproved`. Do not set `allowAll`.

- [ ] **Step 4: Re-run**

Run: `bun test packages/cli/src/discord/admit.test.ts packages/cli/src/pairing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/discord/admit.ts packages/cli/src/discord/admit.test.ts
git commit -m "feat: admit Discord events with allowlist and DM pairing"
```

---

### Task 5: `discord:` config

**Files:**
- Modify: `packages/core/src/config.ts` — `DiscordConfig` on `RavenClawConfig`, parse + resolve `DISCORD_BOT_TOKEN`
- Test: `packages/core/src/config.test.ts` — add a `discord:` block next to the existing `slack:` cases

**Interfaces:**
- Consumes: same `asBoolean` / `asString` / `asStringList` / `resolveSecretRef` helpers as Slack
- Produces:

```ts
export interface DiscordConfig {
  enabled: boolean
  token: string
  allowFrom: string[]
  channels: string[]
  mentionOnly: boolean
}

// RavenClawConfig.discord?: DiscordConfig
```

`parseDiscordConfig`: `enabled` default false, `token` default `''`, `allowFrom`/`channels` default `[]`, `mentionOnly` default **true**.

`resolveDiscordConfig`: `token = resolveSecretRef(token, 'DISCORD_BOT_TOKEN', fileEnv)`.

In `loadConfig` after slack:

```ts
const discordRaw = asMap(raw.discord)
if (discordRaw) out.discord = parseDiscordConfig(discordRaw)
```

If `out.discord` exists, after env load: `out.discord = resolveDiscordConfig(out.discord, fileEnv)`. Find the existing `resolveSlackConfig` call site and do the same for discord.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/config.test.ts`, add a case that writes:

```yaml
discord:
  enabled: true
  allowFrom:
    - U1
  channels:
    - C1
```

and `DISCORD_BOT_TOKEN=tok` in `.env`, then `expect(cfg.discord).toEqual({ enabled: true, token: 'tok', allowFrom: ['U1'], channels: ['C1'], mentionOnly: true })`.

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/config.test.ts`
Expected: FAIL — `discord` undefined.

- [ ] **Step 3: Implement parse/resolve**

Do not change Slack parsing.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/config.test.ts
git commit -m "feat: parse discord: config and DISCORD_BOT_TOKEN"
```

---

### Task 6: Gateway + REST + adapter event path

**Files:**
- Create: `packages/cli/src/discord/api.ts`
- Create: `packages/cli/src/discord/gateway.ts`
- Create: `packages/cli/src/discord/normalize.ts`
- Create: `packages/cli/src/discord/adapter.ts`
- Test: `packages/cli/src/discord/adapter.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5; `singleFlight` from `../serve`; `DeliveryLedger` from Task 2
- Produces:

```ts
export interface DiscordApi {
  createMessage(opts: { channelId: string; content: string }): Promise<{ ok: boolean; id?: string }>
  editMessage(opts: { channelId: string; messageId: string; content: string }): Promise<{ ok: boolean }>
  getBotUserId?(): Promise<string | undefined>
}

export interface DiscordGateway {
  events(): AsyncIterable<unknown>
  close(): Promise<void>
}

export function normalizeDiscordMessage(raw: unknown, botUserId?: string): DiscordInbound | undefined

export async function runDiscordAdapter(opts: {
  config: DiscordConfig
  openSession: DiscordOpenSession
  gateway?: DiscordGateway
  api?: DiscordApi
  ledger: DeliveryLedger
  pairingHome: string
  signal?: AbortSignal
  botUserId?: string
  permissionTimeoutMs?: number
  now?: () => number
  turnFlights?: Map<string, Promise<unknown>>
}): Promise<void>
```

`DiscordOpenSession` (add to `types.ts`):

```ts
export type DiscordPermissionAnswer = 'allow' | 'deny' | 'allow_always'

export interface DiscordBoundSession {
  sessionId: string
  submitMessage: (text: string) => AsyncGenerator<unknown, unknown>
}

export type DiscordOpenSession = (req: {
  sessionKey: string
  permissionMode: 'default' | 'dontAsk'
  isDm: boolean
  askUser: (
    event: { id: string; tool: string; message: string },
    signal: AbortSignal,
  ) => Promise<DiscordPermissionAnswer>
}) => Promise<DiscordBoundSession>
```

**normalize:** accept a Discord MESSAGE_CREATE payload (`id`, `channel_id`, `author.id`, `author.bot`, `content`, `guild_id?`, `mention_everyone`, `mentions[]`). `mentioned` is true if `mentions` contains `botUserId` or content includes `<@botUserId>` / `<@!botUserId>`. `threadId` = `id` of the thread if `channel_id` is a thread — for MVP set `threadId` only when `payload.channel_id` differs from a provided `payload.message_reference?.channel_id` **or** when `payload.thread?.id` exists. Simpler MVP: if `payload.position` is undefined and `payload.guild_id` is set, no thread suffix unless `payload.channel_type === 11` (public thread) or `12` (private), then `threadId = payload.channel_id` and parent channel is `payload.parent_id` if present. Use:

```ts
const isThread = payload.channel_type === 11 || payload.channel_type === 12
const channelId = isThread && typeof payload.parent_id === 'string' ? payload.parent_id : payload.channel_id
const threadId = isThread ? payload.channel_id : undefined
```

**Adapter loop (spec §5):**

1. Normalize; if undefined, continue.
2. If `isBot` or `content.trim()===''`, continue (**do not** `ledger.seen`).
3. `const key = deliveryKey('discord', inbound.id)`; if `!ledger.seen(key)` continue.
4. `admitDiscordEvent`. `'ignore*'` / `'deny-allowFrom'` → continue (already ledgered).
5. `'pair-dm'`: `issueOrReusePending(pairingHome, 'discord', userId)`; `api.createMessage({ channelId, content: \`pair with: raven pairing approve ${code}\` })`; **do not** `openSession`.
6. `'ok'`: `handleTurn` — session key from Task 3; `permissionMode = isDm ? 'default' : 'dontAsk'`; `singleFlight(turnFlights, session.sessionId, ...)`.
7. Streaming: first `createMessage` with `'…'`, then `editMessage`; if edit `ok === false`, `createMessage` again. Collapse to `text_delta` only (copy Slack `consumeSubmit`). Throttle edits at 1000ms.
8. `submitMessage` throw → set body `'turn failed'` (not the exception). Lock errors: if `error` has `name === 'SessionLockError'` or message starts with `session locked`, use that message as the one-line reply (Slack family).
9. DM leftover-ask: `askUser` waits up to `permissionTimeoutMs` (default 120000) then `'deny'`. No Discord buttons. Tests inject an `askUser` that never resolves and advance a fake clock **or** pass `permissionTimeoutMs: 20` and assert deny. Minimum: openSession receives `permissionMode: 'default'` for DMs and `'dontAsk'` for guild.

`createDiscordApi(token)` uses `fetch('https://discord.com/api/v10/channels/...')` with `Authorization: Bot ${token}`. Tests inject `api`.

`connectDiscordGateway(token)` is used only when `opts.gateway` is omitted. Implement identify + MESSAGE_CREATE dispatch. Tests **must** inject `gateway` and never open a real socket.

- [ ] **Step 1: Write the failing adapter tests**

Pattern after Slack `FakeSlackSocket`. Include:
1. Guild mention → `submitMessage` once, mode `dontAsk`, key `raven:discord:G1:C1`.
2. Same `id` twice → `submitMessage` length 1 (ledger).
3. Unapproved DM → no `openSession`, API message starts with `pair with: raven pairing approve `.
4. Bot / empty → no `seen` side effect: implement by using a ledger spy, or: send bot message with id `m-bot` then a real message with id `m-bot` (same id) from a user and expect `submitMessage` **once** (because bot was not ledgered). That's the spec test "bot/empty never inserted".
5. `submitMessage` throws `new Error('boom')` → posted/edited text is `turn failed`, not `boom`.

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/cli/src/discord/adapter.test.ts`
Expected: FAIL — adapter missing.

- [ ] **Step 3: Implement normalize, fake-friendly gateway type, api, adapter**

Do not import Slack files.

- [ ] **Step 4: Re-run**

Run: `bun test packages/cli/src/discord/adapter.test.ts packages/cli/src/discord/admit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/discord/api.ts packages/cli/src/discord/gateway.ts packages/cli/src/discord/normalize.ts packages/cli/src/discord/adapter.ts packages/cli/src/discord/adapter.test.ts packages/cli/src/discord/types.ts
git commit -m "feat: Discord adapter admit, ledger, and send/edit turns"
```

---

### Task 7: `runDiscord` + CLI wiring

**Files:**
- Modify: `packages/cli/src/discord/run.ts` — full `runDiscord` (keep `DISCORD_LOCK_HOLDER`)
- Test: `packages/cli/src/discord/run.test.ts` — holder (already in session-key.test; add boot: no token → 1)
- Modify: `packages/cli/src/args.ts` — add `'discord' | 'pairing'` to `cmd`; treat both as top-level commands like `slack`
- Modify: `packages/cli/src/index.ts` — dispatch `runDiscord` / `handlePairingCli`; `pairing` does **not** require a configured provider; `discord` does (same gate as slack)
- Modify: `packages/cli/src/help.ts` — `raven discord`, `raven pairing …` in usage and command list
- Modify: `packages/cli/src/completions.ts` — add `'discord'`, `'pairing'` after `'slack'`
- Test: `packages/cli/src/args.test.ts` — `parseArgv(['discord'])`, `parseArgv(['pairing', 'list'])`
- Test: existing help/completions tests that snapshot command lists

**Interfaces:**
- Consumes: `runDiscordAdapter`, `bootCli({ lockHolder: DISCORD_LOCK_HOLDER, surface: 'headless', createSession: false })`, `startMailboxPoller` + `singleFlight` from `../serve`, `createSqliteStore` / `createSqliteDeliveries` + `gc(Date.now() - DELIVERY_TTL_MS)`
- Produces: `runDiscord(opts: { flags: ConfigFlags }): Promise<number>`

`runDiscord`:
1. `loadConfig`. If `discord` missing or `enabled !== true` → stderr `discord is disabled (set discord.enabled: true in config.yaml)\n` return 1.
2. If `token === ''` → stderr `discord requires DISCORD_BOT_TOKEN\n` return 1. **No Discord API call.**
3. `bootCli({ flags, createSession: false, surface: 'headless', lockHolder: DISCORD_LOCK_HOLDER })`.
4. Open sqlite at the same path `bootCli` / `createSqliteStore` uses (`join(home, 'sessions.sqlite')` — grep `createSqliteStore` for the exact path). `applyMigrations` already ran if the store opened the file; if not, open `new Database(path)` and `createSqliteDeliveries(db)` after `applyMigrations`.
5. `ledger.gc(Date.now() - DELIVERY_TTL_MS)`.
6. Mirror Slack `openSession` (session map, `singleFlight` opening, `permissionMode`, `ask.bind` via `AsyncLocalStorage`).
7. `turnFlights` shared with `startMailboxPoller({ engines, store, turnFlights })` like Slack `run.ts`.
8. `await runDiscordAdapter({ config, openSession, ledger, pairingHome: home, turnFlights, botUserId })`.
9. Return 0 when the adapter returns.

Token-less test: call `runDiscord({ flags: {} })` with a temp `RAVENCLAW_HOME` whose `config.yaml` has `discord.enabled: true` and no token → expect `1`.

- [ ] **Step 1: Write failing CLI tests**

`args.test.ts`:

```ts
expect(parseArgv(['discord'])).toEqual({ cmd: 'discord', flags: {} })
expect(parseArgv(['pairing', 'list'])).toEqual({ cmd: 'pairing', prompt: 'list', flags: {} })
```

`run.test.ts`:

```ts
test('missing token exits 1', async () => {
  const home = mkdtempSync(join(tmpdir(), 'raven-discord-run-'))
  writeFileSync(join(home, 'config.yaml'), 'discord:\n  enabled: true\n')
  const prev = process.env.RAVENCLAW_HOME
  process.env.RAVENCLAW_HOME = home
  delete process.env.DISCORD_BOT_TOKEN
  try {
    const { runDiscord } = await import('./run')
    expect(await runDiscord({ flags: {} })).toBe(1)
  } finally {
    if (prev === undefined) delete process.env.RAVENCLAW_HOME
    else process.env.RAVENCLAW_HOME = prev
  }
})
```

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/cli/src/args.test.ts packages/cli/src/discord/run.test.ts`
Expected: FAIL — `discord` not a cmd / `runDiscord` missing.

- [ ] **Step 3: Implement wiring**

`index.ts` pairing **before** the provider-configured gate:

```ts
if (parsed.cmd === 'pairing') {
  return handlePairingCli((parsed.prompt ?? '').split(/\s+/).filter(Boolean))
}
```

Add `'discord'` to the provider-required list next to `'slack'`. Dispatch `runDiscord` beside `runSlack`.

- [ ] **Step 4: Re-run**

Run: `bun test packages/cli/src/args.test.ts packages/cli/src/discord/run.test.ts packages/cli/src/help.test.ts packages/cli/src/completions.test.ts`
Expected: PASS. If help/completions tests snapshot the full command list, add the two new lines there.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/discord/run.ts packages/cli/src/discord/run.test.ts packages/cli/src/args.ts packages/cli/src/args.test.ts packages/cli/src/index.ts packages/cli/src/help.ts packages/cli/src/completions.ts packages/cli/src/help.test.ts packages/cli/src/completions.test.ts
git commit -m "feat: add raven discord and raven pairing commands"
```

---

### Task 8: Turn serialization + DM 120s deny

**Files:**
- Test: `packages/cli/src/discord/adapter.test.ts` (extend)
- Modify: `packages/cli/src/discord/adapter.ts` / `run.ts` only if a test fails

**Interfaces:**
- Consumes: Task 6 `turnFlights`; Slack mailbox contract (`startMailboxPoller` already wired in Task 7)
- Produces: regression tests for spec done-when 4–5

- [ ] **Step 1: Write the failing tests**

Add to `adapter.test.ts`:

```ts
test('turnFlights serializes two messages on the same session', async () => {
  // Fake gateway emits two guild mentions on C1 with ids m1, m2.
  // openSession.submitMessage is async and records start/end.
  // Expect the second submitMessage starts only after the first ends.
})

test('DM leftover-ask times out to deny', async () => {
  // allowFrom includes the user. permissionTimeoutMs: 20.
  // askUser is a Promise that never resolves.
  // Child tool leftover-ask is simulated by openSession.askUser being invoked
  // from a fake submitMessage that calls askUser then returns.
  // Expect askUser result 'deny' after ~20ms.
})
```

Concrete `DM leftover-ask` test:

```ts
test('DM leftover-ask times out to deny', async () => {
  let answer: string | undefined
  const gateway = new FakeDiscordGateway()
  const running = runDiscordAdapter({
    config: cfg({ allowFrom: ['U1'] }),
    pairingHome: home(),
    ledger: createMemoryDeliveries(),
    permissionTimeoutMs: 20,
    openSession: async (req) => {
      expect(req.permissionMode).toBe('default')
      return {
        sessionId: 'sess_dm',
        async *submitMessage() {
          const ac = new AbortController()
          const result = await req.askUser({ id: 'p1', tool: 'Bash', message: 'run?' }, ac.signal)
          answer = result
        },
      }
    },
    gateway,
    api: new FakeDiscordApi(),
  })
  gateway.push(dmPayload({ id: 'm-dm', authorId: 'U1', content: 'please' }))
  gateway.end()
  await running
  expect(answer).toBe('deny')
})
```

Implement `askUser` in the adapter by racing `opts.permissionTimeoutMs` against a never-resolving waiter when no UI is attached (tests). Production `runDiscord` binds Slack-like ALS ask; if none, deny after timeout.

- [ ] **Step 2: Run and confirm fail if timeout is missing**

Run: `bun test packages/cli/src/discord/adapter.test.ts`
Expected: FAIL until timeout deny exists.

- [ ] **Step 3: Implement the 120s deny race in adapter `askUser` default**

```ts
async function askWithTimeout(
  ask: DiscordOpenSession extends never ? never : DiscordOpenSession,
  // ...
): Promise<DiscordPermissionAnswer> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('deny'), timeoutMs)
    void boundAsk(event, signal).then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}
```

When no host ask is bound, `boundAsk` is `async () => new Promise(() => {})` so the timer always wins.

- [ ] **Step 4: Re-run adapter + pairing + deliveries + args**

Run: `bun test packages/cli/src/discord packages/cli/src/pairing.test.ts packages/core/src/session/deliveries.test.ts packages/cli/src/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/discord/adapter.ts packages/cli/src/discord/adapter.test.ts packages/cli/src/discord/run.ts
git commit -m "test: Discord turnFlights and DM leftover-ask deny"
```

---

## Spec coverage

| Spec | Task |
|---|---|
| §3 Pairing CLI + files + fail-closed | Task 1, 7 |
| §4 Ledger seen/gc + schema | Task 2 |
| §1 Session key + lockHolder discord | Task 3, 7 |
| §2 Admit | Task 4 |
| Token / config | Task 5, 7 |
| §5 Event path send/edit / turn failed | Task 6 |
| `raven discord` / `raven pairing` | Task 7 |
| turnFlights + DM 120s deny | Task 8 |
| Slack read-only | all tasks |
| Done-when 1–5 | Tasks 6–8 |

## Placeholder scan

No TBD. Gateway production identify is in Task 6; tests inject a fake stream.

## Type consistency

- `DiscordConfig` matches config.ts and types.ts
- `DISCORD_LOCK_HOLDER = 'discord'`
- `deliveryKey('discord', id)` → `discord:<id>`
- `DiscordAdmit` includes `pair-dm`
- `PAIRING_TTL_MS = 10 * 60 * 1000`
- `DELIVERY_TTL_MS = 24 * 60 * 60 * 1000`
- `DISCORD_PERMISSION_TIMEOUT_MS = 120_000`
