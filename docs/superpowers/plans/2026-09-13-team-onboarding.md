# Team-onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/team-onboarding` that scans this workspace and walks a new teammate through what is actually configured — without inventing rules or leaking secrets.

**Architecture:** Mechanical `scanTeamOnboarding` builds a JSON fact sheet (project files, skills, agents, hooks, MCP names, this user's slash counts). The slash command injects a short frozen prompt plus that JSON, same as `/learn`. The model walks the human; `dontAsk` prints only.

**Tech Stack:** Bun, TypeScript, existing `discoverSkills`, `agentCatalog`, `loadLifecycleHooks` paths, `SessionStore.listSessions`, Ink/OpenTUI `runTurn`.

**Spec:** `docs/superpowers/specs/2026-09-13-ravenclaw-team-onboarding.md`

## Global Constraints

- Steal contracts. Do not copy Claude skill text from the tistory post.
- One `queryLoop`. Hosts still only call `submitMessage`.
- Usage stats are personal: label must be `your last N days in this workspace`.
- Scan JSON must not include MCP env, headers, oauth, command args, or message bodies.
- Targeted `bun test` only. Never full-repo `bun test`.
- Do not write `.ravenclaw/ONBOARDING.md` unless the human asks.

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/onboarding/scan.ts` | `scanTeamOnboarding`, types |
| `packages/core/src/hooks/lifecycle.ts` | export `listConfiguredHookEvents` |
| `packages/core/src/index.ts` | export scan + types |
| `packages/cli/src/commands.ts` | slash + `ONBOARDING_PROMPT` + `formatOnboardingTurn` |
| `packages/cli/src/app.tsx` | `case 'team-onboarding'` |
| `packages/cli/src/opentui-app.ts` | same |

---

### Task 1: Hook event listing

**Files:**
- Modify: `packages/core/src/hooks/lifecycle.ts`
- Test: `packages/core/src/hooks/lifecycle.test.ts`

**Interfaces:**
- Consumes: existing `readHookFiles` / `specsFor` / `LIFECYCLE_EVENTS` (keep them file-private except `LIFECYCLE_EVENTS` already exported)
- Produces: `listConfiguredHookEvents(cwd: string, home: string): string[]` — event names that have at least one hook, stable order of `LIFECYCLE_EVENTS`

- [ ] **Step 1: Write the failing test**

In `packages/core/src/hooks/lifecycle.test.ts` add:

```ts
import { listConfiguredHookEvents } from './lifecycle'

test('listConfiguredHookEvents names only events that have a command', () => {
  const home = tempDir('ravenclaw-onboard-hooks-home-')
  const cwd = tempDir('ravenclaw-onboard-hooks-cwd-')
  writeHooks(home, {
    hooks: { Stop: [{ command: 'true' }], PostToolUse: [{ command: 'true', matcher: 'Bash' }] },
  })
  expect(listConfiguredHookEvents(cwd, home)).toEqual(['PostToolUse', 'Stop'])
})
```

Use the file's existing `writeHooks` helper (or the same `writeFileSync(join(dir, 'hooks.json'), ...)` pattern already in that file). Event order must follow `LIFECYCLE_EVENTS`, not file order.

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/hooks/lifecycle.test.ts`  
Expected: FAIL — `listConfiguredHookEvents` is not exported.

- [ ] **Step 3: Implement**

```ts
export function listConfiguredHookEvents(cwd: string, home: string): string[] {
  const files = readHookFiles(cwd, home)
  return LIFECYCLE_EVENTS.filter((event) => specsFor(files, event).length > 0)
}
```

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/hooks/lifecycle.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/hooks/lifecycle.ts packages/core/src/hooks/lifecycle.test.ts
git commit -m "feat: list configured lifecycle hook events for onboarding scan"
```

---

### Task 2: `scanTeamOnboarding`

**Files:**
- Create: `packages/core/src/onboarding/scan.ts`
- Test: `packages/core/src/onboarding/scan.test.ts`
- Modify: `packages/core/src/index.ts` — export `scanTeamOnboarding`, `ONBOARDING_USAGE_DAYS`, `OnboardingScan`

**Interfaces:**
- Consumes: `discoverSkills`, `agentCatalog`, `listConfiguredHookEvents`, `SessionStore.listSessions` / `loadMessages`, `McpConfig`
- Produces: types and function exactly as in the spec §1

`teamName`: first markdown `# ` heading in `join(cwd, 'AGENTS.md')` else `RAVEN.md` else `CLAUDE.md`. Else `git -C cwd remote get-url origin` basename with `.git` stripped (timeout 5s, ignore fail). Else `'this workspace'`.

`usage.label` must be exactly `` `your last ${ONBOARDING_USAGE_DAYS} days in this workspace` ``.

Slash parse: user message `text.trim()` matching `/^\/([A-Za-z][\w-]*)/`. Count those names. Return top 8 by count desc, then name asc. Skip `/team-onboarding` itself.

`missing` allowed strings (use these exact phrases):

- `'no AGENTS.md/RAVEN.md/CLAUDE.md in cwd'`
- `'no MCP servers in config'`
- `'no project skills'`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMemoryStore } from '../session/memory-store'
import { ONBOARDING_USAGE_DAYS, scanTeamOnboarding } from './scan'

