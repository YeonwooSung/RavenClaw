# Instruction-files `/config` — Implementation Plan

I'm using the writing-plans skill to create the implementation plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator pick `claude` / `agents-fallback` / `both` via `/config instructions`, persist that scalar in `~/.ravenclaw/config.yaml`, and have every new session initialize the context-tier project walk from it.

**Architecture:** `InstructionFilesMode` on `ResolvedConfig`. Surgical yaml upsert (never a full dump). `loadProjectFiles` / `loadNearestSubdirAgents` take an optional mode (default `'both'`). Session start and `/reload` pass `config.instructionFiles`. `/config instructions <mode>` persist-then-applies (write, mutate runtime, `setInstructionFiles`, reload system). No schema bump. No new tool.

**Tech Stack:** Bun, TypeScript, existing `parseYamlMap` / `loadConfig` / `buildSystemParts` / shared slash dispatch.

**Spec:** `docs/superpowers/specs/2026-09-21-instruction-files-config.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` stays the only non-`submitMessage` closer. `/config` is a slash, not a tool and not a fourth closer.
- Default prefix stays small and frozen. No new tool.
- `dontAsk` never becomes `bypass`.
- BYOK. Ads never touch BYOK.
- Clean-room. **No web UI, Prisma Task, Socket.IO, wiki, CLAUDE.local.md, user `~/.ravenclaw/CLAUDE.md`, project-level config.yaml, `--instruction-files` flag, AskUser/TUI widget picker, schema bump.**
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push.
- Caps stay 40k/file and 60k total. `@include` rules unchanged. `raven init` still writes `AGENTS.md`.

### Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification only.

1. **`InstructionFilesMode` lives in `packages/core/src/config.ts`.** Export `INSTRUCTION_FILES_MODES`, `isInstructionFilesMode`, the type, `writeHomeInstructionFiles`, and `upsertYamlTopLevelScalar` (from `config/yaml.ts`) through `packages/core/src/index.ts`.

2. **`RavenClawConfig.instructionFiles` is required** and `defaultConfig()` returns `'both'`. `parseConfigYaml` sets the field only for a valid token. Unknown / omitted yaml → `loadConfig` uses `'both'`.

3. **Upsert throw message** is exactly `` `${key} is not a scalar` ``. Slash maps any throw / rename fail to notice `failed to write config.yaml` (do not leak the throw).

4. **Tmp path** is `join(home, 'config.yaml.tmp')` then `renameSync` onto `join(home, 'config.yaml')`.

5. **`loadProjectFiles(cwd, mode = 'both')` and `loadNearestSubdirAgents(cwd, filePath, seen, mode = 'both')`.** Omitted mode ≡ `'both'`.

6. **`setInstructionFiles(mode: InstructionFilesMode): void`** is required on `SessionEngine`. Wrappers (`log.ts`, CLI `engine.ts`) forward it. `dispatch.test.ts` `fakeEngine` implements it (records the last mode). Other `as SessionEngine` stubs may omit it.

7. **`QueryLoopOptions.instructionFiles?` and `ToolContext.instructionFiles?`.** Parent engine copies the mutable field onto every `loopOpts`. `phases.ts` copies `state.instructionFiles` onto `ctx` next to `registerChildEngine`. `agent.ts` copies `ctx.instructionFiles` onto child `engineOpts` when set. `startDetachedReview` copies the parent field onto `childOpts`.

8. **Chooser / usage strings are locked** (spec ruling 12). Helper `formatInstructionFilesChooser(mode: InstructionFilesMode): string` in `dispatch.ts`. Usage: `usage: /config instructions claude|agents-fallback|both`.

