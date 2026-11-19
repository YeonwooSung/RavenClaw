# Model router, hand/brain context split, subagent graph — implementation plan

Spec: none separate. This plan is the authority; it was derived from a code review of `main@55745e7` (child-profile bug, ignored definition `maxRounds`, provider-blind model switches, `ToolContext` coupling, depth-1 star agent topology, durable adapter drift).

Repo: Bun/TypeScript monorepo. Packages under `packages/*`. `@ravenclaw/providers` depends on `@ravenclaw/core`, so **core must never import providers** — inject provider construction as a factory.

## Global Constraints

- Tests: run per package, never bare `bun test` from repo root (Docker hang). Use `bun test packages/<pkg>` or a specific file. The full gate is `bash scripts/ci-unit.sh` from repo root.
- No `tsc` script exists; type errors surface through `bun test` imports only. Keep types honest anyway (`exactOptionalPropertyTypes`-style code: optional fields are assigned conditionally, follow existing patterns).
- Do not change behavior of the design invariants in `ARCHITECTURE.md` § Design invariants (one queryLoop, hosts only submitMessage, persist-before-execute, dontAsk ≠ bypass, frozen tool prefix, ads isolation, clean-room).
- Included-funding sessions are fail-closed: never open a BYOK client for an `included` session. A model of a different provider kind under `included` is an error, not a silent BYOK fallback.
- Preserve public exports from `packages/core/src/index.ts` (add re-exports when moving files; do not delete exported names).
- Commit messages: conventional style used in this repo (`fix(agent): …`, `feat(model): …`, `refactor(core): …`). End every commit message with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Brand strings rule: builtin skills must not contain `Claude`/`Anthropic`; unrelated to code, but do not touch skill trees.

---

### Task 1: Child agent correctness bugs

Files: `packages/core/src/tools/agent.ts`, `packages/core/src/agent/load.ts`, `packages/core/src/tools/skill.ts` (frontmatter parser only if needed), tests in `packages/core/src/tools/agent.test.ts`, `packages/core/src/agent/*.test.ts`.

