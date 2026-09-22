# RavenClaw next-horizon roadmap (`/config` instruction files)

Date: 2026-09-21  
Status: implemented  
Shipped sha: `0a1176f` on `main`.  
Reviewed against tree at `5ac0679` (`origin/main`, three doors + honesty landed).  
Successor to `2026-09-21-lsp-depth.md` / `2026-09-21-ignored-dismiss.md` / `2026-09-21-grep-glob-docker-exec.md` (all Status: implemented). Unparks **user-selectable project-instruction files** only. Does not reopen user `USER.md`/`MEMORY.md`, `CLAUDE.local.md`, project-level `config.yaml`, WorkspaceFs docker, NotebookEdit docker, dismiss-on-message, or the LSP museum.

Implementation plan: [2026-09-21-instruction-files-config.md](../plans/2026-09-21-instruction-files-config.md). Isolated worktree only. Do not implement on `main`.

Sources: current tree. Steal the *idea* that a coding agent may read `CLAUDE.md` and/or `AGENTS.md`. Do not copy Claude, Cursor, Codex, eve, y0, Hermes, or Freebuff source. Do not become an agent framework. Do not add a web UI.

---

## Where we are

Session start builds the context-tier system part from a cwd→root walk (`loadProjectFiles`). `/config` is a **read-only dump**. `config.yaml` is **read-only** from the product: there is no writer.

At `5ac0679`:

| Piece | Tree |
|---|---|
| Project walk | `PROJECT_FILE_NAMES = ['AGENTS.md', 'RAVEN.md', 'CLAUDE.md']` plus `.ravenclaw/RAVEN.md`, `RAVEN.local.md`, `AGENTS.local.md`, `.ravenclaw/rules/*.md` (`packages/core/src/prompt/project-files.ts`). Closer fills the 40k/file and 60k total budget first. |
| Subdir inject | After a tool that touched a path, first match of `AGENTS.md` then `RAVEN.md` then `CLAUDE.md` below cwd (`loadNearestSubdirAgents`). One directory per turn (`turn.injectedAgentsDirs`). Cap 32k. |
| `/config` | Shared slash, **any**, **read-only**. `formatPublicConfig({ home })`. No arg. Kind stays dump. Catalog: `usage: /config`, `summary: show resolved config`. |
| `raven config` | Same dump. No mutate. |
| `config.yaml` | Parsed by `parseConfigYaml`. `loadConfig` at process boot. **No write path.** Comments and unknown keys survive only because nothing rewrites the file. |
| Session start | `buildSystemParts({ cwd, permissionMode, bare?, effort? })` in CLI `engine.ts` and SDK `index.ts`. Does not receive a file-mode. `loadProjectFiles(cwd)` always. |
| `/reload` | Replaces system parts. Rebuilds project files the same way. Notice `skills reloaded`. Does not re-parse yaml. |
| Onboarding | `scan.ts` lists all three kinds in cwd. `missing` includes `no AGENTS.md/RAVEN.md/CLAUDE.md in cwd`. |
| User memory | `~/.ravenclaw/USER.md` + `MEMORY.md` (and project copies). **Not** `~/.claude/CLAUDE.md`. `--bare` skips memory. |
| Schema | v11. No preference table. |