9. **Worktree.** Implement in this worktree (`/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/instruction-files-config`) or a later isolated worktree. Never on `main`.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/config.ts` | type, default, parse, `loadConfig`, `writeHomeInstructionFiles`, `isInstructionFilesMode` |
| `packages/core/src/config/yaml.ts` | `upsertYamlTopLevelScalar` |
| `packages/core/src/config/yaml.test.ts` | upsert matrix |
| `packages/core/src/config.test.ts` | parse / load / write |
| `packages/core/src/prompt/project-files.ts` | per-dir mode filter |
| `packages/core/src/prompt/project-files.test.ts` | three modes + always-on slots |
| `packages/core/src/prompt/subdir-agents.ts` | name order by mode |
| `packages/core/src/prompt/subdir-agents.test.ts` | claude / fallback / both |
| `packages/core/src/prompt/builder.ts` | pass mode into `loadProjectFiles` |
| `packages/core/src/prompt/builder.test.ts` | walk respects `instructionFiles` |
| `packages/core/src/types.ts` | options, loop, engine method, ToolContext |
| `packages/core/src/loop/session-engine.ts` | mutable field, `setInstructionFiles`, copy onto loopOpts |
| `packages/core/src/loop/phases.ts` | subdir + ToolContext |
| `packages/core/src/tools/agent.ts` | child engine copy |
| `packages/core/src/index.ts` | exports |
| `packages/core/src/log.ts` | forward `setInstructionFiles` |
| `packages/cli/src/engine.ts` | boot pass-through + wrapper forward |
| `packages/sdk/src/index.ts` | boot pass-through |
| `packages/cli/src/config-print.ts` | dump line |
| `packages/cli/src/config-print.test.ts` | dump line |
| `packages/cli/src/slash/dispatch.ts` | chooser + persist-then-apply |
| `packages/cli/src/slash/dispatch.test.ts` | slash matrix |
| `packages/cli/src/commands.ts` | usage / summary |
| docs listed in Task 5 | honesty |

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 I0 yaml + type + write | `config.ts`, `config/yaml.ts`, `config/yaml.test.ts` (create), `config.test.ts`, `index.ts` (type + helpers) |
| 2 I1 walk + subdir | `project-files.ts`, `project-files.test.ts`, `subdir-agents.ts`, `subdir-agents.test.ts` |
| 3 I2 thread | `builder.ts`, `builder.test.ts`, `types.ts`, `session-engine.ts`, `phases.ts`, `agent.ts`, `log.ts`, CLI `engine.ts` boot+wrapper, `sdk/src/index.ts` |
| 4 I3 `/config` | `config-print.ts`, `config-print.test.ts`, `slash/dispatch.ts`, `slash/dispatch.test.ts`, `commands.ts` |
| 5 I4 docs | spec Status/board; SLASH_COMMANDS / `.ko.md`; ARCHITECTURE / `.ko.md`; README yaml example; CHANGELOG Unreleased |

Task 1 first (type + persist primitive). Task 2 after 1 (mode type). Task 3 after 1–2 (`loadProjectFiles` signature + type). Task 4 after 1 and 3 (`writeHomeInstructionFiles` + `setInstructionFiles` + `buildSystemParts`). Task 5 last.

---

### Task 1: I0 mode type, yaml upsert, `writeHomeInstructionFiles`

**Files:**
- Modify: `packages/core/src/config.ts` (`RavenClawConfig`, `defaultConfig`, `parseConfigYaml`, `loadConfig`)
- Modify: `packages/core/src/config/yaml.ts` (add `upsertYamlTopLevelScalar` at the bottom, using existing private helpers)
- Create: `packages/core/src/config/yaml.test.ts`
- Modify: `packages/core/src/config.test.ts` (`defaultConfig` expect; parse/load/write cases)
- Modify: `packages/core/src/index.ts` (export type + helpers next to `loadConfig`)

**Interfaces:**
- Consumes: `parseYamlMap`, `readFileSync` / `writeFileSync` / `renameSync` / `existsSync`
- Produces:
  ```ts
  export const INSTRUCTION_FILES_MODES = ['claude', 'agents-fallback', 'both'] as const
  export type InstructionFilesMode = (typeof INSTRUCTION_FILES_MODES)[number]
  export function isInstructionFilesMode(value: string): value is InstructionFilesMode
  export function upsertYamlTopLevelScalar(text: string, key: string, value: string): string
  export function writeHomeInstructionFiles(home: string, mode: InstructionFilesMode): void
  ```
  `RavenClawConfig.instructionFiles: InstructionFilesMode` (required). `defaultConfig().instructionFiles === 'both'`. `ResolvedConfig.instructionFiles` always set.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/config/yaml.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { upsertYamlTopLevelScalar } from './yaml'

describe('upsertYamlTopLevelScalar', () => {
  test('empty text writes key and trailing newline', () => {
    expect(upsertYamlTopLevelScalar('', 'instructionFiles', 'claude')).toBe(
      'instructionFiles: claude\n',
    )
  })

  test('preserves comments and other keys', () => {
    const input = ['# house', 'model: x', 'provider: anthropic', ''].join('\n')
    const out = upsertYamlTopLevelScalar(input, 'instructionFiles', 'claude')
    expect(out.startsWith('# house\n')).toBe(true)
    expect(out).toContain('model: x\n')
    expect(out).toContain('provider: anthropic\n')
    expect(out).toContain('instructionFiles: claude\n')
    expect((out.match(/^instructionFiles:/m) ?? []).length).toBe(1)
  })

  test('replaces the first top-level scalar occurrence', () => {
    const out = upsertYamlTopLevelScalar(
      'instructionFiles: both\nmodel: x\n',
      'instructionFiles',
      'claude',
    )
    expect(out).toBe('instructionFiles: claude\nmodel: x\n')
  })

  test('throws when the key is a nested map', () => {
    expect(() =>
      upsertYamlTopLevelScalar('instructionFiles:\n  foo: 1\n', 'instructionFiles', 'both'),
    ).toThrow('instructionFiles is not a scalar')
  })
})
```

In `packages/core/src/config.test.ts`, add to the existing `defaultConfig` test:

```ts
expect(cfg.instructionFiles).toBe('both')
```

Add cases (same file, after `describe('loadConfig')` missing-files test is fine):

```ts
test('parseConfigYaml accepts instructionFiles tokens and ignores unknown', () => {
  expect(parseConfigYaml('instructionFiles: claude\n').instructionFiles).toBe('claude')
  expect(parseConfigYaml('instructionFiles: agents-fallback\n').instructionFiles).toBe(
    'agents-fallback',
  )
  expect(parseConfigYaml('instructionFiles: both\n').instructionFiles).toBe('both')
  expect(parseConfigYaml('instructionFiles: nope\n').instructionFiles).toBeUndefined()
  expect(parseConfigYaml('model: x\n').instructionFiles).toBeUndefined()
})

test('loadConfig defaults instructionFiles to both', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  const home = tempHome()
  expect(loadConfig({ home }).instructionFiles).toBe('both')
  writeFileSync(join(home, 'config.yaml'), 'provider: anthropic\ninstructionFiles: claude\n')
  expect(loadConfig({ home }).instructionFiles).toBe('claude')
  writeFileSync(join(home, 'config.yaml'), 'provider: anthropic\ninstructionFiles: nope\n')
  expect(loadConfig({ home }).instructionFiles).toBe('both')
})

test('writeHomeInstructionFiles upserts without dropping comments', () => {
  const home = tempHome()
  writeFileSync(join(home, 'config.yaml'), '# keep\nprovider: anthropic\n')
  writeHomeInstructionFiles(home, 'claude')
  const text = readFileSync(join(home, 'config.yaml'), 'utf8')
  expect(text).toContain('# keep\n')
  expect(text).toContain('provider: anthropic\n')
  expect(text).toContain('instructionFiles: claude\n')
  writeHomeInstructionFiles(home, 'both')
  expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('instructionFiles: both\n')
  expect((readFileSync(join(home, 'config.yaml'), 'utf8').match(/^instructionFiles:/m) ?? []).length).toBe(1)
})
```

