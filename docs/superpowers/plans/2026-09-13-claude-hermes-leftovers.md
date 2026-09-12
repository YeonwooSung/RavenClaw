# Claude / Hermes leftover contracts

Date: 2026-09-13  
Sources (read-only, steal contracts only):

- Claude Code recovered tree: `/Users/yeonwoosung/Desktop/claude-code-source-code-v2.1.88`
- Hermes Agent: `/Users/yeonwoosung/Desktop/hermes-agent`

Do not copy source, prompts, or brand strings. Do not implement in this scan.

Wave 1–4 of `docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md` is already in-tree (mid-turn inject, empty ladder, SessionSearch snippets, Memory write, aux compact, cron timeout, Ink chrome, ACP ask, Slack, mailbox wake, log rotate, GH Action). This file is only contracts those waves did not ship.

## Out of scope

Discord rewrite, `execute_code`, Electron, `bypass` / yolo, streaming tool executor, 25 chat adapters, computer-use, pets, voice, marketplace, Config/theme tool, PowerShell, SSH backend, DiscoverSkills (Claude prefetch is a stub), VerifyPlanExecution / Snip (disabled in the recovered tree).

## Leftovers

### L1. Real LSP handshake

**Why.** Claude `src/services/lsp/LSPClient.ts` and Hermes `agent/lsp/client.py` speak JSON-RPC: `initialize`, `textDocument/didOpen`+`didChange` (versioned, not timestamps), then `hover` / `definition` / `references`. RavenClaw `packages/core/src/lsp/client.ts` only `spawn --version` and echoes the query. The `LSP` tool is a lie.

**Contract.** Persistent client per `(command, workspace)` in `packages/core/src/lsp/client.ts`. Honor `.ravenclaw/lsp.json`. `initialize` + whole-document sync; `LSP` tool `execute` sends the real request and returns the server payload (clipped). Crash → next query restarts. No marketplace, no diagnostic panel.

**Files.** `packages/core/src/lsp/client.ts`, `packages/core/src/tools/lsp.ts`, `packages/core/src/lsp/client.test.ts`.

### L2. Stop hook can force another round

**Status.** Done.

**Why.** Claude `src/query.ts` `handleStopHooks`: `preventContinuation` → `stop_hook_prevented`; blocking errors append a tool/user row and continue the same turn. RavenClaw `packages/core/src/loop/session-engine.ts` runs `Stop` *after* `completed` and ignores `preventContinuation`. Named hook is decorative.

**Contract.** After a no-`tool_use` completion, run `Stop` *before* returning. `preventContinuation` → `hook_stopped` (or `stop_hook_prevented`) and do not start another API call. A blocking `message` is a cache-safe mid-turn hint (`injectMidTurnHint`) and the loop continues once. Skip `Stop` on `model_error` / `aborted` (Claude death-spiral rule). Pairing still 1:1.

**Files.** `packages/core/src/loop/session-engine.ts`, `packages/core/src/loop/phases.ts`, `packages/core/src/hooks/lifecycle.ts`, `packages/core/src/types.ts` (`RoundEnd`).

### L3. `max_output_tokens` escalate then resume

**Status.** Done.

**Why.** Claude withholds the error, retries the *same* request at 64k once, then ≤3 resume nudges. RavenClaw `assembleRequest` always uses `model.reserveOutputTokens` and only mid-turn-nudges on a truncated `stop_reason`. Long answers die at the profile cap.

**Contract.** On truncated stop (already `isTruncatedStop`): if `maxTokens` is still the profile reserve, retry the same assemble with `maxTokens = min(64_000, model.contextWindow - 1k)` and no new user row. If that also truncates, keep the existing `outputNudges` ladder (cap 3). Do not invent a second user message.

**Files.** `packages/core/src/loop/phases.ts` (`assembleRequest`, `streamModel`, `normalizeResponse`), `packages/core/src/loop/query-loop.test.ts`.

### L4. Thinking-only is not a successful stop

**Status.** Done.

**Why.** Hermes `agent/turn_empty_response.py`: thinking-only gets a prefill continuation (×2) before the empty ladder. RavenClaw `isEmptyCompletion` requires `pendingThinking === ''`, so a think-only reply ends the turn.

