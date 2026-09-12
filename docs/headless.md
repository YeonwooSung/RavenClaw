# Headless permissions (`raven exec`)

`raven exec` (and `acp` / `serve` / cron fires) force `dontAsk`. That is **not** `bypass`. Leftover asks become denials. There is no yolo / auto-allow-all-Bash mode.

## What `dontAsk` allows

- Read-only tools (`Read`, `Grep`, `Glob`, `ListDir`, `ReadSubtree`, `Skill`, …)
- In-tree `Edit` / `Write` / `ApplyPatch` (path under the session cwd or an `--add-dir` root)
- Bash that `checkPermissions` already allows (clearly read-only commands such as `echo` / `ls`)
- Bash that a **project, user, or session allow rule** matches

## What `dontAsk` still denies

- Leftover mutating Bash (`bun test`, `curl | sh`, anything that still asks)
- Out-of-tree writes (symlink escapes, `../outside`)
- Leftover-ask `Fetch` and `AskUser` (network / host prompt — not auto-allowed just because they are read-only)
- Other leftover-ask mutators (`NotebookEdit`, `Agent`, plugins, …)

`--tools-preset ci` only **puts Bash in the tool pool**. It does not auto-allow commands. Seed a project rule:

```json
[{ "tool": "Bash", "spec": { "command": "bun test" }, "behavior": "allow" }]
```

Write that array to `.ravenclaw/permissions.json`. Prefix match: `bun test` also allows `bun test packages/core`.

## Recipe

```bash
# optional: restrict the pool (omit --allowed-tools to use the preset)
raven exec --dont-ask --tools-preset ci "run bun test"
```

`--tools-preset` is `read` | `write` | `ci` and fills `--allowed-tools` only when that flag is unset.

| Preset | Pool |
|---|---|
| `read` | Read, Grep, Glob, ListDir, ReadSubtree, Skill |
| `write` | read + Edit, Write, ApplyPatch, NotebookEdit |
| `ci` | write + Bash (still needs a project allow rule under `dontAsk`) |

`--allowed-tools Read,Grep` always wins if both flags are present.

## Optional Docker sandbox

The Docker terminal backend already exists. It does not change permission decisions; it only changes where allowed Bash runs.

```yaml
# ~/.ravenclaw/config.yaml
terminal:
  backend: docker
  image: bash:5
```

Use it when you want process isolation for the Bash that a project rule already allowed. It is not a substitute for `dontAsk` or for seeding `permissions.json`.

## Verify-on-stop (`--verify-on-stop`)

TUI sessions nudge (at most twice) if a turn edited files without a test/lint command. The loop does **not** run tests itself.

Headless `exec` and cron fires leave this **off** by default so CI is not surprised.

Opt in for a one-shot:

```bash
raven exec --verify-on-stop "implement the fix"
```

A cron job may set `verifyOnStop: true` in `~/.ravenclaw/cron/jobs.json` (or pass `--verify-on-stop` on `raven cron add`). The same nudge cap applies. Default for exec/cron remains false.