Import `writeHomeInstructionFiles` and `readFileSync` (add `readFileSync` to the existing `node:fs` import).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/config/yaml.test.ts ./packages/core/src/config.test.ts`

Expected: FAIL — `upsertYamlTopLevelScalar` / `instructionFiles` / `writeHomeInstructionFiles` missing.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/config.ts`, next to `TERMINAL_BACKENDS`:

```ts
export const INSTRUCTION_FILES_MODES = ['claude', 'agents-fallback', 'both'] as const
export type InstructionFilesMode = (typeof INSTRUCTION_FILES_MODES)[number]

export function isInstructionFilesMode(value: string): value is InstructionFilesMode {
  return (INSTRUCTION_FILES_MODES as readonly string[]).includes(value)
}
```

Add `instructionFiles: InstructionFilesMode` to `RavenClawConfig`. `defaultConfig()` sets `instructionFiles: 'both'`.

In `parseConfigYaml`, after the `permissionMode` block:

```ts
  const instructionFiles = asString(raw.instructionFiles)
  if (instructionFiles !== undefined && isInstructionFilesMode(instructionFiles)) {
    out.instructionFiles = instructionFiles
  }
```

In `loadConfig` `resolved` object, add `instructionFiles: parsed.instructionFiles ?? base.instructionFiles`.

Import `upsertYamlTopLevelScalar` from `./config/yaml`. Add:

```ts
export function writeHomeInstructionFiles(home: string, mode: InstructionFilesMode): void {
  const path = join(home, 'config.yaml')
  const tmp = join(home, 'config.yaml.tmp')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const next = upsertYamlTopLevelScalar(current, 'instructionFiles', mode)
  writeFileSync(tmp, next)
  renameSync(tmp, path)
}
```

Add `renameSync` to the `node:fs` import.

In `packages/core/src/config/yaml.ts`, export (use existing `isBlankOrComment`, `leadingSpaces`, `parseKeyedLine`, `nextMeaningful`):

```ts
export function upsertYamlTopLevelScalar(text: string, key: string, value: string): string {
  if (text === '') return `${key}: ${value}\n`
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let found = -1
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    if (isBlankOrComment(raw)) continue
    if (leadingSpaces(raw) !== 0) continue
    const parsed = parseKeyedLine(raw)
    if (!parsed || parsed.key !== key) continue
    found = i
    if (parsed.value === undefined) {
      const next = nextMeaningful(lines, i + 1)
      const nextIndent = next === undefined ? -1 : leadingSpaces(lines[next] ?? '')
      if (next !== undefined && nextIndent > 0) throw new Error(`${key} is not a scalar`)
    } else if (parsed.value !== null && typeof parsed.value === 'object') {
      throw new Error(`${key} is not a scalar`)
    }
    break
  }
  const replacement = `${key}: ${value}`
  if (found >= 0) lines[found] = replacement
  else lines.push(replacement)
  return `${lines.join(newline)}${newline}`
}
```

In `packages/core/src/index.ts`, extend the `./config` export:

```ts
export {
  defaultConfig,
  defaultModelForProvider,
  loadConfig,
  loadDotEnv,
  normalizeOpenAiBaseUrl,
  parseConfigYaml,
  resolveProviderModel,
  writeHomeInstructionFiles,
  isInstructionFilesMode,
  INSTRUCTION_FILES_MODES,
  OLLAMA_DEFAULT_HOST,
  OLLAMA_DEFAULT_MODEL,
  VLLM_DEFAULT_BASE_URL,
  VLLM_DEFAULT_MODEL,
} from './config'
export type {
  ConfigFlags,
  InstructionFilesMode,
  McpConfig,
  McpOAuthConfig,
  McpServerConfig,
  ProviderKind,
  RavenClawConfig,
  ResolvedConfig,
  ReviewConfig,
} from './config'
export { upsertYamlTopLevelScalar } from './config/yaml'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/config/yaml.test.ts ./packages/core/src/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/config/yaml.ts packages/core/src/config/yaml.test.ts packages/core/src/config.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat(core): persist instructionFiles in home config.yaml

Add claude | agents-fallback | both, surgical yaml upsert, and atomic home write.
EOF
)"
```

---

### Task 2: I1 `loadProjectFiles` and subdir name order

**Files:**
- Modify: `packages/core/src/prompt/project-files.ts`
- Modify: `packages/core/src/prompt/project-files.test.ts`
- Modify: `packages/core/src/prompt/subdir-agents.ts`
- Modify: `packages/core/src/prompt/subdir-agents.test.ts`