**Contract.** Treat `pendingText.trim() === ''` as empty even when thinking is present. First two recoveries: mid-turn hint “continue with visible text; do not recap.” Then the existing empty cap (3 / 1 if input > $0.25 / identical-fingerprint stop). Still no Hermes $ ladders beyond that.

**Files.** `packages/core/src/loop/phases.ts` (`isEmptyCompletion`, `normalizeResponse`), `packages/core/src/loop/query-loop.test.ts`.

### L5. Mid-turn MCP refresh

**Why.** Claude `query.ts` calls `refreshTools()` after a tool batch so a late stdio/HTTP connect appears on the next assemble. RavenClaw builds the MCP pool once in `packages/cli/src/engine.ts` / `packages/cli/src/mcp.ts`. A server that comes up after session start stays invisible.

**Contract.** After `runToolRound`, if any MCP transport is still connecting or a server was marked dead-then-alive, rebuild deferred MCP descriptors into the existing `ToolSearch`/`ToolCall` catalog. Do not put new MCP schemas on the default prefix. One dead server still must not abort the session.

**Files.** `packages/cli/src/mcp.ts`, `packages/core/src/mcp/client.ts`, `packages/core/src/loop/phases.ts` (hook or callback on `QueryLoopOptions`), `packages/cli/src/mcp.test.ts`.

### L6. SessionSearch scroll / read

**Status.** Done.

**Why.** Hermes `tools/session_search_tool.py` is one tool with inferred modes: DISCOVERY (`query`), SCROLL (`session_id` + `around_message_id`), READ (`session_id`), BROWSE (no args). RavenClaw `packages/core/src/tools/session-search.ts` only returns `sessionId[:8] messageId[:8] snippet`. The agent cannot open a hit.

**Contract.** Extend `SessionSearch` input: `{ query?: string, sessionId?: string, aroundMessageId?: string, limit?: number }`. `query` → current FTS (unchanged). `sessionId` alone → head/tail lines of that session (cwd-scoped, no hidden `subagent`/`tool` sources). `sessionId` + `aroundMessageId` → ±window. No LLM inside the tool. Cap bodies (e.g. 4k). Still `isReadOnly`.

**Files.** `packages/core/src/tools/session-search.ts`, `packages/core/src/session/search.ts`, `packages/core/src/tools/session-search.test.ts`.

### L7. Docker backend `start()`

**Status.** Done.

**Why.** Hermes terminal backends and Claude Bash both support background jobs. RavenClaw `createDockerTerminalBackend` has `exec` only; `packages/core/src/tools/bash.ts` returns “run_in_background requires the local terminal backend.” Headless Docker cannot run `bun test` in the background.

**Contract.** Implement `start()` on the Docker backend: `docker exec -d` or a long-lived `docker exec` whose stdout is tailed into the existing task output file. `TaskOutput` / `TaskStop` work. Kill is `docker kill` of that exec, not the container. Local backend unchanged.

**Files.** `packages/core/src/tools/terminal-backend.ts`, `packages/core/src/tools/bash.ts`, `packages/core/src/tools/terminal-backend.test.ts`.

### L8. MCP OAuth PKCE loopback

**Why.** Hermes `tools/mcp_oauth.py` is OAuth 2.1 + PKCE + localhost callback + on-disk tokens. RavenClaw HTTP/SSE MCP is headers-only (`packages/core/src/mcp/http.ts`). README already calls PKCE “future.” Interactive HTTP MCP that needs a user login cannot connect.

**Contract.** Optional `mcp.servers[].oauth` (client id, scope, redirect port). Browser + loopback; tokens in `~/.ravenclaw/mcp-oauth/<server>.json` mode 0600. Refresh on 401. Fail closed to “auth required” tool error, never a company broker. Stdio unchanged.

**Files.** `packages/core/src/mcp/http.ts`, new `packages/core/src/mcp/oauth.ts`, `packages/core/src/config.ts`, `packages/cli/src/mcp.ts`.

### L9. Skill curator prune-only

