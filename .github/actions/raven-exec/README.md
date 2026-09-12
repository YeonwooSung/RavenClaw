# raven-exec

Composite GitHub Action for one-shot `raven exec` in CI.

It runs:

```bash
raven exec --json --dont-ask --tools-preset ci --cwd <working-directory> "<prompt>"
```

`dontAsk` is **not** `bypass`. `--tools-preset ci` only puts Bash in the tool pool. Leftover Bash (`bun test`, `curl | sh`, …) is denied unless a **project** rule matches. This action does not pass `bypass` and does not write or default-allow all Bash.

`RAVENCLAW_HOME` is set to `${{ github.workspace }}/.ravenclaw-home` so session state stays in the runner workspace, not `~/.ravenclaw`.

## Required: `.ravenclaw/permissions.json`

Commit an explicit allow list in the working directory. Prefix match: `bun test` also allows `bun test packages/core`.

```json
[{ "tool": "Bash", "spec": { "command": "bun test" }, "behavior": "allow" }]
```

The step fails if that file is missing or empty. Do not add a `*` / empty-spec Bash allow unless you intend to permit every command.

## Consumer snippet

```yaml
# .ravenclaw/permissions.json must exist in the repo (see above).
- uses: actions/checkout@v7
- uses: YeonwooSung/RavenClaw/.github/actions/raven-exec@v0.1.33
  with:
    prompt: run bun test
    working-directory: .
    raven-version: 0.1.33   # optional; omit if `raven` is already on PATH
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    # or OPENAI_API_KEY / local OPENAI_BASE_URL
```

In this repository (after `bun install` and putting `raven` on PATH):

```yaml
- uses: ./.github/actions/raven-exec
  with:
    prompt: run bun test
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Inputs

| Name | Required | Default | Meaning |
|---|---|---|---|
| `prompt` | yes | | Passed to `raven exec` |
| `working-directory` | no | `.` | Project root that owns `.ravenclaw/permissions.json` |
| `raven-version` | no | (empty) | `@ravenclaw/cli` version or tag. Leading `v` is stripped. Empty: use `raven` on PATH, else install latest |

When `raven` is missing (or `raven-version` is set), the action runs `oven-sh/setup-bun` if needed and `bun install -g @ravenclaw/cli[@version]`.

## Failure

The step fails when:

- `.ravenclaw/permissions.json` is missing or empty
- `raven exec` exits nonzero (`completed` is the only success reason)
- JSONL contains `reason: model_error`

## Env

Same BYOK keys as the CLI (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …). The action does not accept a key input.
