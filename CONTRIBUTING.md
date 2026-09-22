# Contributing to RavenClaw

RavenClaw is a Bun/TypeScript monorepo. Bring your own API key. There is no RavenClaw backend.

## Setup

```bash
git clone https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw
bun install
bun test
bun run raven --help
```

Optional live path:

```bash
bun run raven setup
bun run raven doctor
bun run smoke
```

`bun test` does not call a model. `bun run smoke` does, and is not part of CI.

## Layout

| Package | Role |
|---|---|
| `packages/core` | query loop, tools, permissions, sessions, MCP, skills. Model roles and prices: `src/cost/models.ts` |
| `packages/providers` | Anthropic, OpenAI-compat, Responses, included gateway |
| `packages/ads` | first-party ads (must not import `@ravenclaw/core`) |
| `packages/sdk` | `createRavenSession` (no Ink, ads, or CLI) |
| `packages/cli` | `raven` Ink TUI and commands |
| `packages/tui-opentui` | StreamEvent line view |
| `packages/acp` | editor JSON-RPC adapter |

Architecture: [ARCHITECTURE.md](ARCHITECTURE.md) ([한국어](ARCHITECTURE.ko.md)). Slash commands: [SLASH_COMMANDS.md](SLASH_COMMANDS.md) ([한국어](SLASH_COMMANDS.ko.md)). Design notes live in `docs/superpowers/specs/`. Prior-art research is in `docs/research/`. Do not copy Claude Code source or prompts.

## Tests

```bash
bun test
bun test packages/cli/src/doctor.test.ts
```

- Prefer TDD for loop, persist, and permission changes.
- Pairing invariant tests in `packages/core/src/loop/` must stay green.
- Ads isolation test must stay green: `@ravenclaw/ads` has no core/ink/react import.
- Env-gated live provider tests skip unless `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OLLAMA_HOST` / `VLLM_BASE_URL` is set. Optional `OLLAMA_MODEL` / `VLLM_MODEL`.
- CI (`scripts/ci-unit.sh`) runs `bun test packages/<name>` for every workspace package (`core`, `cli`, `providers`, `ads`, `sdk`, `acp`, `tui-opentui`). Never `bun test` with no args (full-repo Docker hang).
- CI also runs no-key CLI commands (`--help`, `sessions`, `config`, `init`, `completions`). `raven smoke` is not run in CI.

## Adding a CLI command

1. Add the command name to `parseArgv` in `packages/cli/src/args.ts`.
2. Handle it in `packages/cli/src/index.ts` **before** `bootCli` if it must work without a key.
3. Update `HELP_TEXT` and `COMPLETION_COMMANDS`.
4. Add parse + behavior tests.

Commands that must not require a key: `help`, `version`, `sessions`, `show`, `rm`, `search`, `export`, `title`, `doctor`, `config`, `init`, `completions`, `mcp`, `skills`, `cron` (list/add/rm/on/off; `tick`/`watch` need a key if a job fires).

In-session slash commands live in `packages/cli/src/commands.ts` (`SLASH_COMMANDS`). Add `/loop` and `/skills` subcommands there, then handle them in `app.tsx` and `opentui-app.ts`. Builtin skills are `packages/core/src/skills/builtin/<name>/SKILL.md` — keep frontmatter `name` + `description`, no vendor brand strings. `bun test packages/core/src/skills/` checks that.

When you add a user-facing flag or slash, update `README.md` and [SLASH_COMMANDS.md](SLASH_COMMANDS.md) (plus [SLASH_COMMANDS.ko.md](SLASH_COMMANDS.ko.md) if the English page changed) in the same PR.

## Updating the model catalog

Official snapshot ids and prices live in **one file**: `packages/core/src/cost/models.ts`.

| Layer | What it is | Who edits it |
|---|---|---|
| `CURRENT` | Role → current official API id (`default` / `strong` / `fast`) | Bump when a generation ships |
| `BUILT_INS` | Context window, 5-minute cache prices, thinking | Add a row for the new snapshot |
| `ALIASES` | Prefixed / dated / vendor nicknames → canonical id | Add if the vendor publishes extras |
| `defaultModelId(family, role)` | The only API other packages should call | Do not duplicate snapshot strings |

`defaultConfig()`, `defaultModelForProvider()`, and the OpenAI Responses fallback all call `defaultModelId`. Do **not** paste a new id into `packages/core/src/config.ts`, `packages/providers/src/responses.ts`, README examples-as-defaults, or tests that only check “did the default load”.

When Anthropic or OpenAI ships a new generation:

1. Add the official API id to `BUILT_INS` (context, list prices, `supportsThinking`).
2. Point `CURRENT.<family>.<role>` at that id.
3. Add `ALIASES` for prefixed or dated forms (`anthropic/…`, `openai/…`, dated Haiku ids).
4. Update the pointer assertions in `packages/core/src/cost/models.test.ts` (`defaultModelId` describe). Catalog-row tests may keep naming the snapshot; they are the price table, not the default.
5. Refresh the README [Models](README.md#models) table and the `config.yaml` example id if the **default** role moved.

Default-value tests must compare against `defaultModelId('anthropic')` / `defaultModelId('openai')`, not a literal. Parser and payload tests may use any fixture string (`anthropic/claude-sonnet-4`, `vendor/fixture-model`).

Do not fetch a vendor `/models` list at runtime. Unknown user ids stay pass-through (`conservativeProfile`).

## Releases

Versions come from each package's `package.json` (`readPackageVersion`). Do not hardcode `0.1.x` in source.

1. Bump every workspace `package.json` to the same version.
2. Add a `CHANGELOG.md` section and set the README version line.
3. `bun test` then `bun run raven --version`.
4. Commit `chore: release x.y.z`, annotated tag `vx.y.z`, push branch and tag.
5. `gh release create vx.y.z` with notes that match the changelog.

## Style

- TypeScript, Bun test runner, no new runtime if a test can use a fake.
- Clean-room: original types and prompts only.
- Do not print API keys. `doctor` and `config` may print `set (N chars)`.
- Keep PRs independently reviewable.

Apache-2.0. Open an issue or PR on [YeonwooSung/RavenClaw](https://github.com/YeonwooSung/RavenClaw). Use the Bug / Feature issue forms and the pull request checklist. Security reports go to [SECURITY.md](SECURITY.md), not a public issue.
