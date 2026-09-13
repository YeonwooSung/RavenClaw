# Official Claude skills vs RavenClaw builtins

Date: 2026-09-13
Status: approved for spec (not implemented)
Source: https://github.com/anthropics/skills (`main` @ `34040c9`, 2026-09-10)

## Finding

**None of the 19 official `anthropics/skills` names are RavenClaw builtins.** Name overlap is 0/19.

RavenClaw ships a different set: coding-loop skills, not Claude.ai document/example plugins.

## Official inventory (19)

Plugin split from `.claude-plugin/marketplace.json`:

| Plugin | Skills |
|---|---|
| document-skills | `docx`, `pdf`, `pptx`, `xlsx` |
| example-skills | `algorithmic-art`, `brand-guidelines`, `canvas-design`, `doc-coauthoring`, `frontend-design`, `internal-comms`, `mcp-builder`, `skill-creator`, `slack-gif-creator`, `theme-factory`, `web-artifacts-builder`, `webapp-testing` |
| claude-api | `claude-api` |
| academy-guide | `academy-guide` |
| discernment-nudge | `discernment-nudge` |

## RavenClaw builtins today

Path: `packages/core/src/skills/builtin/<name>/SKILL.md`

| Name | Role |
|---|---|
| `commit` | Draft a conventional commit; do not push |
| `debug` | Diagnose before editing |
| `plan` | Short plan before edits |
| `review` | Read-only review of recent edits |
| `tdd` | Red-green-refactor |
| `test` | Smallest tests for the change |

`packages/core/src/skills/builtin.test.ts` requires exactly these six names and forbids the strings `Claude` and `Anthropic` in every builtin `SKILL.md`.

Related, not builtins: `/learn` already writes a project/user skill from the session (skill-creator contract). `/interview` already interviews before implementing (part of doc-coauthoring). `Read` already extracts text from `.docx` / `.xlsx` (not a full office suite).

## Binding constraints

- Clean-room: steal contracts, never copy official `SKILL.md` bodies, scripts, or prompts.
- License: `docx` / `pdf` / `pptx` / `xlsx` are proprietary (Anthropic LICENSE.txt forbids copy, derivatives, and distribution). RavenClaw is Apache-2.0. Do not vendor them.
- CONTRIBUTING: no vendor brand strings in builtin skills.
- Kitchen-sink: do not grow the default pool to match Claude.ai. Prefer CLI+skill, user/project skills, or MCP.
- No marketplace plugin host.

## Disposition (locked)

### Never ship as RavenClaw builtins

- `academy-guide`, `claude-api`, `brand-guidelines`, `web-artifacts-builder` — Claude/Anthropic product skills.
- `docx`, `pdf`, `pptx`, `xlsx` — proprietary; also kitchen-sink vs existing Read extract.
- `algorithmic-art`, `canvas-design`, `slack-gif-creator`, `theme-factory`, `internal-comms` — not a coding-agent default.
- `discernment-nudge` — Claude.ai reply UX, not a repo skill.
- `webapp-testing` — Playwright/computer-use adjacent; stay out of the default pool.

### Already covered (do not duplicate)

- `skill-creator` → `/learn` + existing skill frontmatter rules.
- `doc-coauthoring` → `/interview` + builtin `plan`.

### Optional later (clean-room only, user must pick)

Short RavenClaw-authored skills (no copied prose), same shape as current builtins:

1. `frontend-design` — distinctive UI direction when building or reshaping UI.
2. `mcp-builder` — how to write an MCP server this repo can load (stdio, name-only config, no secrets in scan).

Default recommendation: **do not add them**. The official set is not a checklist for RavenClaw builtins.

## Success

- This spec names every official skill and a disposition.
- Builtin count stays 6 unless the user explicitly chooses an optional skill.
- No official skill file is copied into the tree.
