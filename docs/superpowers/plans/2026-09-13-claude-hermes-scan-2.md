# Claude / Hermes leftover contracts — scan 2

Date: 2026-09-13  
Sources (read-only, steal contracts only):

- Claude Code recovered tree: `/Users/yeonwoosung/Desktop/claude-code-source-code-v2.1.88`
- Hermes Agent: `/Users/yeonwoosung/Desktop/hermes-agent`

Do not copy source, prompts, or brand strings. Do not implement in this scan.

L1–L13 in `docs/superpowers/plans/2026-09-13-claude-hermes-leftovers.md` are Done. Wave 1–4 of `docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md` is in-tree. This file is only contracts those waves and L1–L13 did not ship.

## Out of scope

Discord rewrite, `execute_code`, Electron, `bypass` / yolo, streaming tool executor, 25 chat adapters, computer-use, pets, voice, marketplace, Config/theme tool, PowerShell, SSH backend, DiscoverSkills, VerifyPlanExecution / Snip, MCP sampling (deprecated upstream; fail-closed if a server asks), similarity/difflib Edit fallback, image-resize native deps.

## Leftovers

### L14. Edit quote / trailing-ws flex

**Status.** Done.

**Why.** Claude `src/tools/FileEditTool/utils.ts` `findActualString` / `normalizeQuotes` + Hermes `tools/fuzzy_match.py` unicode map: smart quotes, NBSP, trailing spaces still land on a unique region. RavenClaw `packages/core/src/tools/edit.ts` already has newline normalize + indent-flex. One curly quote or trailing space still fails `old_string not found`.

**Contract.** After exact and indent-flex miss: try (1) curly→straight quotes, (2) unicode dashes/ellipsis/NBSP→ASCII, (3) strip trailing whitespace per line. Still require exactly one match. Apply the same transform to `new_string`. No similarity / difflib fallback. ApplyPatch unchanged.

**Files.** `packages/core/src/tools/edit.ts`, `packages/core/src/tools/edit.test.ts`.

### L15. Stale-read refuses Edit / ApplyPatch

**Why.** Claude FileEdit `FILE_UNEXPECTEDLY_MODIFIED_ERROR` compares mtime against the last Read. RavenClaw `turn.readFiles` is a `Set<string>` of paths (`packages/core/src/types.ts`). A sibling Bash or an editor write between Read and Edit is a silent clobber.

**Contract.** On successful Read, record `{ path, mtimeMs }` (or a short content hash). Edit / ApplyPatch `update_file` fail closed if the on-disk mtime/hash differs: `file changed since last Read`. Write overwrite stays allowed (destructive by contract). No watcher, no FileChanged hook.

**Files.** `packages/core/src/types.ts` (`readFiles`), `packages/core/src/tools/read.ts`, `edit.ts`, `apply-patch.ts`, matching tests.

### L16. Background Bash mailbox notice

**Status.** Done.

**Why.** Hermes `tools/process_registry_notifications.py` injects completed background shells. RavenClaw Agent children `enqueueAgentMail`; `packages/core/src/tools/bash.ts` `startBackground` only `tasks.complete`. Ink / OpenTUI / `serve` already peek mailbox — Bash never writes it. Overnight `bun test` finishes silently.

**Contract.** On background Bash `complete` / fail, `enqueueAgentMail` one clipped line: `bash <id[:8]> exit=<n>\n` + last ~1k of the output file. Same `AGENT_MAIL_BODY_MAX` as children. Do not splice into a live API call. Existing mailbox wake starts the next turn.

**Files.** `packages/core/src/tools/bash.ts`, `packages/core/src/tasks/mailbox.ts`, `packages/core/src/tools/bash.test.ts`.

### L17. Mid-turn queue drain

**Why.** Claude `src/query.ts` converts queued prompts to mid-turn attachments after a tool batch so the model sees them before `completed`. RavenClaw `packages/cli/src/app.tsx` only `dequeue` after the turn ends. `/steer` already exists for live-turn text; `/queue` waits a full round.

**Contract.** After `runToolRound`, if the host queue is nonempty, `injectMidTurnHint` the dequeued text onto the last tool row (R1.1 cache-safe path). Cap one item per tool batch. Empty / no-tool completion still dequeues as today’s next-turn. OpenTUI same. Headless unchanged.

**Files.** `packages/cli/src/app.tsx`, `packages/cli/src/opentui-app.ts`, `packages/cli/src/message-queue.ts`, `packages/core/src/loop/session-engine.ts` (optional host callback), tests.

### L18. Fetch HTML → markdown (no second LLM)

**Status.** Done.

**Why.** Claude WebFetch converts HTML to markdown before the cap. RavenClaw `packages/core/src/tools/fetch.ts` returns raw `response.text()`. Doc pages burn the 100k cap on chrome. Do **not** steal Claude’s extra `prompt` field (a second model call).

**Contract.** If `Content-Type` is HTML (or the body starts with `<!doctype html` / `<html`), convert to markdown locally (headings, links, code, lists; strip script/style). Then apply the existing 100k cap. Non-HTML unchanged. Still https-only / SSRF-closed. Still deferred unless `tools.network`.

**Files.** `packages/core/src/tools/fetch.ts`, new small `packages/core/src/tools/html-to-md.ts`, `packages/core/src/tools/fetch.test.ts`.

### L19. MCP elicitation (form only)

**Why.** Claude `src/services/mcp/elicitationHandler.ts` and Hermes `tools/mcp_tool_sampling.py` implement MCP `elicitation/create` so a server can ask the human. RavenClaw `packages/core/src/mcp/client.ts` advertises `capabilities: {}` and has no request handler. Interactive MCP that needs a confirm cannot connect.