1. **Child ModelProfile.** In `spawnChild`, `engineOpts.model` is currently `opts.model` (the parent's boot-time profile) while the request model id is `childModel`. Resolve the child's profile from `childModel`. Add an optional `resolveProfile?: (id: string) => ModelProfile` to `createAgentTool` opts; default `getModelProfile`. When `childModel === opts.model.id`, keep `opts.model` (preserves yaml overrides). Because `childModel` derives from `ctx.turn.model` (the live model), this also fixes staleness after `/model`.
2. **Definition maxRounds honored.** Replace `opts.childMaxRounds ?? definition.maxRounds` with: if both defined → `Math.min(opts.childMaxRounds, definition.maxRounds)`; else whichever is defined. (config `childMaxRounds` becomes a ceiling, not an override.)
3. **Disk agent frontmatter.** `parseAgentFile` must read optional `model` (string) and optional `maxRounds` (positive integer; invalid → ignore, default stays 12) from frontmatter. Extend frontmatter parsing minimally (a separate small agent-frontmatter read via the existing yamlish parser is fine; do not change skill semantics).
4. Tests (TDD — write failing tests first):
   - child spawned with a definition/specialist model whose profile differs from the parent (e.g. parent `claude-opus-5`, child `claude-haiku-4-5`) runs with `contextWindow` 200_000 (observe via a fake provider/request `maxTokens` = haiku `reserveOutputTokens` 20_000 vs opus … or via exposed engine state — pick an observable that exists).
   - command-runner (maxRounds 2) with `childMaxRounds: 30` stops by 2 rounds; general (30) with `childMaxRounds: 10` is capped at 10.
   - disk agent with `model: foo-model` and `maxRounds: 3` frontmatter parses into the definition.
5. Update the `ARCHITECTURE.md` sentence "Child agents use `childMaxRounds` (default 30) or the catalog definition" to describe the ceiling rule, and the disk-agents paragraph to mention `model`/`maxRounds` frontmatter.

### Task 2: Core model resolver (one place for id → provider kind → profile)

Files: create `packages/core/src/model/resolve.ts` (+ `resolve.test.ts`), export from `packages/core/src/index.ts`; modify `packages/core/src/config.ts`, `packages/cli/src/aux.ts`, `packages/cli/src/slash/dispatch.ts` (profile-overrides call only).

1. Move `providerKindFromModelId` from `packages/cli/src/aux.ts` into core `model/resolve.ts` (keep a re-export from `cli/src/aux.ts` so existing imports/tests keep working). Rules unchanged: `anthropic`/`claude-*` → `anthropic`; `openai`/`gpt-*` → `openai_compat`; `ollama/…`, `vllm/…`, `orcarouter/…` → that kind; else `undefined`.
2. Add `profileOverridesFor(config: Pick<ResolvedConfig,'model'|'contextWindow'|'prices'>, id: string): ModelProfileOverrides | undefined`. Ruling on global `contextWindow`: it applies **only** when `id === config.model` (the configured session model); per-id `prices[id]` always apply. Replace the private `profileOverrides` in `config.ts` and the inline override object in `dispatch.ts` `/model` with this function.
3. Add `createModelResolver(opts)`:
   ```ts
   interface ModelResolverOptions {
     config: ResolvedConfig
     funding: Funding
     liveProvider: Provider
     liveModel: string            // session model id the liveProvider serves
     createProvider?: (kind: ProviderKind, modelId: string, config: ResolvedConfig) => Provider // BYOK factory, injected by cli/sdk
   }
   type ResolvedModel = { ok: true; provider: Provider; profile: ModelProfile; kind: ProviderKind | undefined }
                      | { ok: false; error: string }
   interface ModelResolver { resolve(id: string): ResolvedModel; profile(id: string): ModelProfile }
   ```
   Semantics: `profile(id)` = `getModelProfile(id, profileOverridesFor(config, id))`. `resolve(id)`: kind = `providerKindFromModelId(id)`; if kind is undefined or equals the live kind (`providerKindFromModelId(liveModel) ?? config.provider`) → reuse `liveProvider`. Otherwise: `included` funding → `{ ok:false, error: 'model <id> needs provider <kind>; included sessions cannot switch provider' }`; no factory → error; factory throws → `{ ok:false, error: <message> }`. Cache constructed providers per kind inside the resolver.
4. Move the BYOK construction body of `createByokProviderForModel` (cli/aux.ts) into a cli-side factory function `byokProviderFactory` (stays in cli — it needs `@ravenclaw/providers`), with the factory signature above. `tryBuildAuxProvider` / `applyAuxCompactPolicy` must now go through `createModelResolver(...).resolve(...)` (behavior unchanged: included + cross-kind → undefined; BYOK failure → undefined).
5. Tests: resolver unit tests (same-kind reuse, cross-kind BYOK via fake factory, included cross-kind error, factory throw → error, provider cache, `profileOverridesFor` contextWindow rule and prices rule). Existing aux and config tests must still pass.

### Task 3: Wire the resolver into every model switch; relocate specialistModel

Depends on Task 2 (`createModelResolver`, `ModelResolver`) and Task 1 (`resolveProfile` opt on Agent tool).

Files: `packages/core/src/types.ts`, `packages/core/src/loop/session-engine.ts`, `packages/core/src/loop/phases.ts` (fallback), `packages/core/src/tools/agent.ts`, `packages/cli/src/engine.ts`, `packages/cli/src/slash/dispatch.ts`, `packages/sdk/src/index.ts`, related tests.

1. `SessionEngineOptions` gains optional `modelResolver?: ModelResolver`. LoopState/loopOpts carry it.
2. **Fallback** (`phases.ts` ~L618-630): when `modelResolver` is present, `resolve(fallback)`; on `ok:false` emit status `fallback model <id> unavailable: <error>` and do not switch (continue normal retry/backoff); on ok set `state.provider`, `state.model`, `state.turn.model`. Without a resolver keep current behavior but use `getModelProfile` as today.
3. **`/model`**: `SessionEngine.setModel` gains an optional second arg `provider?: Provider`; when given, the engine's provider binding for the **next** turn is replaced (in-flight loop untouched — same rule as model). `/model <id>` in `dispatch.ts` resolves via the runtime's resolver; on `ok:false` print notice `model <id>: <error>` and do not switch.
4. **Children**: `createAgentTool` opts gain `modelResolver?: ModelResolver` and `specialistModel?: string`. Child provider+profile come from `modelResolver.resolve(childModel)` when present (on `ok:false` the Agent call returns `Agent failed: <error>`, no child session created); else Task 1's `resolveProfile` path with parent provider.
5. **Relocate `specialistModel`** out of `CompactPolicy` (`types.ts` L270-271): delete the field there; cli `engine.ts` stops writing `compact.specialistModel` and passes `config.specialistModel` to `createAgentTool` opts instead. `resolveChildModel` reads `ctx.turn.specialistModel ?? opts.specialistModel`. Update tests that set `compact.specialistModel` (agent.test.ts helper ~L234-241).
6. CLI `engine.ts` and SDK `index.ts` build one resolver per opened engine (BYOK factory from Task 2 in cli; SDK may pass the same style factory using `createProvider` from `@ravenclaw/providers` — SDK already depends on providers) and pass it to `createSessionEngine` and `createAgentTool`.
7. Tests: fallback cross-kind switches provider (fake providers); fallback unavailable emits status and does not switch; `/model` cross-kind under included → notice, no switch; Agent child with cross-kind `specialistModel` uses resolved provider (the existing `'ollama/qwen'` test must assert the request reached the resolved provider, not the parent provider).

### Task 4: Hand/brain context split (type-level) and Agent tool moved to orchestration layer

Files: `packages/core/src/types.ts`, move `packages/core/src/tools/agent.ts` → `packages/core/src/orchestration/agent-tool.ts` (and its test → `orchestration/agent-tool.test.ts`), keep `packages/core/src/tools/agent.ts` as a one-line re-export shim, `packages/core/src/index.ts`; new boundary test `packages/core/src/orchestration/boundary.test.ts`.

1. Split `ToolContext` into two named interfaces in `types.ts`, without runtime change:
   - `ToolHandsContext` — `turn`, `signal`, `onProgress`, `fileHistory`.
   - `ToolOrchestrationContext` — `tasks`, `store`, `session`, `registerChildEngine`, `instructionFiles`.
   - `export type ToolContext = ToolHandsContext & Partial<ToolOrchestrationContext>` (all orchestration fields stay optional, so every call site compiles unchanged).
2. Move the Agent tool implementation into `packages/core/src/orchestration/`. The old path re-exports. Any helper only the Agent tool uses moves with it.
3. Boundary test (static, reads source files with `node:fs`): (a) no file under `packages/core/src/tools/` (excluding `*.test.ts` and the `agent.ts` shim) imports from `../loop/session-engine` or `../orchestration/`; (b) the set of `tools/*.ts` files that read `ctx.store`, `ctx.session`, `ctx.registerChildEngine`, `ctx.tasks`, or `ctx.instructionFiles` equals an explicit allowlist written in the test (compute the current set during implementation; list each with a one-line comment why it needs orchestration). The test fails if a new tool starts reaching orchestration fields without being added deliberately.
4. Update `ARCHITECTURE.md` `packages/` tree and the "Agent children" section path.

### Task 5: Subagent graph — spawn edges, depth, shared concurrency budget, dead fields

Depends on Task 4 (Agent tool now at `orchestration/agent-tool.ts`).

Files: `packages/core/src/orchestration/agent-tool.ts`, `packages/core/src/agent/definition.ts`, `packages/core/src/agent/load.ts`, `packages/core/src/types.ts`, `packages/core/src/config.ts` (one new key), tests.

1. **Spawn edges.** The spawnable set for a call is the *calling* agent's `definition.spawnableAgents` (root → `rootAgent.spawnableAgents` plus disk agents, as today). Track the calling definition on the turn: add `agentId?: string` and `agentDepth?: number` to `Turn` (root: undefined/0). A child turn gets `agentId = definition.id`, `agentDepth = parent + 1`.
2. **Nested spawning.** `Agent` stays in `NESTING_DENIED` **unless** the child definition has a non-empty `spawnableAgents` and `agentDepth < maxAgentDepth`; then the child pool includes the Agent tool (the same tool instance; it reads edges from `ctx.turn.agentId`). New config key `maxAgentDepth` (number, default 2, meaning root=0 can spawn depth 1, depth-1 can spawn depth 2, depth 2 cannot). Built-in catalog definitions keep `spawnableAgents: []`, so default behavior is unchanged.
3. **Disk agent edges.** Frontmatter `spawnable-agents` (comma list, same parser style as `allowed-tools`) → `spawnableAgents`. A disk agent that lists edges also needs `Agent` in its tools implicitly — add it to `toolNames` when edges are non-empty.
4. **Shared concurrency budget.** Replace the two separate `MAX_PARALLEL_CHILDREN` checks with one per-root-tree counter of live children (foreground batch members + background agents + nested children) shared via the Agent tool instance; cap remains `MAX_PARALLEL_CHILDREN` (6). A batch that would exceed the remaining budget fails with `Agent failed: at most 6 concurrent agents (N running)`; counter decrements in `finally`.
5. **Dead fields.** Implement `outputMode: 'all_messages'`: child result = concatenation of every assistant text in the child transcript (separated by `\n\n`), still bounded by `CHILD_RESULT_CHAR_BOUND`. Implement `compactContext`: when set on a definition, the child engine's `compact` is `{ ...parentCompact, ...definition.compactContext }`.
6. Tests: depth-limit (depth-2 child cannot spawn; error text), edge check (child may spawn only its listed ids), disk frontmatter edges parse + implicit Agent tool, shared budget across background + batch, `all_messages` output, `compactContext` overlay reaches child engine.
7. `ARCHITECTURE.md` Agents catalog section: document edges, depth, budget, frontmatter keys.

### Task 6: Durable adapter convergence (SDK) + direction note

Files: `packages/sdk/src/durable.ts`, its test file, `packages/core/src/permissions/*` only for a shared helper export if needed, `ARCHITECTURE.md`.

1. **Permission rules.** `toDurableTool` currently passes `rules: EMPTY_RULES`. Load the same rules the core loop loads (session-less: user `~/.ravenclaw/permissions.json` + project `<cwd>/.ravenclaw/permissions.json`) using the existing core loader used by `runToolRound`; export it from core if not exported. Deny rules must deny in durable; allow rules may promote a leftover ask.
2. **Replay safety.** Replace `tool.isReadOnly(undefined as never)` with an explicit name-based classification from core's permission modes (the read-only tool classification in `packages/core/src/permissions/modes.ts` or equivalent). `replay: 'safe'` only for tools in that read-only set; never call `isReadOnly` with a fake input.
3. Tests: durable deny rule produces `permission_denied` without executing; Bash replay is `'unsafe'`, Read replay `'safe'`.
4. `ARCHITECTURE.md` non-goals/durable paragraph: add a short "Convergence direction" note — durable remains the opt-in runtime; shared policy modules (permission rules, replay classification) live in core and are consumed by the SDK adapter; the core loop is not replaced.

### Task 7: Korean architecture doc sync

Files: `ARCHITECTURE.ko.md`.

Mirror every `ARCHITECTURE.md` change made in Tasks 1, 4, 5, 6 into the matching sections of `ARCHITECTURE.ko.md` (Korean prose, same facts, same file paths). Do not change unrelated sections. Verify with `git diff main -- ARCHITECTURE.md` as the source list.