**Interfaces:**
- Consumes: `InstructionFilesMode` from `../config`
- Produces: `loadProjectFiles(cwd: string, mode?: InstructionFilesMode): string`; `loadNearestSubdirAgents(cwd, filePath, seen, mode?: InstructionFilesMode): string | undefined`

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/prompt/project-files.test.ts`, import `loadProjectFiles` stays. Add:

```ts
describe('loadProjectFiles instructionFiles mode', () => {
  test('claude skips AGENTS.md and AGENTS.local.md and keeps RAVEN slots', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.ravenclaw', 'rules'), { recursive: true })
    writeFileSync(join(dir, 'AGENTS.md'), 'AGENTS_ONLY\n')
    writeFileSync(join(dir, 'AGENTS.local.md'), 'AGENTS_LOCAL\n')
    writeFileSync(join(dir, 'CLAUDE.md'), 'CLAUDE_ONLY\n')
    writeFileSync(join(dir, 'RAVEN.local.md'), 'LOCAL_OVERLAY_MARKER\n')
    writeFileSync(join(dir, '.ravenclaw', 'rules', 'style.md'), 'RULE_STYLE_MARKER\n')
    const loaded = loadProjectFiles(dir, 'claude')
    expect(loaded).toContain('CLAUDE_ONLY')
    expect(loaded).toContain('LOCAL_OVERLAY_MARKER')
    expect(loaded).toContain('RULE_STYLE_MARKER')
    expect(loaded).not.toContain('AGENTS_ONLY')
    expect(loaded).not.toContain('AGENTS_LOCAL')
  })

  test('agents-fallback is per directory, not walk-global', () => {
    const parent = tempDir()
    const child = join(parent, 'nested')
    mkdirSync(child)
    writeFileSync(join(parent, 'AGENTS.md'), 'PARENT_AGENTS\n')
    writeFileSync(join(child, 'CLAUDE.md'), 'CHILD_CLAUDE\n')
    const loaded = loadProjectFiles(child, 'agents-fallback')
    expect(loaded).toContain('CHILD_CLAUDE')
    expect(loaded).toContain('PARENT_AGENTS')
  })

  test('agents-fallback in one dir with both files skips AGENTS and AGENTS.local', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'AGENTS.md'), 'AGENTS_ONLY\n')
    writeFileSync(join(dir, 'AGENTS.local.md'), 'AGENTS_LOCAL\n')
    writeFileSync(join(dir, 'CLAUDE.md'), 'CLAUDE_ONLY\n')
    const loaded = loadProjectFiles(dir, 'agents-fallback')
    expect(loaded).toContain('CLAUDE_ONLY')
    expect(loaded).not.toContain('AGENTS_ONLY')
    expect(loaded).not.toContain('AGENTS_LOCAL')
  })

  test('both and omitted mode load AGENTS and CLAUDE', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'AGENTS.md'), 'AGENTS_ONLY\n')
    writeFileSync(join(dir, 'CLAUDE.md'), 'CLAUDE_ONLY\n')
    expect(loadProjectFiles(dir, 'both')).toContain('AGENTS_ONLY')
    expect(loadProjectFiles(dir, 'both')).toContain('CLAUDE_ONLY')
    expect(loadProjectFiles(dir)).toContain('AGENTS_ONLY')
    expect(loadProjectFiles(dir)).toContain('CLAUDE_ONLY')
  })
})
```

In `packages/core/src/prompt/subdir-agents.test.ts`, add:

```ts
  test('claude mode skips AGENTS.md and injects CLAUDE.md', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, 'pkg'), { recursive: true })
    writeFileSync(join(cwd, 'pkg', 'AGENTS.md'), 'AGENTS_ONLY\n')
    expect(loadNearestSubdirAgents(cwd, join(cwd, 'pkg', 'a.ts'), new Set(), 'claude')).toBeUndefined()
    writeFileSync(join(cwd, 'pkg', 'CLAUDE.md'), 'CLAUDE_ONLY\n')
    const hit = loadNearestSubdirAgents(cwd, join(cwd, 'pkg', 'a.ts'), new Set(), 'claude')
    expect(hit).toContain('[AGENTS.md: pkg]')
    expect(hit).toContain('CLAUDE_ONLY')
    expect(hit).not.toContain('AGENTS_ONLY')
  })

  test('agents-fallback prefers CLAUDE.md over AGENTS.md in that directory', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, 'lib'), { recursive: true })
    writeFileSync(join(cwd, 'lib', 'AGENTS.md'), 'AGENTS_WINS\n')
    writeFileSync(join(cwd, 'lib', 'CLAUDE.md'), 'CLAUDE_ONLY\n')
    const hit = loadNearestSubdirAgents(cwd, join(cwd, 'lib', 'x.ts'), new Set(), 'agents-fallback')
    expect(hit).toContain('CLAUDE_ONLY')
    expect(hit).not.toContain('AGENTS_WINS')
  })
```

Existing tests omit `mode` and must keep passing (`both` order: AGENTS then RAVEN then CLAUDE).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/prompt/project-files.test.ts ./packages/core/src/prompt/subdir-agents.test.ts`

Expected: FAIL — extra argument unused; `claude` still loads `AGENTS_ONLY`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/prompt/project-files.ts`:

```ts
import type { InstructionFilesMode } from '../config'

export function loadProjectFiles(cwd: string, mode: InstructionFilesMode = 'both'): string {
  // existing body, collectProjectFiles(cwd, mode)
}