function tempCwd(): string {
  const dir = join(tmpdir(), `raven-onboard-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('scanTeamOnboarding', () => {
  test('does not invent files and never copies MCP secrets', async () => {
    const cwd = tempCwd()
    const home = tempCwd()
    const store = createMemoryStore()
    const scan = await scanTeamOnboarding({
      cwd,
      home,
      store,
      mcp: {
        servers: [
          {
            name: 'github',
            type: 'stdio',
            command: 'secret-bin',
            env: { GITHUB_TOKEN: 'tok_live' },
          },
        ],
      },
    })
    expect(scan.teamName).toBe('this workspace')
    expect(scan.projectFiles).toEqual([])
    expect(scan.missing).toContain('no AGENTS.md/RAVEN.md/CLAUDE.md in cwd')
    expect(scan.missing).toContain('no project skills')
    expect(JSON.stringify(scan)).not.toContain('tok_live')
    expect(JSON.stringify(scan)).not.toContain('secret-bin')
    expect(scan.mcpServers).toEqual([{ name: 'github', transport: 'stdio' }])
    expect(scan.usage.label).toBe(`your last ${ONBOARDING_USAGE_DAYS} days in this workspace`)
  })

  test('counts slashes only in this cwd', async () => {
    const cwd = tempCwd()
    const other = tempCwd()
    writeFileSync(join(cwd, 'AGENTS.md'), '# Acme\nBe kind.\n')
    mkdirSync(join(cwd, '.ravenclaw', 'skills', 'deploy'), { recursive: true })
    writeFileSync(join(cwd, '.ravenclaw', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: ship it\n---\n')
    const store = createMemoryStore()
    const here = {
      id: 'sess_here',
      cwd,
      parentSessionId: null as string | null,
      createdAt: 1,
      updatedAt: Date.now(),
      title: 'here',
      model: 'x',
      permissionMode: 'default' as const,
      funding: 'byok' as const,
    }
    const away = { ...here, id: 'sess_away', cwd: other }
    await store.createSession(here)
    await store.createSession(away)
    await store.persistUser({ sessionId: here.id, text: '/review please' })
    await store.persistUser({ sessionId: here.id, text: '/review again' })
    await store.persistUser({ sessionId: away.id, text: '/deploy secret' })
    const scan = await scanTeamOnboarding({ cwd, home: tempCwd(), store, mcp: { servers: [] } })
    expect(scan.teamName).toBe('Acme')
    expect(scan.projectFiles[0]?.kind).toBe('AGENTS.md')
    expect(scan.skills.some((s) => s.name === 'deploy' && s.source === 'project')).toBe(true)
    expect(scan.usage.sessionCount).toBe(1)
    expect(scan.usage.slashCounts).toEqual([{ name: 'review', count: 2 }])
    expect(scan.usage.slashCounts.some((row) => row.name === 'deploy')).toBe(false)
    expect(scan.missing).not.toContain('no AGENTS.md/RAVEN.md/CLAUDE.md in cwd')
    expect(scan.missing).toContain('no MCP servers in config')
  })
})
```

Adjust `persistUser` / `createSession` to match the real `SessionStore` + `SessionRecord` fields in `packages/core/src/types.ts`. If `persistUser` needs more fields, copy the helper from `packages/core/src/session/memory-store` tests.

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/onboarding/scan.test.ts`  
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `scan.ts`**

`git remote`:

```ts
const r = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000 })
```

Only use stdout if `r.status === 0`.

`loadMessages` for each listed session; if the store has no `loadMessages`, skip slash counts (sessionCount still from list).

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/onboarding/scan.test.ts packages/core/src/hooks/lifecycle.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/onboarding/scan.ts packages/core/src/onboarding/scan.test.ts packages/core/src/index.ts
git commit -m "feat: scan workspace facts for /team-onboarding"
```

