# RavenClaw roadmap

Date: 2026-09-12  
Status: historical (H0 + harness-honesty done at `5629c82`)  
Remaining H1/H2 and honesty leftovers: **`2026-09-12-ravenclaw-remaining-roadmap.md`** (implemented).  
Job-host state (**implemented**): **`2026-09-17-job-host-state-roadmap.md`**. Next: **`2026-09-18-rewind-persist-and-todo-projection.md`**. Previous (implemented): `2026-09-16-session-as-job-roadmap.md`, `2026-09-15-eve-inspired-roadmap.md`.  
Sources: current tree at `d4c018e`+, Hermes (`/Users/yeonwoosung/Desktop/hermes-agent`), eve ([eve-analysis.md](../../research/eve-analysis.md)), original design `2026-09-08-ravenclaw-coding-agent-design.md`.

Steal contracts. Do not copy Claude or Hermes source.

---

## Where we are

RavenClaw already has the **coding-agent waist**:

- `queryLoop` + persist-before-execute + pairing + leftover-ask + no `bypass`
- BYOK (Anthropic / OpenAI-compat / Ollama / vLLM)
- File/shell tools, skills, specialists, MCP, cron, `/loop`, `/rewind`, `raven serve` (loopback HTTP + one-shot webhook)
- Parallel `Agent` (cap 6) + background mailbox + keep-dirty worktrees

The original 2026-09-08 spec’s v1 is **done and then some**. The risk is no longer “missing tools.” It is **surface gravity**: every new capability is another schema on every API call, another slash on two TUIs, another host that can violate persist or `dontAsk`.

Hermes’s lesson (and Freebuff’s): **one loop, adapters at the edge, new work is a skill or a gated tool, not a new core tool.** Their 25-adapter gateway and Electron desktop are the complexity trap we already named.

---

## Direction (what “good” means)

RavenClaw should be the agent you leave running **all day in a repo**, not a smaller Claude Code clone and not a smaller Hermes.

1. **The waist stays sacred.** One `queryLoop`. Hosts (TUI, exec, ACP, serve, Slack, Discord) only call `submitMessage`.
2. **Default prefix stays small and frozen.** Mid-session skill/tool/memory changes wait for the next session unless `/reload`.
3. **Unattended is explicit.** `dontAsk` never becomes `bypass`. Headless Bash needs project rules or a sandbox, not yolo.
4. **BYOK is the product.** Included gateway stays off until admission + spend caps are real. Ads never touch BYOK.
5. **Stop adding kitchen-sink tools.** Prefer CLI+skill, `isEnabled` gates, or MCP. Remove stubs from the default pool.

---

## Do not build

- `bypass` / auto-allow classifier
- 25 chat adapters, Relay/Portal, voice, Electron, pets
- Spawn-everything orchestrator (Freebuff base2)
- Plugin marketplace, computer-use, teammate swarms
- Pro = no ads
- Copying vendor prompts or modules

---

## Horizons

### H0 — Make the waist trustworthy (next)

These are the items that decide whether you would leave RavenClaw running overnight.

| ID | Work | Why |
|---|---|---|
| H0.1 | Cross-process session lock (or a single writer). Durable mailbox on disk. | TUI + `cron watch` + `serve` share `state.db`. In-memory mailbox dies with the process. |
| H0.2 | Empty / silent completion ladder for local models. | Ollama/vLLM otherwise ends the turn as `completed`. |
| H0.3 | Headless permission recipe: project `rules` + `--allowed-tools` + documented `dontAsk` (in-tree write vs leftover Bash). Optional Docker/OS sandbox that **actually applies** to unattended Bash. | Today `exec` can rewrite the tree and cannot run leftover Bash. Worst of both. |
| H0.4 | Wire hooks that exist in name (`Stop`, `SessionEnd`, PreToolUse rewrite) **or delete the names**. | A hook catalog that does not run is a lie. |
| H0.5 | Tool-pool scaling: `isEnabled` for LSP/Cron*/worktree; make `ToolSearch` actually defer MCP; per-server MCP allowlist; fail-loud MCP; cancelable MCP. | 40 tools every round will not survive a real workspace. |
| H0.6 | Included resume must not silently fall back to BYOK. Tell the user and stop. | Funding/provider pairing hole. |

**Done when:** kill -9 mid-tools + `/resume` is safe; `raven exec` can run a seeded test command without `bypass`; local model empty replies retry; default request schema is smaller than today.