The hole: a repo that ships both `CLAUDE.md` and `AGENTS.md` always concatenates them. The operator cannot choose CLAUDE-only, CLAUDE-with-AGENTS-fallback, or both, persist that choice, and have the **next session** initialize context from it.

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` stays the only non-`submitMessage` closer. `/config` is a slash, not a tool and not a fourth closer.
2. Default prefix stays small and frozen. No new tool.
3. `dontAsk` never becomes `bypass`.
4. BYOK. Ads never touch BYOK.
5. Clean-room. No vendor prompts. No web UI, Prisma Task, Socket.IO, wiki, Workflow loop, agent compiler.
6. No schema bump. v11 stays. Do not store this setting on `SessionRecord`.
7. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent.

---

## Do not build

- `~/.ravenclaw/CLAUDE.md` / `~/.claude/CLAUDE.md` as a new user-instruction slot (`USER.md` already exists)
- `CLAUDE.local.md`
- Project-level `.ravenclaw/config.yaml` or per-repo override of the mode
- `--instruction-files` / `--claude-md` CLI flag
- Per-session SQLite preference (resume always reads **current** home yaml)
- Interactive AskUser / Ink / OpenTUI widget picker (slash args are the chooser; every host shares dispatch)
- Rewriting all of `config.yaml` (full dump would drop comments and unknown keys)
- Changing 40k/file or 60k total caps, `@include` rules, or closer-first budget
- Filtering `RAVEN.md`, `.ravenclaw/RAVEN.md`, `RAVEN.local.md`, or `.ravenclaw/rules/*`
- Making `raven init` write `CLAUDE.md`
- Fetching https://agents.md or any remote instruction template
- Rewriting `/team-onboarding` `missing` strings this door
- `USER.md` / `MEMORY.md` changes
- Live re-read of yaml on `/reload` for other keys (model, MCP, …)

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

### Mode

1. **Three tokens, one canonical key.** Type `InstructionFilesMode = 'claude' | 'agents-fallback' | 'both'`. Yaml and slash use those exact strings. No aliases (`claude-only`, `claude.md`, `agents` are unknown).

2. **Default `both`.** Missing key, empty file, or unknown yaml value → `'both'`. That is today’s dual load of `AGENTS.md` and `CLAUDE.md`. Fail open to current behavior on read. Slash **set** of an unknown token does not write.

3. **What each mode loads** (project walk, per directory, in addition to the always-on RavenClaw slots in ruling 4):

   | Mode | `CLAUDE.md` | `AGENTS.md` | `AGENTS.local.md` |
   |---|---|---|---|
   | `claude` | yes | no | no |
   | `agents-fallback` | yes if that file exists in **this directory** | yes only when this directory has **no** `CLAUDE.md` | same gate as `AGENTS.md` |
   | `both` | yes | yes | yes |

   `agents-fallback` is **per directory**, not “if any CLAUDE.md exists in the whole walk, drop every AGENTS.md”. Parent `AGENTS.md` still loads when the child directory has only `CLAUDE.md`.

4. **Always-on slots, every mode:** `RAVEN.md`, `.ravenclaw/RAVEN.md`, `RAVEN.local.md`, `.ravenclaw/rules/*.md`. Caps, `@include`, closer-first order, null-byte skip, realpath dedup stay.

5. **Walk order stays cwd→root.** Inside a directory the push order is still AGENTS (if eligible) → RAVEN → CLAUDE (if eligible) → raven slots → locals (if eligible) → rules. `agents-fallback` simply does not push the AGENTS names when `CLAUDE.md` is a file in that directory.

### Subdir inject

6. **Same mode, still first match, still one directory per turn.** `loadNearestSubdirAgents(cwd, path, seen, mode?)`. Default mode `'both'` keeps today’s name order `AGENTS.md`, `RAVEN.md`, `CLAUDE.md`.

   | Mode | Name order |
   |---|---|
   | `claude` | `CLAUDE.md`, `RAVEN.md` |
   | `agents-fallback` | `CLAUDE.md`, `AGENTS.md`, `RAVEN.md` |
   | `both` | `AGENTS.md`, `RAVEN.md`, `CLAUDE.md` |

   Notice prefix stays `[AGENTS.md: <rel>]` even when the file was `CLAUDE.md` (today already labels CLAUDE hits that way). Do not invent a second prefix this door.

### Persistence

7. **Home yaml is the store.** Key is a **top-level scalar**:

   ```yaml
   instructionFiles: both   # claude | agents-fallback | both
   ```

   Not nested. Not in SQLite. Not in the session row. `loadConfig` copies it onto `ResolvedConfig.instructionFiles` (always set; default `'both'`).

8. **Surgical upsert, never a full dump.** New `upsertYamlTopLevelScalar(text, key, value): string` in `packages/core/src/config/yaml.ts`:

   - Missing file or empty text → `instructionFiles: <value>\n`
   - Existing top-level `instructionFiles:` scalar line → replace that line, keep every other line (comments, unknown keys, ordering)
   - Key absent → append `\ninstructionFiles: <value>\n` (add a leading newline if the file does not already end with one)
   - Key exists as a nested map / list / non-scalar → **throw**; caller notices and does **not** write
   - First occurrence only if duplicated

9. **Atomic write.** Core helper `writeHomeInstructionFiles(home: string, mode: InstructionFilesMode): void` reads `join(home, 'config.yaml')` (missing → `''`), runs the upsert, writes `join(home, 'config.yaml.tmp')`, then `rename` onto `config.yaml`. Persist fail (including non-scalar throw) → do not change `runtime.config`, do not reload system, notice `failed to write config.yaml`. Persist-then-apply.

10. **New session init reads yaml, not the previous process’s memory.** `loadConfig` at boot → `buildSystemParts({ …, instructionFiles: config.instructionFiles })` in CLI `engine.ts` and SDK `index.ts`. Resume of an old session in a new process uses **current** yaml.

### `/config`

11. **Bare `/config` stays a dump.** Add one line `instructionFiles: <mode>`. Home unset still `see raven config`. Catalog usage becomes `/config [instructions [claude|agents-fallback|both]]`. Summary: `show resolved config; set instruction file mode`.

12. **Chooser is slash args, shared dispatch.**

    | Input | Effect |
    |---|---|
    | `/config` | dump (includes `instructionFiles`) |
    | `/config instructions` | notice current mode plus the three tokens and one-line meanings; **no write** |
    | `/config instructions claude` / `agents-fallback` / `both` | persist, apply, notice `instructionFiles: <mode>` |
    | `/config instructions <unknown>` | notice `usage: /config instructions claude\|agents-fallback\|both`; no write |
    | `/config <other>` | notice the same usage string; no write |

    Meanings on the chooser notice (exact):

    ```
    instructionFiles: both
      claude           CLAUDE.md only
      agents-fallback  CLAUDE.md, else AGENTS.md in that directory
      both             CLAUDE.md and AGENTS.md
    ```

    First line interpolates the current resolved mode.

13. **Home required to set.** `/config instructions <mode>` with `runtime.config.home` unset → `no home directory`. No write.

14. **Live apply after a successful write.** Same process:

    1. upsert + atomic rename
    2. `runtime.config.instructionFiles = mode`
    3. `engine.setInstructionFiles(mode)` (new method; mutates the field the loop reads)
    4. `reloadSystem` with `buildSystemParts({ cwd, permissionMode, instructionFiles: mode })`

    One notice: `instructionFiles: <mode>`. Do **not** also print `skills reloaded`.

15. **`/reload` and later assembles pass the live mode.** `reloadSystem` in `dispatch.ts` today omits `bare`/`effort` (pre-existing). This door **must** pass `instructionFiles: runtime.config.instructionFiles`. CLI engine create and SDK create must pass it too.

16. **`raven config` dump grows the same line.** No mutate subcommand on the CLI this door.

### Threading

17. **`PromptBuildInput.instructionFiles?`** Omitted → `'both'` so existing tests that call `loadProjectFiles(cwd)` / `buildSystemParts` without the field stay valid. When `projectFilesText` is preloaded (tests), do not walk; the mode is unused.

18. **`SessionEngineOptions.instructionFiles?`** Copied onto a mutable engine field. `QueryLoopOptions` / `LoopState` receive it so `appendSubdirAgents` can pass it. Omitted → `'both'`. Children created from this engine copy the **current** field (a parent `/config` does not have to recreate children already running; new children after the set see the new mode).

19. **No new host entry.** Slack / Discord / ACP / serve / exec / cron all go through `loadConfig` + `buildSystemParts`. They pick up yaml at process start. They can also run the shared `/config` slash when that host dispatches shared slashes.

### Honesty

20. **Caps unchanged.** A `claude` walk that still includes a large `RAVEN.md` can fill the 60k budget. Do not raise caps to “make CLAUDE-only feel bigger”.

21. **Do not write instruction files.** This door only chooses **which existing files to read**. `raven init` still writes `AGENTS.md` when missing.

---

## Theme

The operator picks how project instructions are assembled: CLAUDE.md only, CLAUDE.md with AGENTS.md as a per-directory fallback, or both. The choice lives in `~/.ravenclaw/config.yaml`, survives process restart, and is the input to context-tier init. RavenClaw-native slots stay on. Pairing, prefix, and schema stay still.

---

## Per-slice board

Board as of this worktree (`docs/instruction-files-config`). Status stays **draft** until land on `main`.

| ID | Slice | Status vs tree |
|---|---|---|
| I0 | `InstructionFilesMode`, yaml parse/default, `upsertYamlTopLevelScalar`, atomic home write | **done** |
| I1 | `loadProjectFiles(cwd, mode)` + `loadNearestSubdirAgents(…, mode)` | **done** |
| I2 | Thread mode: `ResolvedConfig` → `buildSystemParts` → CLI/SDK engine create → `SessionEngine` / loop → `/reload` | **done** |
| I3 | `/config` dump line + `instructions` chooser + persist-then-apply + `raven config` dump line | **done** |
| I4 | SLASH_COMMANDS, ARCHITECTURE, README yaml example, CHANGELOG Unreleased | **done** |

---

## Files (plan may refine, not contradict)

| Path | Role |
|---|---|
| `packages/core/src/config/yaml.ts` | `upsertYamlTopLevelScalar` |
| `packages/core/src/config.ts` | type, parse, default `'both'` on `ResolvedConfig` |
| `packages/core/src/config.test.ts` | parse unknown → both; known tokens |
| `packages/core/src/config/yaml.test.ts` | upsert preserves comments; missing file; non-scalar throw |
| `packages/core/src/prompt/project-files.ts` | mode filter |
| `packages/core/src/prompt/project-files.test.ts` | three modes, per-dir fallback, always-on RAVEN/rules |
| `packages/core/src/prompt/subdir-agents.ts` | name order by mode |
| `packages/core/src/prompt/subdir-agents.test.ts` | claude skips AGENTS; fallback prefers CLAUDE in that dir |
| `packages/core/src/prompt/builder.ts` | pass mode into `loadProjectFiles` |
| `packages/core/src/types.ts` | `SessionEngineOptions` + `QueryLoopOptions` field |
| `packages/core/src/loop/session-engine.ts` | store + `setInstructionFiles` + copy onto loop state |
| `packages/core/src/loop/phases.ts` | `appendSubdirAgents` passes mode |
| `packages/core/src/index.ts` | export the mode type if CLI needs it from core |
| `packages/cli/src/engine.ts` | pass `config.instructionFiles` into `buildSystemParts` and engine options |
| `packages/sdk/src/index.ts` | same |
| `packages/cli/src/config-print.ts` | dump line |
| `packages/cli/src/slash/dispatch.ts` | chooser + persist-then-apply |
| `packages/cli/src/slash/dispatch.test.ts` | dump, usage, persist, live reload |
| `packages/cli/src/commands.ts` | usage/summary |
| `SLASH_COMMANDS.md` / `.ko.md`, `ARCHITECTURE.md` / `.ko.md`, `README.md`, `CHANGELOG.md` | honesty |

Home write helper lives next to `loadConfig` (core), not in the CLI, so a test can point `home` at a temp dir without a TUI.

---

## Test pins (plan fills bodies)

- `loadProjectFiles(dir, 'claude')` with both `AGENTS.md` (`AGENTS_ONLY`) and `CLAUDE.md` (`CLAUDE_ONLY`) → contains `CLAUDE_ONLY`, not `AGENTS_ONLY`; still contains `RAVEN.local.md` / rules when present.
- `loadProjectFiles(child, 'agents-fallback')` where child has `CLAUDE.md` and parent has `AGENTS.md` → **both** markers (per-directory fallback, not walk-global).
- `loadProjectFiles(dir, 'agents-fallback')` where the same dir has both files → CLAUDE yes, AGENTS no, `AGENTS.local.md` no.
- `loadProjectFiles(dir, 'both')` with both files → both markers (today).
- Omitted mode ≡ `'both'`.
- Subdir `claude` on a touch under `pkg/` that has only `AGENTS.md` → `undefined`. Same path with `CLAUDE.md` → injects.
- `parseConfigYaml('instructionFiles: claude\n')` → `'claude'`. `instructionFiles: nope` or omitted → resolved `'both'`.
- Upsert on a file whose first lines are comments plus `model: x` → comments and `model:` survive; `instructionFiles:` present once.
- `/config instructions claude` with a temp home → file contains the scalar; notice `instructionFiles: claude`; subsequent `buildSystemParts` walk uses `claude`.
- `/config instructions maybe` → usage notice; file unchanged.
- Persist throw / rename fail → runtime mode unchanged.

---

## Success

A user runs `/config instructions claude`, quits, starts a new `raven` in a repo that has both files, and the context-tier prompt contains `CLAUDE.md` and not `AGENTS.md`. `agents-fallback` in a CLAUDE-only repo still reads `AGENTS.md` when that is the file that exists. `both` matches `5ac0679`. Yaml comments the user wrote by hand are still there.
