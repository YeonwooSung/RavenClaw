# RavenClaw harness honesty (H0 leftover + H1.3/H1.7)

Date: 2026-09-12  
Status: implemented
HEAD at write: `6763f43`

Steal contracts. Do not copy Hermes or Claude source.

## Goal

Leave RavenClaw running all day in a repo: small frozen tool prefix, honest `dontAsk`, children through the waist, cheap quality gates. No Slack, Electron, `execute_code`, or new core tools.

## Invariants

- One `queryLoop`. Hosts only call `submitMessage`.
- Persist-before-execute. Pairing. No `bypass` / yolo.
- `dontAsk` ≠ leftover-allow-all. In-tree Edit/Write/ApplyPatch may promote. Leftover Bash stays deny.
- BYOK is the product.
- `/reload` is the only sanctioned prefix rebuild.

## Work (four parallel slices)

### A — Prefix freeze, shrink, ToolCall unwrap, stall, MCP fail-open

See implementer brief. Default wire is a coding core. Skill jail is execute-only. MCP is invoked via `ToolCall`, not `tools[]` unlock. Same tool+args+result ≥3 is a stall error. One dead MCP server must not abort session start.

### B — Mode out of stable, coding posture, hook honesty

Permission *descriptions* stay in stable. Live `Current permission mode:` moves to volatile. `setPermissionMode` rewrites volatile only. Context tier gets a frozen coding-posture snapshot. Delete unused lifecycle names. Await `SessionStart` on the first `submitMessage`.

### C — dontAsk Fetch / AskUser

`dontAsk` + leftover-ask + `isReadOnly()` must not auto-allow `Fetch` or `AskUser`. Bash leftover deny is unchanged.

### D — Children through SessionEngine

`Agent` children call `createSessionEngine` + `submitMessage`. `command-runner` persists `tool_calls` before `Bash.execute`. Depth 1. No parent lock, no `verifyOnStop`.

## Out of this wave

H2.3 Ink chrome, Slack, SessionSearch tool, memory write tool, `execute_code`, aux compact model.
