# Maintainability refactor (waves)

Date: 2026-09-14
Status: wave 3 implemented (not merged)

## Finding

Do not rewrite `queryLoop`, permissions, persist, or hosts. The tree is already layered (`core` / `providers` / `cli` / `sdk` / `ads`). The debt is **duplicated hosts**, **god files**, and **hot-path CPU**.

## Waves (locked)

### Wave 1 — behavior-preserving, this branch

1. Cache Ajv `compile` by schema object identity (`parseWithSchema`).
2. Move the hand-rolled YAML parser out of `packages/core/src/config.ts` into `packages/core/src/config/yaml.ts`. Public exports stay on `./config`.
3. Drop dead `ToolSearchOpts.unlock`. Do **not** remove `turn.unlockedToolNames` (MCP prefix gate).

### Wave 2 — one slash host

`dispatchSharedSlash(cmd, host)` in `packages/cli/src/slash/dispatch.ts`.

Host-only (stay in each TUI): `quit`, `stop`, `clear`, `resume`, `diff`, `queue`, `loop`, `bash`.

Shared: everything else, including `/add-dir`, `/effort`, `/agents`, `/hooks`. `/skills` disable/enable always `reloadSystem` (Ink behavior). Ink `/team-onboarding` stays fire-and-forget via host; OpenTUI awaits the dispatcher.

### Wave 3 — one chat host

`packages/cli/src/chat-host/session-host.ts` owns mapped engines, ALS ask, mailbox, shutdown.
`packages/cli/src/chat-host/stream-turn.ts` owns stub/throttle/edit-or-repost.
Slack/Discord keep transport, admit, pairing, and ledger.

### Wave 4 — more perf, later

Permission rule cache per turn; FTS prepared statements; Read offset I/O; TUI windowing. Do not change microcompact timing or `repairRoleAlternation` rules.

## Non-goals

- No queryLoop rewrite
- No marketplace, computer-use, extra adapters
- No copying vendor skills
- No unifying CLI/SDK tool pools in wave 1 (product difference: TaskSteer)
