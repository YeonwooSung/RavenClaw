# Official Claude skills gap — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the official-vs-builtin audit and keep RavenClaw from copying or kitchen-sinking `anthropics/skills`.

**Architecture:** The official repo is a Claude.ai plugin marketplace (document + example + product skills). RavenClaw builtins are eight short skills under `packages/core/src/skills/builtin/` (six coding-loop plus user-picked `frontend-design` and `mcp-builder`). This plan does not port the 19 official folders. It locks the gap, the non-goals, and the optional follow-ups that were added.

**Tech Stack:** Existing skill loader (`discoverSkills`, `builtinSkillsRoot`), `builtin.test.ts`, Apache-2.0 tree.

**Spec:** `docs/superpowers/specs/2026-09-13-official-claude-skills-gap.md`

## Global Constraints

- Clean-room: steal contracts, never copy official `SKILL.md`, scripts, or prompts.
- Proprietary document skills (`docx`/`pdf`/`pptx`/`xlsx`) must not enter the tree.
- Builtin `SKILL.md` must not contain `Claude` or `Anthropic`.
- Default builtin set stays the current six unless the user explicitly picks an optional skill.
- No marketplace, no computer-use, no 19-skill dump.

---

### Task 1: Keep the audit docs as the source of truth

**Files:**
- Already written: `docs/superpowers/specs/2026-09-13-official-claude-skills-gap.md`
- Already written: `docs/superpowers/plans/2026-09-13-official-claude-skills-gap.md`

**Interfaces:**
- Consumes: official list of 19 names from `anthropics/skills` `main` @ `34040c9`
- Produces: locked disposition table in the spec

- [ ] **Step 1: Confirm the builtin test still pins exactly six names**

Run: `bun test packages/core/src/skills/builtin.test.ts`

Expected: PASS. `REQUIRED = ['review', 'test', 'commit', 'debug', 'tdd', 'plan']`.

- [ ] **Step 2: Do not add official skill folders**

Do not create `packages/core/src/skills/builtin/{docx,pdf,pptx,xlsx,skill-creator,...}`.

- [ ] **Step 3: Stop unless the user picks an optional skill**

If they pick nothing, this plan is done after the docs are committed (only when they ask to commit).

If they pick `frontend-design` and/or `mcp-builder`, continue to Task 2 / Task 3.

---

### Task 2 (optional): Clean-room `frontend-design` builtin

Only if the user says to add it.

**Files:**
- Create: `packages/core/src/skills/builtin/frontend-design/SKILL.md`
- Modify: `packages/core/src/skills/builtin.test.ts` (`REQUIRED` gains `'frontend-design'`)

**Interfaces:**
- Consumes: RavenClaw skill frontmatter (`name`, `description`, optional `allowed-tools`)
- Produces: a short original skill (description ≤ 60 chars for the index clip)

- [ ] **Step 1: Extend the builtin name list in the test first**

```ts
const REQUIRED = ['review', 'test', 'commit', 'debug', 'tdd', 'plan', 'frontend-design']
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test packages/core/src/skills/builtin.test.ts`

Expected: FAIL because `frontend-design` is missing from the directory listing.

- [ ] **Step 3: Write an original SKILL.md**

Contract only (do not paste official prose):

- Trigger: new UI or reshaping an existing UI.
- Ask for one aesthetic direction (type, color, motion) before generating screens.
- Avoid generic “AI slop” defaults (Inter, purple gradient, identical card grids).
- No vendor brand strings.

`allowed-tools`: `[Read, Grep, Glob, Edit, Write, ApplyPatch]`

- [ ] **Step 4: Re-run builtin tests**

Run: `bun test packages/core/src/skills/`

Expected: PASS. Markdown must not contain `Claude` or `Anthropic`.

- [ ] **Step 5: Commit only if asked**

```bash
git add packages/core/src/skills/builtin/frontend-design/SKILL.md packages/core/src/skills/builtin.test.ts
git commit -m "feat: add clean-room frontend-design builtin skill"
```

---

### Task 3 (optional): Clean-room `mcp-builder` builtin

Only if the user says to add it.

**Files:**
- Create: `packages/core/src/skills/builtin/mcp-builder/SKILL.md`
- Modify: `packages/core/src/skills/builtin.test.ts` (`REQUIRED` gains `'mcp-builder'`)

**Interfaces:**
- Consumes: RavenClaw MCP config shape (`name` + `transport`; no env/headers/oauth/command args in scans)
- Produces: a short original skill for writing a local MCP server this CLI can load

- [ ] **Step 1: Extend `REQUIRED` and watch the test fail**

Same TDD pattern as Task 2.

- [ ] **Step 2: Write an original SKILL.md**

Contract only:

- When to use: user wants a new MCP server for this workspace.
- Prefer stdio. One tool = one job. Schema required.
- Config lives in RavenClaw config; never put secrets in skill text or onboarding scan JSON.
- Point at existing `/mcp` and config docs; do not invent a marketplace.

`allowed-tools`: `[Read, Grep, Glob, Edit, Write, ApplyPatch, Bash]`

- [ ] **Step 3: Re-run `bun test packages/core/src/skills/`**

Expected: PASS. No `Claude` / `Anthropic` strings.

- [ ] **Step 4: Commit only if asked**

```bash
git add packages/core/src/skills/builtin/mcp-builder/SKILL.md packages/core/src/skills/builtin.test.ts
git commit -m "feat: add clean-room mcp-builder builtin skill"
```

---

## Self-review

- Every official name has a disposition in the spec.
- No task copies official skill files.
- Optional tasks stay gated on an explicit user pick.