**Contract.** Declare elicitation on initialize. Form mode only: forward the schema to the existing AskUser host (TUI / ACP-ask). Timeout / no host → `cancel` (fail closed). No URL-mode browser dance. No sampling. Headless `dontAsk` → cancel.

**Files.** `packages/core/src/mcp/client.ts`, `packages/core/src/mcp/types.ts`, `packages/cli/src/mcp.ts`, `packages/cli/src/ask-host.ts`, tests.

### L20. MCP orphan reaper

**Why.** Hermes `tools/mcp_death_supervisor.py`: one supervisor holds a pipe write-end; parent death including SIGKILL closes the pipe → SIGTERM then SIGKILL of registered stdio MCP process groups. RavenClaw `packages/cli/src/engine.ts` `mcpCloser` runs only on clean shutdown. Hard-killed CLI leaks MCP children (macOS has no `PR_SET_PDEATHSIG`).

**Contract.** Spawn one tiny supervisor per CLI process (or a detached `setsid` helper). Register each stdio MCP pgid. Clean `close()` unregisters. On EOF, TERM + 3s + KILL. HTTP/SSE servers are not spawned — skip. Do not wrap each server in its own Node.

**Files.** `packages/cli/src/mcp.ts`, new `packages/cli/src/mcp-reaper.ts` (or `packages/core/src/mcp/reaper.ts`), `packages/cli/src/mcp.test.ts`.

### L21. macOS prevent-sleep during a live turn

**Status.** Done.

**Why.** Claude `src/services/preventSleep.ts`: refcounted `caffeinate -t 300`, restart before expiry, so a laptop does not sleep mid-Bash / mid-stream. RavenClaw has none. Overnight TUI / `exec` / cron on a closed Mac dies.

**Contract.** On `queryLoop` start (or first `submitMessage` of a live turn), `startPreventSleep()`. On round end / abort / process exit, `stopPreventSleep()`. macOS only; no-op elsewhere. Timeout self-heals if the CLI is SIGKILL’d. No Windows / systemd inhibit.

**Files.** new `packages/cli/src/prevent-sleep.ts`, `packages/cli/src/engine.ts` or `packages/cli/src/app.tsx` + `exec.ts` + `cron-fire.ts`, tests.

### L22. Destructive-git note on Bash ask

**Status.** Done.

**Why.** Claude `src/tools/BashTool/destructiveCommandWarning.ts` adds a one-line note (`git push --force`, `git reset --hard`, `git clean -f`, `--no-verify`) on the permission prompt. It does not change allow/deny. RavenClaw `matchesDangerousPattern` is only `rm -rf /`, `curl|sh`, `dd`, `mkfs`, fork bomb — and `permission-dialog.tsx` prints only `event.message`. Design spec PR 5 already named this as unwired.

**Contract.** If the command matches a destructive-git pattern, `checkPermissions` ask message includes the one-line note. Still leftover-ask (not a new deny). Dialog / ACP / Slack already render `message`. Do not expand `matchesDangerousPattern` into a yolo classifier.

**Files.** `packages/core/src/tools/bash.ts`, `packages/core/src/tools/bash.test.ts`, `packages/cli/src/permission-dialog.tsx` only if the message is truncated.

### L23. CronCreate prompt threat scan

**Status.** Done.

**Why.** Hermes `tools/cronjob_prompt_scan.py` refuses create/update when the user-authored prompt matches injection / secret-read / exfil shapes. RavenClaw `packages/core/src/tools/cron.ts` `CronCreate` stores `prompt` verbatim. Cron fires are `dontAsk` new sessions.

**Contract.** Scan the **user** `prompt` only (not assembled skill bodies) at `CronCreate` and slash `/cron add`. Invisible unicode, “ignore previous instructions”, `cat ~/.*/.env` / `id_rsa`, `curl` of `$TOKEN`/`$SECRET` → tool error, do not persist. Slash path same. No LLM. Existing jobs are not retro-scanned.

**Files.** `packages/core/src/tools/cron.ts`, new `packages/core/src/schedule/prompt-scan.ts`, `packages/cli/src/cron-cmd.ts`, tests.

### L24. Unknown-tool name alias repair

**Status.** Done.

**Why.** Hermes `agent/turn_tool_validation.py` repairs common names before dispatch. RavenClaw `unknownToolText` fails the call. Models trained on Claude/Hermes emit `Task`, `read_file`, `search_files`, `write_file`.

**Contract.** Before `unknown_tool`, map a frozen alias table onto an existing registered name (`Task`→`Agent`, `read_file`→`Read`, `write_file`→`Write`, `search_files`→`Grep`, `list_dir`/`list_files`→`ListDir`/`Glob`). Keep the model’s `tool_use` id. No 3-strike exit (unknown still errors and the loop can complete). Do not invent tools.

**Files.** `packages/core/src/loop/phases.ts` (or `pairing.ts`), `packages/core/src/loop/query-loop.test.ts`.

### L25. Read stdlib office extract

**Status.** Done.

**Why.** Hermes `tools/read_extract.py` turns `.docx` / `.xlsx` / `.ipynb` into text via stdlib zip+xml. RavenClaw Read rejects binary (NUL / unknown). `NotebookEdit` already owns `.ipynb`. Specs and sheets in the repo stay invisible.

**Contract.** For `.docx` / `.xlsx` only: unzip, extract document.xml / sharedStrings+sheet rows, return text under the existing Read cap. Malformed → `Read failed: cannot extract`. No PDF, no `anydoc`, no extra dependency. `.ipynb` stays NotebookEdit. Images unchanged.

**Files.** `packages/core/src/tools/read.ts`, new `packages/core/src/tools/read-extract.ts`, `packages/core/src/tools/read.test.ts`.
