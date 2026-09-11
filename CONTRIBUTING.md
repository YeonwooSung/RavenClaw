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
| `packages/core` | query loop, tools, permissions, sessions, MCP merge |
| `packages/providers` | Anthropic, OpenAI-compat, included gateway |
| `packages/ads` | first-party ads (must not import `@ravenclaw/core`) |
| `packages/cli` | `raven` Ink TUI and commands |
| `packages/tui-opentui` | StreamEvent line view |
| `packages/acp` | editor JSON-RPC adapter |

Design notes live in `docs/superpowers/specs/`. Prior-art research is in `docs/research/`. Do not copy Claude Code source or prompts.

## Tests

```bash
bun test
bun test packages/cli/src/doctor.test.ts
```

- Prefer TDD for loop, persist, and permission changes.
- Pairing invariant tests in `packages/core/src/loop/` must stay green.
- Ads isolation test must stay green: `@ravenclaw/ads` has no core/ink/react import.
- Env-gated live provider tests skip unless `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` is set.

## Adding a CLI command

1. Add the command name to `parseArgv` in `packages/cli/src/args.ts`.
2. Handle it in `packages/cli/src/index.ts` **before** `bootCli` if it must work without a key.
3. Update `HELP_TEXT` and `COMPLETION_COMMANDS`.
4. Add parse + behavior tests.

Commands that must not require a key: `help`, `version`, `sessions`, `show`, `rm`, `search`, `export`, `title`, `doctor`, `config`, `init`, `completions`.

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

Apache-2.0. Open an issue or PR on [YeonwooSung/RavenClaw](https://github.com/YeonwooSung/RavenClaw).