### H1 — Daily coding quality (after H0)

Hermes ideas that change **cost and quality of a coding session**, still local/BYOK.

| ID | Work | Why |
|---|---|---|
| H1.1 | Subdirectory `AGENTS.md` on **tool results** (first touch, dedup, ≤32k). | Cache-safe monorepo context. Highest-leverage Hermes leftover. |
| H1.2 | Verify-on-stop (nudge ≤2 if code changed and no test/lint evidence). Opt-in, default on for TUI. Loop does not run tests. | Cheap quality gate. |
| H1.3 | Frozen coding-posture snapshot (package manager, ≤8 verify commands). Prompt-only. | Model knows how *this* repo tests. |
| H1.4 | `SessionSearch` **tool** (FTS already exists; only humans have `/search`). | “How did we fix this last week?” |
| H1.5 | Memory **write** tool (`add`/`replace`/`remove`) against MEMORY/USER. Snapshot stays frozen until next session. Cap = error, not silent drop. | `/review` is user-triggered append; this is how the agent maintains a small true file. |
| H1.6 | Stronger `/learn` authoring rules (60-char description, `references/`, no retyped scripts). | Skill index is on every API call. |
| H1.7 | Stall/repetition guard (same tool+args+result ≥3). | Stops burning money on re-reads. |
| H1.8 | Aux model slot for compact/title (BYOK pin). Fail closed to mechanical. | Long sessions stay cheap. |
| H1.9 | Cron: hard timeout, `skip_memory`, optional pre-script, never splice into the live transcript. | Coding jobs, not a scheduler museum. |

**Optional later in H1:** `execute_code` RPC (whitelist tools in a child kernel; only stdout returns). Highest cost-curve win, also the largest new runtime. Design first; do not start until H0.5 has shrunk the default pool.

### H2 — Hosts people already live in

One polished host beats three half hosts.

| ID | Work | Why |
|---|---|---|
| H2.1 | ACP that can **ask** (or an official VS Code/Zed extension that owns the dialog). Honor `cwd` / `mcpServers` / images on `session/new`. | `dontAsk` ACP cannot do interactive coding. |
| H2.2 | One chat adapter: **Slack Socket Mode** (no public URL). Allowlist + mention + send/edit. Channel is a host, not an orchestrator. | Hermes daily habit without 25 adapters. |
| H2.3 | Ink TUI chrome: todo panel, collapsed Read/Grep, child-agent tree, compact warning. Keep OpenTUI as a line view until Ink is the daily environment. | Primitives exist; chrome does not. |
| H2.4 | Install path (`npm` or `brew`) + optional nightly live-smoke. | Clone+bun is not a daily-driver install. |
| H2.5 | GitHub Action wrapper around `raven exec --json` with a **safe** toolset and explicit rules. | CI that cannot rewrite the tree by accident. |

### H3 — Explicitly later / other products

- Third chat network (Telegram etc.). Slack/Discord + pairing + ledger shipped in `2026-09-12-ravenclaw-discord-pairing-ledger.md`.
- Real LSP handshake (or remove from default pool — prefer H0.5 gate)
- Streaming tool executor
- Background skill curator (easy to poison)
- Hosted included gateway as a **separate** product
- Electron, marketplace, computer-use

---

## Suggested sequence (next 6–8 slices)

Do these in order. Do not start Slack or execute_code before the waist is something you would leave overnight.

1. **H0.5** shrink default tool prefix (`isEnabled` + defer MCP).  
2. **H0.1** durable mailbox + honest multi-process session lock.  
3. **H0.2** empty-completion ladder.  
4. **H0.3** headless permission recipe (docs + rules + optional sandbox).  
5. **H0.4** Stop/SessionEnd or delete the names.  
6. **H1.1** subdirectory AGENTS.md on tool results.  
7. **H1.2** verify-on-stop.  
8. **H2.3** Ink todo/collapse/agent-tree (smallest chrome that changes daily feel).

Then pick **one** of: H2.1 ACP ask, H2.2 Slack, H1.9 cron timeout — not all three.

---

## Success checks

- A 2-hour session on a real monorepo does not `context_full` from tool schemas alone.
- Kill the CLI mid-Bash; `/resume` never re-runs the command.
- `raven exec` with a project rule can run `bun test` and cannot `curl | sh`.
- Ollama empty reply retries instead of “done.”
- You would use Ink for a full workday without missing a todo panel and child progress.

If a proposed feature does not move one of those checks, it is H3.