---

### Task 3: Slash command + frozen prompt

**Files:**
- Modify: `packages/cli/src/commands.ts`
- Test: `packages/cli/src/commands.test.ts`

**Interfaces:**
- Consumes: none
- Produces:

```ts
export const ONBOARDING_PROMPT = [
  'Walk this human through onboarding for this RavenClaw workspace.',
  'Use only the JSON facts in the following scan. Do not invent rules, skills, MCP servers, or git remotes.',
  'Structure the reply as: (1) usage context using the scan.usage.label, (2) setup checklist with done/missing from the scan, (3) team information quoted only from projectFiles — if those files were not read, say so and do not fabricate tips.',
  'Greet using scan.teamName.',
  'If askUserHost is true, use AskUser for at most one missing item at a time. If they decline, skip it.',
  'If askUserHost is false, print the guide and stop. Do not run install commands in dontAsk/headless.',
  'Do not write ONBOARDING.md unless the human explicitly asks.',
].join(' ')

export function formatOnboardingTurn(scan: OnboardingScan): string {
  return `${ONBOARDING_PROMPT}\n\nscan:\n\`\`\`json\n${JSON.stringify(scan)}\n\`\`\``
}
```

Slash row (insert after `interview`):

```ts
{
  name: 'team-onboarding',
  aliases: ['onboard'],
  usage: '/team-onboarding',
  summary: 'walk a new teammate through this workspace',
},
```

- [ ] **Step 1: Write the failing tests**

In `commands.test.ts` table add:

```ts
['/team-onboarding', { type: 'command', name: 'team-onboarding' }],
['/onboard', { type: 'command', name: 'team-onboarding' }],
```

And:

```ts
expect(SLASH_HELP).toContain('/team-onboarding')
expect(ONBOARDING_PROMPT).toContain('Do not invent')
expect(formatOnboardingTurn({
  teamName: 'Acme',
  projectFiles: [],
  skills: [],
  agents: [],
  hookEvents: [],
  mcpServers: [],
  usage: { label: 'your last 30 days in this workspace', days: 30, sessionCount: 0, slashCounts: [] },
  missing: [],
}).startsWith('Walk this human')).toBe(true)
```

Import `ONBOARDING_PROMPT` and `formatOnboardingTurn`.

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/cli/src/commands.test.ts`  
Expected: FAIL — name unknown / exports missing.

- [ ] **Step 3: Implement the command table + helpers**

- [ ] **Step 4: Re-run**

Run: `bun test packages/cli/src/commands.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands.ts packages/cli/src/commands.test.ts
git commit -m "feat: add /team-onboarding slash and frozen prompt"
```