function collectProjectFiles(cwd: string, mode: InstructionFilesMode): string[] {
  const found: string[] = []
  let dir = resolve(cwd)
  while (true) {
    const claudeHere = isFile(join(dir, 'CLAUDE.md'))
    const skipAgents = mode === 'claude' || (mode === 'agents-fallback' && claudeHere)
    if (!skipAgents) pushIfFile(found, join(dir, 'AGENTS.md'))
    pushIfFile(found, join(dir, 'RAVEN.md'))
    pushIfFile(found, join(dir, 'CLAUDE.md'))
    pushIfFile(found, join(dir, DOT_RAVEN_FILE))
    pushIfFile(found, join(dir, 'RAVEN.local.md'))
    if (!skipAgents) pushIfFile(found, join(dir, 'AGENTS.local.md'))
    pushRuleDir(found, join(dir, '.ravenclaw', 'rules'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}

function isFile(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
```

Keep `pushIfFile`. Do not loop `PROJECT_FILE_NAMES` blindly; the skip must be per directory. `PROJECT_FILE_NAMES` can remain for onboarding (do not edit `scan.ts`).

`packages/core/src/prompt/subdir-agents.ts`:

```ts
import type { InstructionFilesMode } from '../config'

function namesFor(mode: InstructionFilesMode): readonly string[] {
  if (mode === 'claude') return ['CLAUDE.md', 'RAVEN.md']
  if (mode === 'agents-fallback') return ['CLAUDE.md', 'AGENTS.md', 'RAVEN.md']
  return SUBDIR_AGENT_NAMES
}

export function loadNearestSubdirAgents(
  cwd: string,
  filePath: string,
  seen: Set<string>,
  mode: InstructionFilesMode = 'both',
): string | undefined {
  // existing walk; inner `for (const name of namesFor(mode))`
}
```

Keep `SUBDIR_AGENT_NAMES = ['AGENTS.md', 'RAVEN.md', 'CLAUDE.md']` for `'both'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/prompt/project-files.test.ts ./packages/core/src/prompt/subdir-agents.test.ts`

Expected: PASS (including the older closer-wins / cap / `@include` cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/prompt/project-files.ts packages/core/src/prompt/project-files.test.ts packages/core/src/prompt/subdir-agents.ts packages/core/src/prompt/subdir-agents.test.ts
git commit -m "$(cat <<'EOF'
feat(core): filter AGENTS.md vs CLAUDE.md by instructionFiles mode

Per-directory agents-fallback; RavenClaw-native slots stay on.
EOF
)"
```

---

### Task 3: I2 thread mode from config into prompt, engine, loop, children

**Files:**
- Modify: `packages/core/src/prompt/builder.ts`
- Modify: `packages/core/src/prompt/builder.test.ts`
- Modify: `packages/core/src/types.ts` (`SessionEngineOptions`, `SessionEngine`, `QueryLoopOptions`, `ToolContext`)
- Modify: `packages/core/src/loop/session-engine.ts` (mutable field, `setInstructionFiles`, `loopOpts`, `startDetachedReview`)
- Modify: `packages/core/src/loop/phases.ts` (`appendSubdirAgents`, ToolContext)
- Modify: `packages/core/src/tools/agent.ts` (child `engineOpts`)
- Modify: `packages/core/src/log.ts` (forward)
- Modify: `packages/cli/src/engine.ts` (`buildSystemParts` + `engineOpts` + wrapper)
- Modify: `packages/sdk/src/index.ts` (`buildSystemParts` + `engineOpts`)

**Interfaces:**
- Consumes: `InstructionFilesMode`, `loadProjectFiles(cwd, mode)`, `loadNearestSubdirAgents(..., mode)`
- Produces: `PromptBuildInput.instructionFiles?`; `SessionEngine.setInstructionFiles(mode)`; loop/tool-context field; CLI/SDK boot pass `config.instructionFiles`

- [ ] **Step 1: Write the failing test**

In `packages/core/src/prompt/builder.test.ts`, use the existing `tempDir` helper. `input()` always sets `projectFilesText`, so **do not** spread `input()` — omit `projectFilesText` so the walk runs:

```ts
test('buildSystemParts walks project files with instructionFiles claude', () => {
  const cwd = tempDir('ravenclaw-builder-instr-')
  writeFileSync(join(cwd, 'AGENTS.md'), 'AGENTS_ONLY\n')
  writeFileSync(join(cwd, 'CLAUDE.md'), 'CLAUDE_ONLY\n')
  const parts = buildSystemParts({
    cwd,
    permissionMode: 'default',
    instructionFiles: 'claude',
    git: GIT,
  })
  const context = parts.find((part) => part.tier === 'context')?.text ?? ''
  expect(context).toContain('CLAUDE_ONLY')
  expect(context).not.toContain('AGENTS_ONLY')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./packages/core/src/prompt/builder.test.ts`

Expected: FAIL — `instructionFiles` unused; context still contains `AGENTS_ONLY`.

- [ ] **Step 3: Write minimal implementation**

`builder.ts` `PromptBuildInput`:

```ts
  instructionFiles?: import('../config').InstructionFilesMode
```

Walk:

```ts
    input.projectFilesText !== undefined
      ? input.projectFilesText
      : loadProjectFiles(input.cwd, input.instructionFiles ?? 'both')
```

`types.ts`:

```ts
import type { InstructionFilesMode } from './config'
```

(or inline `import('./config').InstructionFilesMode` to avoid a cycle — **use the inline import** on the option fields if `config.ts` already imports types).

Add to `SessionEngineOptions`:

```ts
  instructionFiles?: import('./config').InstructionFilesMode
```

Add to `SessionEngine`:

```ts
  setInstructionFiles(mode: import('./config').InstructionFilesMode): void
```

Add to `QueryLoopOptions` and `ToolContext`:

```ts
  instructionFiles?: import('./config').InstructionFilesMode
```

`session-engine.ts` inside `createSessionEngine`:

```ts
  let instructionFiles = opts.instructionFiles ?? 'both'
```

On the returned engine object, next to `reloadSystem`:

```ts
    setInstructionFiles(mode: import('../config').InstructionFilesMode) {
      instructionFiles = mode
    },
```

When building `loopOpts`:

```ts
        loopOpts.instructionFiles = instructionFiles
```

`startDetachedReview`: add `instructionFiles` to its opts bag and `childOpts.instructionFiles = opts.instructionFiles` when the parent field is not `'both'` **or always copy** (always copy the current value).

`phases.ts` `appendSubdirAgents`:

```ts
  const injection = loadNearestSubdirAgents(
    state.turn.cwd,
    resolve(state.turn.cwd, path),
    seen,
    state.instructionFiles ?? 'both',
  )
```

ToolContext block (~1250):

```ts
  if (state.instructionFiles !== undefined) ctx.instructionFiles = state.instructionFiles
```

`agent.ts` `engineOpts` (~247):

```ts
      if (ctx.instructionFiles !== undefined) engineOpts.instructionFiles = ctx.instructionFiles
```

`log.ts` wrapper, next to `reloadSystem`:

```ts
    setInstructionFiles(mode) {
      engine.setInstructionFiles(mode)
    },
```

CLI `engine.ts` `buildSystemParts` (~470):

```ts
  const system = buildSystemParts({
    cwd: session.cwd,
    permissionMode: session.permissionMode,
    instructionFiles: opts.config.instructionFiles,
    ...(opts.config.bare === true ? { bare: true } : {}),
    ...(opts.config.effort !== undefined ? { effort: opts.config.effort } : {}),
  })
```

And `engineOpts.instructionFiles = opts.config.instructionFiles`. Wrapper next to `reloadSystem`:

```ts
    setInstructionFiles(mode) {
      engine.setInstructionFiles(mode)
    },
```

SDK `index.ts` `buildSystemParts` and `engineOpts`: same `instructionFiles: config.instructionFiles`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/prompt/builder.test.ts ./packages/core/src/prompt/project-files.test.ts ./packages/core/src/prompt/subdir-agents.test.ts`

Expected: PASS. If `log.ts` / CLI wrapper fail typecheck, the `setInstructionFiles` forward is the fix (no new tests required this step).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/prompt/builder.ts packages/core/src/prompt/builder.test.ts packages/core/src/types.ts packages/core/src/loop/session-engine.ts packages/core/src/loop/phases.ts packages/core/src/tools/agent.ts packages/core/src/log.ts packages/cli/src/engine.ts packages/sdk/src/index.ts
git commit -m "$(cat <<'EOF'
feat: thread instructionFiles from config into session start

New sessions and child engines assemble project instructions from the live mode.
EOF
)"
```

---

### Task 4: I3 `/config` dump, chooser, persist-then-apply

**Files:**
- Modify: `packages/cli/src/config-print.ts`
- Modify: `packages/cli/src/config-print.test.ts`
- Modify: `packages/cli/src/slash/dispatch.ts` (`case 'config'`, `reloadSystem`)
- Modify: `packages/cli/src/slash/dispatch.test.ts` (`fakeEngine` + cases)
- Modify: `packages/cli/src/commands.ts` (usage / summary)

**Interfaces:**
- Consumes: `writeHomeInstructionFiles`, `isInstructionFilesMode`, `buildSystemParts`, `engine.setInstructionFiles`, `formatPublicConfig`
- Produces: dump line `instructionFiles: <mode>`; locked chooser / usage notices; persist-then-apply

- [ ] **Step 1: Write the failing tests**

`packages/cli/src/config-print.test.ts` empty-home test, add:

```ts
    expect(text).toContain('instructionFiles: both')
```

Yaml overlay test, write `instructionFiles: claude` into that `config.yaml` and:

```ts
    expect(text).toContain('instructionFiles: claude')
```

`packages/cli/src/slash/dispatch.test.ts` — extend `fakeEngine` with:

```ts
    setInstructionFiles(mode) {
      sessionInstructionFiles.mode = mode
    },
    get instructionFiles() {
      return sessionInstructionFiles.mode
    },
```

Simplest: a `let lastInstructionFiles: string | undefined` closed over in `fakeEngine`, plus `get lastInstructionFiles()`. Record it. Also keep `reloads`.

Add tests at the end of `describe('dispatchSharedSlash')`:

```ts
  test('/config dump includes instructionFiles', async () => {
    const host = fakeHost(fakeRuntime(fakeEngine(makeSession())))
    expect(await dispatchSharedSlash(cmd('config'), host)).toBe('handled')
    expect(host.notices[0]).toContain('instructionFiles:')
  })

  test('/config instructions prints chooser and does not write', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-cfg-chooser-'))
    tempDirs.push(home)
    const runtime = fakeRuntime(fakeEngine(makeSession()))
    runtime.config = { ...runtime.config, home, instructionFiles: 'both' }
    const host = fakeHost(runtime)
    expect(await dispatchSharedSlash(cmd('config', 'instructions'), host)).toBe('handled')
    expect(host.notices[0]).toBe(
      [
        'instructionFiles: both',
        '  claude           CLAUDE.md only',
        '  agents-fallback  CLAUDE.md, else AGENTS.md in that directory',
        '  both             CLAUDE.md and AGENTS.md',
      ].join('\n'),
    )
    expect(existsSync(join(home, 'config.yaml'))).toBe(false)
  })

  test('/config instructions claude persists, applies, and reloads', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-cfg-set-'))
    tempDirs.push(home)
    const engine = fakeEngine(makeSession())
    const runtime = fakeRuntime(engine)
    runtime.config = { ...runtime.config, home, instructionFiles: 'both' }
    const host = fakeHost(runtime)
    expect(await dispatchSharedSlash(cmd('config', 'instructions claude'), host)).toBe('handled')
    expect(host.notices).toEqual(['instructionFiles: claude'])
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('instructionFiles: claude\n')
    expect(runtime.config.instructionFiles).toBe('claude')
    expect(engine.reloads).toBe(1)
  })

  test('/config instructions maybe prints usage and does not write', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-cfg-bad-'))
    tempDirs.push(home)
    const runtime = fakeRuntime(fakeEngine(makeSession()))
    runtime.config = { ...runtime.config, home, instructionFiles: 'both' }
    const host = fakeHost(runtime)
    expect(await dispatchSharedSlash(cmd('config', 'instructions maybe'), host)).toBe('handled')
    expect(host.notices).toEqual(['usage: /config instructions claude|agents-fallback|both'])
    expect(existsSync(join(home, 'config.yaml'))).toBe(false)
    expect(runtime.config.instructionFiles).toBe('both')
  })

  test('/config instructions claude without home notices no home directory', async () => {
    const runtime = fakeRuntime(fakeEngine(makeSession()))
    runtime.config = { ...runtime.config, instructionFiles: 'both' }
    delete (runtime.config as { home?: string }).home
    const host = fakeHost(runtime)
    expect(await dispatchSharedSlash(cmd('config', 'instructions claude'), host)).toBe('handled')
    expect(host.notices).toEqual(['no home directory'])
  })
```

Import `existsSync`, `readFileSync`, `mkdtempSync` as needed (`mkdtempSync` / `tmpdir` / `join` already exist). `fakeRuntime` config is a partial cast; spreading `instructionFiles` is enough.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/cli/src/config-print.test.ts ./packages/cli/src/slash/dispatch.test.ts`

Expected: FAIL — dump missing the line; `case 'config'` ignores args.

- [ ] **Step 3: Write minimal implementation**

`commands.ts`:

```ts
  { name: 'config', usage: '/config [instructions [claude|agents-fallback|both]]', summary: 'show resolved config; set instruction file mode' },
```

`config-print.ts`: import `isInstructionFilesMode`. After parsing yaml, compute:

```ts
  const instructionFiles =
    typeof parsed.instructionFiles === 'string' && isInstructionFilesMode(parsed.instructionFiles)
      ? parsed.instructionFiles
      : 'both'
```

`parseConfigYaml` already returns typed `instructionFiles?: InstructionFilesMode`, so:

```ts
  const instructionFiles = parsed.instructionFiles ?? 'both'
```

Insert `instructionFiles: ${instructionFiles}` in the returned array after `permissionMode` (stable, visible).

`dispatch.ts` imports: add `isInstructionFilesMode`, `writeHomeInstructionFiles`, type `InstructionFilesMode`.

Replace `case 'config':` with a call to `dispatchConfig(parsed.arg, host, runtime)`.

```ts
const CONFIG_INSTRUCTIONS_USAGE = 'usage: /config instructions claude|agents-fallback|both'

function formatInstructionFilesChooser(mode: InstructionFilesMode): string {
  return [
    `instructionFiles: ${mode}`,
    '  claude           CLAUDE.md only',
    '  agents-fallback  CLAUDE.md, else AGENTS.md in that directory',
    '  both             CLAUDE.md and AGENTS.md',
  ].join('\n')
}

function dispatchConfig(arg: string | undefined, host: SlashHost, runtime: CliRuntime): void {
  const trimmed = arg?.trim() ?? ''
  if (trimmed === '') {
    host.notice(
      runtime.config.home !== undefined
        ? formatPublicConfig({ home: runtime.config.home })
        : 'see raven config',
    )
    return
  }
  const parts = trimmed.split(/\s+/)
  if (parts[0] !== 'instructions') {
    host.notice(CONFIG_INSTRUCTIONS_USAGE)
    return
  }
  if (parts.length === 1) {
    host.notice(formatInstructionFilesChooser(runtime.config.instructionFiles ?? 'both'))
    return
  }
  if (parts.length !== 2 || !isInstructionFilesMode(parts[1] ?? '')) {
    host.notice(CONFIG_INSTRUCTIONS_USAGE)
    return
  }
  const mode = parts[1] as InstructionFilesMode
  const home = runtime.config.home
  if (home === undefined) {
    host.notice('no home directory')
    return
  }
  try {
    writeHomeInstructionFiles(home, mode)
  } catch {
    host.notice('failed to write config.yaml')
    return
  }
  runtime.config.instructionFiles = mode
  runtime.engine.setInstructionFiles(mode)
  runtime.engine.reloadSystem(
    buildSystemParts({
      cwd: runtime.cwd,
      permissionMode: runtime.engine.session.permissionMode,
      instructionFiles: mode,
    }),
  )
  host.notice(`instructionFiles: ${mode}`)
}
```

Do **not** call `reloadSystem(runtime)` here (that helper still notices nothing, but keep one notice). Update `reloadSystem` for `/skills` / `/reload` so later assembles keep the live mode:

```ts
function reloadSystem(runtime: CliRuntime): void {
  runtime.engine.reloadSystem(
    buildSystemParts({
      cwd: runtime.cwd,
      permissionMode: runtime.engine.session.permissionMode,
      instructionFiles: runtime.config.instructionFiles ?? 'both',
    }),
  )
}
```

`fakeEngine` must provide `setInstructionFiles() {}` even if the set test only asserts `reloads` (reloadSystem on the fake increments `reloads`). The set test above calls `reloadSystem` on the engine via dispatch’s direct `engine.reloadSystem` — **that increments `reloads`**. It also calls `setInstructionFiles`. Implement both on the fake.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/cli/src/config-print.test.ts ./packages/cli/src/slash/dispatch.test.ts ./packages/cli/src/commands.test.ts`

Expected: PASS. `commands.test.ts` only checks `/config` is in help; usage string change is fine.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config-print.ts packages/cli/src/config-print.test.ts packages/cli/src/slash/dispatch.ts packages/cli/src/slash/dispatch.test.ts packages/cli/src/commands.ts
git commit -m "$(cat <<'EOF'
feat(cli): choose instructionFiles via /config instructions

Persist-then-apply the mode; bare /config still dumps including the live value.
EOF
)"
```

---

### Task 5: I4 docs honesty

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-instruction-files-config.md` (Status stays **draft** until merge; fill Implementation plan link if still “not written”; leave board **todo** until code from Tasks 1–4 is in — after code, mark I0–I3 **done**, I4 **done** in this task)
- Modify: `SLASH_COMMANDS.md` `/config` section
- Modify: `SLASH_COMMANDS.ko.md` `/config` section
- Modify: `ARCHITECTURE.md` project-instructions paragraph + config.yaml row
- Modify: `ARCHITECTURE.ko.md` matching
- Modify: `README.md` optional `config.yaml` example
- Modify: `CHANGELOG.md` Unreleased Added (prepend)

**Interfaces:**
- Consumes: shipped behavior from Tasks 1–4
- Produces: docs that name `instructionFiles` and the three tokens

- [ ] **Step 1: Edit docs (no failing test)**

`SLASH_COMMANDS.md` `/config` (replace the read-only paragraph):

- Aliases: none
- Kind: shared
- When: any
- Bare `/config`: `formatPublicConfig` including `instructionFiles: claude|agents-fallback|both` (default `both`). Home unset: `see raven config`.
- `/config instructions`: print current mode plus the three token lines. No write.
- `/config instructions claude|agents-fallback|both`: write `instructionFiles` in `$RAVENCLAW_HOME/config.yaml` (surgical upsert), set the live runtime, `setInstructionFiles`, rebuild system parts. Notice `instructionFiles: <mode>`. Unknown token: `usage: /config instructions claude|agents-fallback|both`. No home: `no home directory`. Write fail: `failed to write config.yaml` (runtime unchanged).
- Related CLI: `raven config` (dump only).

`SLASH_COMMANDS.ko.md`: same facts in Korean.

`ARCHITECTURE.md` project instructions (~604): after the file list, one sentence: mode comes from `config.yaml` `instructionFiles` (`claude` | `agents-fallback` | `both`, default `both`); `agents-fallback` is per directory; RavenClaw-native slots always load. Data map row for `config.yaml` add `instructionFiles`.

`ARCHITECTURE.ko.md`: matching sentence + table row.

`README.md` yaml example, after `permissionMode`:

```yaml
instructionFiles: both     # claude | agents-fallback | both
```

`CHANGELOG.md` Unreleased ### Added, **prepend**:

```md
- `/config instructions claude|agents-fallback|both` persists `instructionFiles` in `~/.ravenclaw/config.yaml` (surgical upsert) and rebuilds the context-tier project walk. Default `both` keeps today’s AGENTS.md + CLAUDE.md load. `claude` skips AGENTS.md / AGENTS.local.md. `agents-fallback` uses CLAUDE.md when that file exists in a directory, else AGENTS.md. RavenClaw-native `RAVEN.md` / rules stay on. Spec: [docs/superpowers/specs/2026-09-21-instruction-files-config.md](docs/superpowers/specs/2026-09-21-instruction-files-config.md). Plan: [docs/superpowers/plans/2026-09-21-instruction-files-config.md](docs/superpowers/plans/2026-09-21-instruction-files-config.md).
```

Spec: set Implementation plan link to this file. After Tasks 1–4 exist, board I0–I4 **done** vs this worktree. Status stays **draft** until it lands on `main`. Do **not** fill Shipped sha.

- [ ] **Step 2: No unit test**

Docs-only.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-21-instruction-files-config.md SLASH_COMMANDS.md SLASH_COMMANDS.ko.md ARCHITECTURE.md ARCHITECTURE.ko.md README.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: document instructionFiles /config chooser

Point slash, architecture, README, and CHANGELOG at the three-mode project walk.
EOF
)"
```

---

## Spec coverage

| Spec ruling | Task |
|---|---|
| 1–2 tokens + default both | 1 |
| 3–5 project walk | 2 |
| 6 subdir | 2, 3 |
| 7–10 yaml persist + new-session init | 1, 3 |
| 11–16 `/config` + dump + live apply + `/reload` | 4 |
| 17–19 threading / children / hosts | 3 |
| 20–21 caps / do not write instruction files | 2 (unchanged caps), 5 (docs) |
| Do-not-build list | none of the tasks open those doors |
