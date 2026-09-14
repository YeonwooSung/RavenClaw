# RavenClaw `/team-onboarding`

Date: 2026-09-13  
Status: implemented
Steal contracts from Claude Code `/team-onboarding` (described in https://cross-the-line.tistory.com/117). Do **not** copy Claude source, skill files, or system-prompt text from that post.

Does not extend `2026-09-12-ravenclaw-remaining-roadmap.md`.

---

## Why

A new teammate should get a **current** walkthrough of how *this* workspace actually runs RavenClaw — project files, skills, agents, hooks, MCP — plus a checklist of what is still missing on *their* machine. A hand-written wiki goes stale. Scanning the tree and this user's local sessions does not.

This is not a second product. It is one slash command that injects a frozen prompt, same shape as `/learn` and `/interview`.

---

## What Claude's command is (stolen contract)

`/team-onboarding` is a slash/skill that:

1. Scans project instructions, skills, subagents, hooks, MCP, and recent session history.
2. Builds a **three-section** guide: usage context, setup checklist, team information.
3. Walks the human interactively: greet, mark done items, help with remaining setup.
4. Must **not invent** rules that are not in the project files.
5. Treats usage stats as **personal data** — do not generalize one person's habits into "the team does X".
6. Mentions a team/workspace name and is friendly.

RavenClaw names:

| Claude | RavenClaw |
|---|---|
| `CLAUDE.md` | `AGENTS.md` first, then `RAVEN.md`, then `CLAUDE.md` (already loaded by `project-files.ts`) |
| `.claude/commands/` | `discoverSkills` (project / user / builtin) |
| `.claude/agents/` | `agentCatalog(cwd)` |
| `settings.json` hooks | `loadLifecycleHooks` / `.ravenclaw/hooks.json` |
| MCP servers | `config.mcp.servers` (names and transport only; no tokens) |
| Session history | `store.listSessions({ cwd })` for **this user, this workspace** |

---

## Locked decisions

| Topic | Choice |
|---|---|
| Surface | Slash `/team-onboarding` (alias `/onboard`). Same inject-prompt pattern as `/learn` |
| Facts | Mechanical `scanTeamOnboarding(...)` returns JSON. The model does not invent scan facts |
| Guide | Three sections in the assistant reply. Do not write a file unless the human confirms via AskUser |
| Privacy | Usage block is labeled "your last N days in this workspace". Never "the team usually…" |
| `dontAsk` / headless | Print the formatted guide. Do not call AskUser. Do not run setup commands |
| Scope | One workspace (`cwd`). No company backend, no other users' session DBs |

---

## 1. Scan (mechanical)

`packages/core/src/onboarding/scan.ts`

```ts
export const ONBOARDING_USAGE_DAYS = 30

export type OnboardingScan = {
  teamName: string
  projectFiles: { relPath: string; kind: 'AGENTS.md' | 'RAVEN.md' | 'CLAUDE.md' }[]
  skills: { name: string; source: 'builtin' | 'user' | 'project'; disabled?: boolean; stale?: boolean }[]
  agents: { id: string; displayName: string }[]
  hookEvents: string[]
  mcpServers: { name: string; transport: string }[]
  usage: {
    label: string
    days: number
    sessionCount: number
    slashCounts: { name: string; count: number }[]
  }
  missing: string[]
}

export async function scanTeamOnboarding(opts: {
  cwd: string
  home: string
  store: SessionStore
  now?: () => number
}): Promise<OnboardingScan>
```

Rules:

- `teamName`: first `# ` heading in the nearest project `AGENTS.md` / `RAVEN.md` / `CLAUDE.md`. Else git remote basename. Else `'this workspace'`.
- `projectFiles`: existing instruction files under `cwd` (not `~`). Relpaths posix.
- `skills`: `discoverSkills(cwd, home)` — names only, no skill body.
- `agents`: `agentCatalog(cwd)` — id + displayName.
- `hookEvents`: lifecycle events that have at least one hook from `loadLifecycleHooks(cwd, home)`.
- `mcpServers`: `loadConfig` / passed-in config `mcp.servers` — `name` + `type ?? 'stdio'`. Never command args, env, headers, or oauth secrets.
- `usage`: sessions with `cwd` equal to `opts.cwd`, `updatedAt >= now - 30d`, `parentSessionId` null. Count user rows whose text starts with `/`. Top slashes only (max 8). `label` is exactly `your last ${days} days in this workspace`.
- `missing`: mechanical strings only, e.g. `no AGENTS.md/RAVEN.md/CLAUDE.md in cwd`, `no MCP servers in config`, `no project skills`. Do not invent "you should add Linear".

---

## 2. Slash + frozen prompt

`packages/cli/src/commands.ts`:

```
{ name: 'team-onboarding', aliases: ['onboard'], usage: '/team-onboarding', summary: 'walk a new teammate through this workspace' }
```

Ink and OpenTUI: `case 'team-onboarding':` run a turn with `ONBOARDING_PROMPT` plus a fenced JSON dump of the scan (no secrets). Same as `/learn` calling `runTurn(LEARN_PROMPT)`.

`ONBOARDING_PROMPT` (frozen, short — **not** the Claude blog prompt):

```
Walk this human through onboarding for this RavenClaw workspace.
Use only the JSON facts in the following scan. Do not invent rules, skills, MCP servers, or git remotes.
Structure the reply as: (1) usage context using the scan.usage.label, (2) setup checklist with done/missing from the scan, (3) team information quoted only from projectFiles — if those files were not read, say so and do not fabricate tips.
Greet using scan.teamName.
If askUserHost is true, use AskUser for at most one missing item at a time. If they decline, skip it.
If askUserHost is false, print the guide and stop. Do not run install commands in dontAsk/headless.
Do not write ONBOARDING.md unless the human explicitly asks.
```

The host prepends `\n\nscan:\n\`\`\`json\n${JSON.stringify(scan)}\n\`\`\``.

---

## 3. Interactive walk (model, not new UI)

- Default TUI (`askUserHost`): AskUser for one missing item. The model may use existing tools (`Read` on AGENTS.md, `/mcp` facts already in scan). It must not `Bash` install scripts unless leftover-ask allows and the human said yes.
- `dontAsk` / `raven exec` / Slack / Discord: guide text only.
- No new Ink panel. No new skill file on disk unless the human asks.

Optional file: if the human says write it, `Write` `.ravenclaw/ONBOARDING.md` (leftover-ask like any Write). Not the default.

---

## 4. Privacy

- Only sessions in **this** `SessionStore` for **this** `cwd`.
- Do not name other people. Do not say "the team spends 65% of time coding".
- Slash counts are this user's local history.
- Scan JSON must not include message bodies, API keys, or MCP env.

---

## 5. Tests

Targeted `bun test` only.

| File | Cases |
|---|---|
| `packages/core/src/onboarding/scan.test.ts` | missing project file → `missing` includes the no-instruction string; skill names only; MCP env not in JSON; usage label exact; slash counts from this cwd only |
| `packages/cli/src/commands.test.ts` | `/team-onboarding` and `/onboard` parse; `SLASH_HELP` contains the name |
| `packages/cli/src/opentui-app.test.ts` | `/team-onboarding` starts a turn whose prompt contains `Walk this human` and `"teamName"` |

---

## 6. Out of scope

- Copying Claude's skill prompt or `.claude/commands/team-onboarding.md`
- Company-wide telemetry or other developers' machines
- `raven mcp add` installer
- New Team OS product / marketplace
- Writing ONBOARDING.md by default
- Discord/Slack-specific onboarding copy

---

## Done when

1. `/team-onboarding` in Ink/OpenTUI starts a turn with the frozen prompt + scan JSON.
2. Scan never includes MCP secrets or other-cwd sessions.
3. `dontAsk` does not AskUser.
4. The model is instructed not to invent skills or rules absent from the scan.