**Why.** Hermes `agent/curator.py` + `tools/skill_usage.py`: idle 7d / 2h idle → unused 30d stale, 90d archive under `skills/.archive/` (never delete). Pinned and builtin skills skipped. LLM consolidation off. RavenClaw has `/skills disable` only; the volatile skill index grows forever.

**Contract.** Sidecar `~/.ravenclaw/skills/.usage.json` (name → lastUsedAt / useCount), bumped on `Skill` execute. On CLI idle (or `raven skills prune`): user/project skills unused 30d → mark stale (keep in index), 90d → move dir to `.archive/`. Never touch builtins or `created_by` ≠ agent. No LLM fork.

**Files.** `packages/core/src/skills/` (new usage + prune), `packages/core/src/tools/skill.ts`, `packages/cli/src/skills-list.ts`.

### L10. Detached memory/skill review fork

**Why.** Hermes `agent/background_review.py`: after delivery, a persistence-detached child inherits the parent’s byte-identical system prompt + `tools[]` (same prefix cache), whitelist `memory` / `skill_manage` / `read_file` / `search_files`, auto-deny Bash, cancel when the next live turn starts. RavenClaw `packages/core/src/review/fork.ts` is a user `/review` one-shot with `tools: []`. Cheap self-improve loop is missing: memory nudge every N user turns + skill nudge after a long tool turn.

**Contract.** After a completed TUI turn (not exec/cron/dontAsk), optionally fork `createSessionEngine` with `bare` persist off, parent system-part hash unchanged, tools = Memory + Skill + Read + Grep only. Cancel on next `submitMessage`. Mid-turn hints (not new user rows) every 10 user turns (“consider Memory”) and after ≥10 tool rounds (“consider /learn”). Default off (`review.background: false`). Included sessions skip.

**Files.** `packages/core/src/review/fork.ts`, `packages/core/src/loop/session-engine.ts`, `packages/core/src/config.ts`, `packages/cli/src/engine.ts`.

### L11. Write/Edit lint sidecar

**Status.** Done.

**Why.** Hermes `tools/file_operations_lint.py` returns syntax-lint in the write/patch result (`py_compile`, `node --check`, …; skip noisy project-wide `tsc` when LSP owns the file). RavenClaw `packages/core/src/tools/write.ts` / `edit.ts` return success only. The model learns about a broken file on the next Read.

**Contract.** After a successful in-tree Write/Edit/ApplyPatch, if a cheap file-local checker exists for the extension, append a short lint block to the tool result (cap ~1k). Failure of the linter is `skipped`, never a write rollback. Do not run `tsc --noEmit` on a single file. LSP handshake (L1) may later replace the sidecar for claimed extensions.

**Files.** `packages/core/src/tools/write.ts`, `edit.ts`, `apply-patch.ts`, new `packages/core/src/tools/lint.ts`.

### L12. ACP edit proposal (old/new text)

**Status.** Done.

**Why.** Hermes `acp_adapter/edit_approval.py` sends `EditProposal { path, old_text, new_text }` so the editor can render a diff. RavenClaw ACP `session/request_permission` only forwards `tool` + raw `input` (`packages/acp/src/server.ts`). Editors cannot show a patch.

**Contract.** For `Edit` / `Write` / `ApplyPatch` `permission_ask`, include `path`, `oldText?`, `newText` on the ACP permission params. Timeout still deny. Sensitive names (`.env`, `id_rsa`) never auto-approve. Other tools stay name+input.

**Files.** `packages/acp/src/protocol.ts`, `packages/acp/src/server.ts`, `packages/cli/src/acp-stdio.ts`, `packages/acp/src/server.test.ts`.

### L13. Second Escape kills background tasks

**Status.** Done.

**Why.** Claude abort: first Escape cancels the live turn; second within 3s kills background agents. RavenClaw `packages/cli/src/app.tsx` Escape always `engine.abort()` only. `/tasks` children keep running.

**Contract.** First Escape: reject in-flight ask + `engine.abort()` (unchanged). Second Escape within 3s: `engine.tasks.killAll()`. Status line says so. OpenTUI same. Headless unchanged.

**Files.** `packages/cli/src/app.tsx`, `packages/cli/src/opentui-app.ts`, `packages/core/src/tasks/registry.ts`.