---

### Task 4: Wire Ink + OpenTUI

**Files:**
- Modify: `packages/cli/src/app.tsx`
- Modify: `packages/cli/src/opentui-app.ts`
- Test: `packages/cli/src/opentui-app.test.ts`

**Interfaces:**
- Consumes: `scanTeamOnboarding`, `formatOnboardingTurn`
- Produces: `case 'team-onboarding'` starts `runTurn(formatOnboardingTurn(scan))`

Ink (`app.tsx`), next to `learn` / `interview`:

```ts
case 'team-onboarding': {
  void (async () => {
    const scan = await scanTeamOnboarding({
      cwd: runtimeRef.current.cwd,
      home: ravenclawHome(),
      store: runtimeRef.current.store,
      mcp: runtimeRef.current.config.mcp ?? { servers: [] },
    })
    await runTurn(formatOnboardingTurn(scan))
  })()
  return
}
```

Use the same `ravenclawHome` import the file already has (or add it from `@ravenclaw/core`). If `runtime.config` is not on `CliRuntime`, read `loadConfig` the way `/mcp` already does in this file.

OpenTUI: same, `await runTurn(...)`.

`dontAsk` is already on the engine; the frozen prompt tells the model not to AskUser. Do not special-case further.

- [ ] **Step 1: Write the failing OpenTUI test**

```ts
test('/team-onboarding starts a turn with the scan JSON', async () => {
  const prompts: string[] = []
  const engine = fakeEngine(makeSession(), async function* (text: string) {
    prompts.push(text)
    return emptyTurn
  })
  const written: string[] = []
  const code = await runOpenTuiApp(fakeRuntime(engine, { store: fakeStore() }), {
    input: asyncLines('/team-onboarding', '/quit'),
    write: (chunk) => {
      written.push(chunk)
    },
  })
  expect(code).toBe(0)
  expect(prompts[0] ?? '').toContain('Walk this human')
  expect(prompts[0] ?? '').toContain('"teamName"')
  expect(written.join('')).not.toContain('unknown command')
})
```

Adapt `fakeEngine` / `emptyTurn` / `fakeStore` to the helpers already in `opentui-app.test.ts`. If `submitMessage` is how `runTurn` works, assert on that (same pattern as the `/learn` test if one exists; otherwise this new test).

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/cli/src/opentui-app.test.ts`  
Expected: FAIL — unknown command or empty prompts.

- [ ] **Step 3: Wire both hosts**

Also add the command to any `COMPLETION_COMMANDS` / help snapshot that lists slash names (search `interview` next to completions).

- [ ] **Step 4: Re-run**

Run: `bun test packages/cli/src/opentui-app.test.ts packages/cli/src/commands.test.ts packages/cli/src/app.test.ts packages/core/src/onboarding/scan.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/app.tsx packages/cli/src/opentui-app.ts packages/cli/src/opentui-app.test.ts packages/cli/src/completions.ts packages/cli/src/help.ts
git commit -m "feat: run /team-onboarding from Ink and OpenTUI"
```

---

## Spec coverage

| Spec | Task |
|---|---|
| §1 Scan facts + privacy | Task 2 |
| hookEvents | Task 1 |
| §2 Slash + frozen prompt | Task 3 |
| §3 Interactive / dontAsk | Task 4 (prompt) + existing AskUser |
| §5 Tests | Tasks 1–4 |
| Done-when | Task 4 |

## Placeholder scan

No TBD. `persistUser` field list must be copied from existing session tests in Task 2 if the sketched session object fails typecheck.

## Type consistency

- `OnboardingScan` / `scanTeamOnboarding` as spec §1
- `ONBOARDING_USAGE_DAYS = 30`
- `formatOnboardingTurn(scan: OnboardingScan): string`
- Slash name `team-onboarding`, alias `onboard`
