# Freebuff (Codebuff) prior-art analysis

Freebuff is the ad-funded coding agent built on Codebuff (`/Users/yeonwoosung/Desktop/freebuff`). Architecture and business ideas for RavenClaw: steal the design, not the code.

How included models stay free, how ads render in a terminal, and how a root orchestrates cheap specialists.

---

## 1. Product and business model

### How Freebuff is free

The root README states the offer: no subscription, credits, or API key required. Text ads support the included models.

`freebuff/SPEC.md` is a compile-time product spec, not a fork. The same `cli/` package is built with `FREEBUFF_MODE=true`, which sets `IS_FREEBUFF` in `cli/src/utils/constants.ts`. The bundler dead-code-eliminates paid branches. In Freebuff, `agentMode` is always `'FREE'`; `/subscribe`, `/usage`, `/credits`, `/ads:enable`, and `/ads:disable` are stripped. `getAdsEnabled()` in `cli/src/commands/ads.ts` returns `true` unconditionally. Credits still accumulate server-side (`sessionCreditsUsed` in `chat-store.ts`) but the UI never shows them.

Ads are the price of the free product. A paid plan does **not** turn ads off. `common/src/constants/freebuff-house-ad.ts` is explicit: a subscription grants more sessions; it does not skip a queue and it does not remove ads. House ads even suppress themselves for existing subscribers, because those creatives sell the plan.

### Full vs limited access

`FreebuffAccessTier = 'full' | 'limited'` lives in `common/src/constants/freebuff-model-entitlements.ts`. Web adds `'blocked'` (Tor / anonymous egress) as `FreebuffWebAccessTier`. The split is geographic and anti-abuse, not a paywall.

- **Full** (supported regions): the whole picker. GLM 5.3 Flash, DeepSeek V4 Flash, MiMo 2.5, and Solar Pro 4 are unmetered at full access on the legacy session system. Luna and Muse Spark draw the premium pool. Gemini 3.8 Flash is Pro-only everywhere (`FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS`).
- **Limited** (other regions, VPN): `LIMITED_FREEBUFF_MODEL_IDS` — GLM 5.3 Flash, DeepSeek V4 Flash, MiMo 2.5, Solar Pro 4. Hero is `LIMITED_FREEBUFF_HERO_MODEL_ID` (GLM). Coercion target for stale/out-of-tier picks is `LIMITED_FREEBUFF_MODEL_ID` (DeepSeek Flash), which remains joinable even if Freebucks is rolled back. Luna is plan-locked at this tier (`FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS`).

Admission is server-side. A stale CLI that still asks for a withdrawn model is **coerced**, not refused (`FREEBUFF_PAUSED_FREE_MODEL_IDS`). Installed clients retry forever on a hard 403; that 2.5×’d admissions the first time they learned it (`#1801`).

### Sessions, Freebucks, referrals, credits

There are two overlapping meters — the most important business-model fact in the repo.

**Legacy session pools** (`freebuff-models.ts`): one hour each; midnight Pacific reset. `FREEBUFF_PREMIUM_SESSION_LIMIT = 5`, `FREEBUFF_LIMITED_SESSION_LIMIT = 6`. Cheap full-access models are unmetered by count. The earned reward pool (`FREEBUFF_REWARD_MODEL_IDS` = GLM at limited, +1 premium session at full) is capped at `FREEBUFF_REWARD_MAX_DAILY_SESSIONS = 1`. Streaks add +1 every 7 days.

**Referrals** (`freebuff-referral-tiers.ts`): GitHub account ≥ 4 months. Full: +1 daily GLM session per qualified referral (signup cap 100). Limited: +1 pool session, `REFERRAL_CLI_DAILY_SESSION_BONUS_CAP = 3`.

**Freebucks** (`FreebuffFreebucksInfo` in `common/src/types/freebuff-session.ts`): daily pool + wallet, per-model prices. GLM is 5/hour. Earn (`FREEBUFF_EARN_PATH = '/earn/trust'`) pays Freebucks for promoted-post engagements. Sessions are the rollback path.

**Levels** (`freebuff-levels.ts`) were retired 2026-09-07. Standing (`freebuff-standing.ts`: Getting started / Verified / Established / Core member) remains an anti-abuse scorer; the numeric matrix is export-excluded.

**Subscriptions** (`freebuff-subscriptions.ts`) top up the free pool. Totals (free + plan): Free 4/14/40, Starter $8 (+3/day), Plus $25, Pro $60. House ads sell “N more a day”.

**Credits** are Codebuff’s paid unit. FREE mode zeros allowlisted pairs (`isFreeMode` / `isFreeModeAllowedAgentModel` in `free-agents.ts`).

---

## 2. Ad system

Ads are not a banner bolted onto chat. They are a multi-rail marketplace with shared channel logic in `common/src/ads/` so CLI, Desktop, and Web cannot drift.

### Two products, one console

`freebuff-ads.ts` and `freebuff-placements.ts` document the split:

1. **Engagement marketplace.** Advertisers fund a campaign at a whole-dollar daily rate (`AD_MIN_DAILY_BUDGET_CENTS = 1000`, $0.50 per engagement). Users like / comment / star a real post on X, LinkedIn, Reddit, or GitHub and submit evidence. This is how Freebucks are earned. Flat price, no auction. Delivery is paced with jittered hourly windows so the Pacific midnight reset is not farmable.
2. **Placements rail.** First-party text (and, on Desktop, image-led) ads in product inventory. Billed on clicks. `PRIMARY_METRICS = billableClicks, activations, spend, avgCpc, avgCpa`. CTR is diagnostic, over *viewed* impressions.

They share advertiser identity and Stripe, not delivery or billing. A third rail: **sponsored proposals** — an advertiser’s agent offers to open a branch in the user’s repo.

### Architecture of `common/src/ads/`

Dependency-free (no React/Convex/DOM). Surfaces import view-models and layout.

Layout and telemetry: `inline-ad-layout.ts` (`getInlineAdLayout`, `getDockAdLayout`, `getDockPanelLayout` — terminal and advertiser preview must agree), `waiting-room-placements.ts` (`visibleWaitingRoomPlacementIds`), `accent-span.ts` (`stripAccentSpan` so `*word*` markup never prints in a TTY), `ad-event-hygiene.ts` (`X-Freebuff-Event-Id`, render delay, `clientFamilyFromUserAgent` — telemetry must never fail a revenue ack), `first-party-view-ack.ts` (`acknowledgeFirstPartyView`: 3 attempts, 2s timeout, remount dedupe), `sponsor-break-events.ts` (`ads.break_shown` / `break_closed` / `break_clicked`; continuation is derived, not emitted).

Sponsored work: `sponsored-proposal-view.ts` (`sponsoredProposalViewModel`), `sponsored-proposal-target.ts` (`repoFullNameFromRemote` — same `(user, owner/name)` key on every surface), `sponsored-consent.ts` (one product sentence + escaped advertiser name), `sponsored-capabilities.ts` (every tool classified into `read_workspace` / `write_workspace` / `agent_control` / `run_commands` / `network` / `human_in_loop` / `delegate`; unknown tools refuse), `sponsored-local-execution.ts` (grant is a function of containment: `sandbox-exec` / `bubblewrap` / Windows denied), `sponsored-compute-contract.ts` ($0.50 DeepSeek Flash grant, $2 accept), `sponsored-run-token.ts` (24h TTL), `sponsored-proposal-conformance.ts` (VM/R/C/V/B/E check IDs).

`sanitizeAdUrl` / `sanitizeAdText` in `common/src/util/ad-creative-safety.ts` strip CSI/OSC, bidi overrides, and non-https schemes. Applied at serve, not only at ingest.

### Types, placements, rotation, caps

`PLACEMENT_SLOTS` is the sellable catalog. Every id is one a shipping client actually sends: `waiting-room-1..4` (CLI landing), `CLI-Chat-Inline` (lazy interspersed), `Single-Ad-Unit-1` (above-input dock), Desktop inline/below-chat, three sponsor breaks (`Desktop-Spotlight`, `Desktop-Showcase`, `Desktop-Intermission`), and Web after-user / after-assistant / above-input slots.

Formats: `inline` | `showcase` | `spotlight` | `intermission`. Spotlight and Intermission *interrupt* and are rationed (`isInterruptingBreakFormat`): at most one per user per UTC day, never in the first ten minutes of a session, never without Redis to count them. Showcase is the same above-composer slot drawn taller — capping it would make the A/B unrunnable.

CLI rotation (`cli/src/hooks/use-gravity-ad.ts`): `AD_ROTATION_INTERVAL_MS = 60_000`; `MAX_ADS_AFTER_ACTIVITY = 3` then pause until the user is active (`ACTIVITY_THRESHOLD_MS = 30_000`); cache of 50 sets; compact terminals (`height ≤ 17`) hide ads *except* in Freebuff. Inline transcript ads use a lazy four-ad pool per assistant answer, then repeat.

Providers on the wire: `'gravity' | 'carbon' | 'zeroclick' | 'first_party'`. The server owns fallback order. House ads (`HOUSE_AD_CREATIVES`) are a total floor over every surface — last-resort copy that cannot itself return nothing.

### Fetch and TUI render

`useGravityAd` POSTs to `${WEBSITE_URL}/api/v1/ads` with bearer auth. Body: `{ provider, messages, sessionId, device, surface, placementId(s), userAgent, cliDockArm? }`.

`convertToAdMessages` sends only user/assistant *text* (no images, no `INSTRUCTIONS_PROMPT` tags). `getDeviceInfo` sends `{ os, timezone, locale }`. Native UAs look like bots, so a shared browser-like UA (`getAdUserAgent`) is sent for the network; the real product UA (`Freebuff-CLI/<version>`) is the request header so `clientFamilyFromUserAgent` can still classify the client.

Normalized `AdResponse`: `adText`, `title`, `cta`, `url`, `favicon`, `clickUrl`, `impUrl`, `placementId`, `provider`, optional dock extras (`expandedBody`, `bullets`, `diagram`), `receivedAtMs` for render-delay telemetry.

Rendering (`cli/src/components/ad-banner.tsx`) is character-grid, not CSS:

- Landing: `ChoiceAdBanner`, 5-row cards (`AD_CARD_HEIGHT = 5`). Width is subtracted from the model picker.
- Transcript inline: 4-row card. Below 48 columns the destination domain is dropped (`MIN_INLINE_WIDTH_WITH_DESTINATION`). Floor is 20 columns (`MIN_INLINE_AD_WIDTH`) so a cut title cannot become a different product.
- Dock V2: above-input bar with a CTA box. Expand (`getDockPanelLayout`) only if the panel will not cover the composer. Degradation: drop diagram → bullets → extra body lines → refuse to open.

Disclosure is always `Ad` or `Sponsored`. Impressions fire once per `impUrl` (`claimAdImpression`). First-party views use `acknowledgeFirstPartyView`; third-party keep a pixel. Dock expand is *not* billable. Accidental clicks (<300 ms) are labelled, never dropped.

### Privacy, model access, opt-out

Public copy is generated from `FREEBUFF_PUBLIC_DATA_USE_COPY` (`freebuff-data-use.ts`) so README, CLI, and the website cannot drift:

- Prompts and messages **may be analyzed to personalize ads**.
- Separately uploaded files and connected repositories are **not** given to advertising providers.
- Models labelled “May use data for AI training” may keep submissions. Agent `providerOptions.data_collection: 'deny'` is the OpenRouter enforcement (`getBase2ProviderOptions`).
- An ad fetch sends conversation text, OS, timezone, locale, session id, surface, placement, and a browser-like UA — not the file tree, not repo contents.

Sponsored proposals are a different contract. Default `why_this`: matched to the project; code is not read without go-ahead. Accept opens `SPONSORED_CONSENT_SENTENCE`. The run is capability-sandboxed; `evaluateSponsoredWritePath` refuses `.git`, CI workflows, and credential files.

Ads do not mint credits in FREE mode (`SPEC.md` §12). They fund the included catalog at the business layer. There is no “watch an ad, get a session” button. Closest loops: engagement marketplace → Freebucks; house ads → paid plan → more sessions; sponsored accept → advertiser pays $2 (Cloud is campaign-metered; CLI/Desktop spends the *user’s* own session, disclosed on the card).

`/ads:disable` is Codebuff-only (hidden in Freebuff). Proposal opt-out turns off sponsored *proposals* only. Never-advertiser / Report are per-proposal. A subscription adds sessions; **ads stay**. Codebuff hides ads at ≤17 rows; Freebuff does not.

### OSS-implementable vs backend-only

**Implementable without their stack:** character-grid inline/dock layout; always-on ads as the price of included models; paid plan buys capacity, not silence; house-ad floor that cannot fail; activity-gated rotation; https-only destinations and ANSI/bidi stripping; first-party view ack with retry; separate display-ad vs sponsored-work controls; send only chat text + coarse device signals.

**Requires a real backend:** multi-provider auction and spend ledger; advertiser console / Stripe daily subscriptions / Pacific-day caps; sponsor-break experiment arms; sponsored-proposal executor and OS sandbox; engagement marketplace; geo tier, Trust scorer, Freebucks wallet.

For RavenClaw v1, a single first-party JSON feed plus a house-ad floor is enough to prove the UX. The marketplace is a company, not a library.

---

## 3. Agent runtime

`packages/agent-runtime/` is the loop. Hosts inject LLM, DB, and analytics contracts.

`loopAgentSteps` (`run-agent-step.ts:689`) is the turn:

1. Resolve `AgentTemplate`. Context-pruner runs get untracked ids (`UNTRACKED_RUN_ID_PREFIX`) so they do not pay three web-API round trips per step.
2. Build system prompt (or inherit parent’s, for cache hits), tool set, and initial messages: user prompt + `instructionsPrompt`.
3. `while (true)`: estimate context tokens locally (GPT-4o BPE); if `compactContext`, `maybeCompactHistory` (`compact-history.ts`) rewrites old history with no model call; if the agent has `handleSteps`, `runProgrammaticStep` runs the generator first; if `shouldEndTurn`, break (unless `outputSchema` is missing — one forced `set_output` retry); else `runAgentStep` streams the model (`processStream` / `tool-stream-parser.ts`) and executes tools (`tool-executor.ts`). `drainSteeringMessages` can append user text between steps without aborting.
4. Stop: `end_turn` tool, no tool calls, `stepsRemaining <= 0` (`maxAgentSteps`), abort, or missing required output after retry.

`runAgentStep` drops unanswered tool calls (DeepSeek 400s on orphans), injects `stepPrompt`, and refuses assistant-prefill on models that reject it.

`handleSteps` is a generator serialized with `.toString()` and `eval`’d. That is why helpers used inside it must be inlined (context-pruner cannot import `compact-history.ts`). Yield a tool call, `'STEP'`, `'STEP_ALL'`, or `STEP_TEXT` / `GENERATE_N`. The generator can override the model’s `end_turn` (`loop-agent-steps.test.ts`).

Tools live in `common/src/tools` and are executed by `packages/agent-runtime/src/tools/handlers/tool/*`. `spawn_agents` validates the child against the parent’s `spawnableAgents`, creates `AgentState`, and `Promise.allSettled`s children. Subagent chunks stream via `sendSubagentChunk`. `run_terminal_command` is split: SDK owns the process group; the CLI’s `entry.ts` broker keeps mouse/focus protocols alive.

### Context pruning

Two implementations, one algorithm, a parity test (`context-pruner-parity.test.ts`):

- **base2**: every step `spawn_agent_inline`s `context-pruner` (`agents/context-pruner.ts`). Mechanical summary, not an LLM rewrite. Blacklists bulky spawn outputs (file-picker, researcher, basher, reviewer). Triggers on context limit *or* cold prompt cache (`cacheExpiryMs`, `cacheExpiryMinTokens`).
- **base3**: `compactContext: compactionPolicyForModel(model)` on the definition. Same rewrite in-process.

Budgets: ~13k user / 1.3k assistant / 5k tool chars per entry; 50k user / 20k assistant+tool token budgets. Truncation keeps 80% head + 20% tail.

### Agent definition type

`agents/types/agent-definition.ts` → `AgentDefinition`: `id`, `displayName`, `model`, `providerOptions` (OpenRouter order, `data_collection`, `max_price`), `toolNames`, `spawnableAgents`, `mcpServers`, `inputSchema`, `outputMode` (`last_message` | `all_messages` | `structured_output`), `outputSchema`, `spawnerPrompt`, `systemPrompt`, `instructionsPrompt` (re-injected after every user message — **breaks prompt cache**; base3 therefore omits it), `stepPrompt`, `includeMessageHistory`, `inheritParentSystemPrompt`, `windowedFileReads`, `compactContext`, optional `handleSteps`. This is the public SDK contract.

---

## 4. Specialist agents

**base2** (`agents/base2/base2.ts`, `createBase2('free', …)`): orchestrator. Lean/free mode edits with `str_replace` / `write_file` itself, then spawns a same-model reviewer and several `basher`s. `base2HandleSteps` is an infinite loop that only spawns `context-pruner` then `STEP`. Spawn list: `file-picker`, `code-searcher`, `researcher-web`, `researcher-docs`, `basher`, `tmux-cli`, `browser-use`, per-model `code-reviewer-*`, optional Gemini thinker, `context-pruner`.

**base3** (`agents/base3.ts`, `createBase3` / `createBase3CliRoot`): single loop. No subagents, no reviewer. Tools: read/edit/search/glob/list/todos, plus CLI extras (`web_search`, `read_url`, `ask_user`, `suggest_followups`, `gravity_index`, `render_ui`, `skill`). Mechanical compaction. This is the live Freebuff harness (`base3-free-<model>`). base2 remains the kill-switch (`FREEBUFF_BASE3_HARNESS_DISABLED`).

Roots are pinned one model per id (`FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL`, `FREE_MODE_AGENT_MODELS`). A session admitted on Flash cannot spawn a Luna reviewer (`session_model_mismatch`). `FREEBUFF_REVIEWER_AGENT_ID_BY_MODEL` exists so a base2 rollback cannot fall through to the Flash reviewer on a non-Flash session.

- `file-picker` / `-max` (Gemini Flash Lite): find files; no history; programmatically spawns `file-lister`.
- `code-searcher`: ripgrep. `editor` / best-of-n: paid default/max; write-only; `structured_output`.
- `basher` (Gemini 3.5 Flash Lite): one shell command, optional summarize.
- `researcher-web` / `-docs` (Flash Lite): must `read_url` ≥3 pages before answering.
- `code-reviewer-*`: same model as parent; after edits; no tools; inherits history.
- `thinker` / Gemini thinker: no tools; structured `{ message }`. Gemini Pro is the only sanctioned Pro path (`canFreebuffModelSpawnGeminiThinker`).
- `browser-use` (Flash Lite): Chrome DevTools. `librarian` (MiniMax M3): shallow-clone a GitHub repo.
- `context-pruner`: mechanical rewrite every base2 step.

Communication is **tool-shaped**, not a blackboard. Parent calls `spawn_agents` with a prompt; child returns `outputMode`. History is opt-in. Parallel spawn is the default. Free-mode abuse control: only `FREE_MODE_AGENT_MODELS` combinations are 0-credit, and only with publisher `codebuff` or none. Lightweight helpers are also in `FREE_TIER_AGENTS` so BYOK users are not nickeled for a file-picker.

---

## 5. LLM provider layer

`packages/llm-providers/` is a thin OpenAI-compatible AI-SDK shim. Real routing is in the unpublished web API (OpenRouter `provider.order`, `max_price`, per-model handlers).

Public and load-bearing: free mode is server-paid and allowlisted; BYOK is `CODEBUFF_BYOK_OPENROUTER` / `x-openrouter-api-key` (`byok.ts`). Muse Spark is team-rate-limited; after `MUSE_SPARK_FALLBACK_AFTER_MS = 15_000` the turn lands on `MUSE_SPARK_FALLBACK_MODEL_ID` = DeepSeek Flash — already entitled. Price fences (`FREEBUFF_*_MAX_PRICE`) sit between cheap and dear OpenRouter bands so a 2× endpoint cannot silently serve. Anthropic is `only: ['amazon-bedrock']` + `data_collection: 'deny'`. Training-labelled rows carry `dataUse: 'training'`. Soft per-session pacing lives in `FREEBUFF_PER_MODEL_SESSION_SPEND_CAPS`. Helper path: `promptFlashWithFallbacks` (Gemini → Vertex → GPT-4o or Claude).

Lesson: pin each free agent to one model, coerce instead of refuse, fall back only to something already entitled, and make a provider reprice a 404, not an invoice.

---

## 6. CLI / TUI

OpenTUI + React (`cli/src/app.tsx`, `chat.tsx`). Ads, agents, and input share one grid (`grid-layout.tsx`).

**Ads.** `chat.tsx` always mounts `useGravityAd` in Freebuff (`enabled: IS_FREEBUFF || !hasSubscription`). Rotating dock on `Single-Ad-Unit-1`; lazy inline on `CLI-Chat-Inline`. Landing (`freebuff-landing-screen.tsx`) uses waiting-room placements and subtracts `AD_CARD_HEIGHT` from the picker. Sponsored proposals are transcript blocks (`sponsored-proposal-block.tsx`) driven by the same view-model as Web.

**Progress.** Agent trees render as `message-with-agents.tsx` / `agent-block-grid.tsx`. Todos use `write_todos`. Thinking is `thinking-block.tsx`. `Ctrl+T` collapses agent trees. Subagent streams arrive as `PrintModeEvent`s.

**Diffs.** `cli/src/components/tools/diff-viewer.tsx` colors `+` / `-` / hunk headers. `str_replace` / `write_file` / `apply_patch` each have a tool renderer. File edits run locally; the TUI shows the patch.

**Permissions.** There is no Cursor-style per-tool permission modal. The agent runs commands via the broker. Sponsored runs are the exception: consent dialog, capability grant, OS sandbox, Windows refusal. Ordinary Freebuff is “you launched it, it can edit and shell.” Destructive git/push is prompt-level policy, not a kernel.

**Session UX.** `use-freebuff-session.ts` polls `/api/v1/freebuff/session`. The model selector shows access tier, Freebucks prices, peak surcharges, data-use badges, and locked plan-only rows. Referral and Earn copy is one shared string across CLI, Desktop, and Web.

---

## 7. What RavenClaw should steal vs skip

### Ad-funded free tier — steal

1. **Ads buy capacity, not silence.** A paid plan adds sessions. “Pro = no ads” trains users to treat ads as a defect. House ads that sell the plan must not reach people who already bought it.
2. **Terminal-native layout as a shared pure module.** Width-aware truncation, 20-column title floor, drop the destination before the claim, never cover the composer. Preview the same function in any advertiser UI.
3. **Activity-gated rotation.** 60s rotate, pause after idle impressions, resume on keystrokes. Ack on mount; remount-dedupe. Accidental clicks labelled, not unbilled.
4. **First-party inventory + house floor.** One JSON feed. Third-party networks are a backend, a bot-UA problem, and a privacy story.
5. **Privacy contract in generated copy.** Personalize from prompts/messages only. Never send the repo. https-only destinations. Strip ANSI/bidi. Disclose `Ad`.
6. **Two switches if you add sponsored work.** Display ads ≠ an advertiser agent in the user’s tree.

Skip for v1: engagement marketplace, full-screen breaks, sponsored proposals, geo tiers, Trust/Levels, dual meters, multi-provider auctions.

### Multi-agent architecture — steal

1. **`AgentDefinition` as the public unit.** File-per-agent: id, model, tools, spawn list, schemas, three prompt slots, optional `handleSteps`.
2. **Start with base3, not base2.** One loop, own tools, mechanical compaction. Freebuff moved the free product onto base3 and kept base2 as a kill switch.
3. **Cheap specialists on a Flash-class model, pinned.** File finding and single-command bash do not need the user’s coding model. Allowlist helper + model so a free session cannot escalate via `thinker`.
4. **Same-model reviewer if you review at all.** Cross-model children 403 a session-locked free tier.
5. **Mechanical compaction over LLM summaries.** Keep paths, commands, user text. Trigger on window *and* cold cache.
6. **Spawn is a tool, history is opt-in, parallel is default.**
7. **Coerce, don’t 403, when a model leaves the catalog.**

Skip / later: `handleSteps` via `toString()`+`eval`; best-of-N editors; hidden Gemini-Pro thinker; librarian / browser-use; cache-breaking `instructionsPrompt` on the root; a publisher/version agent store.

### Over-scoped for RavenClaw v1

Five surfaces, two ad products, break formats, a Trust ladder, dual meters, geo tiers, and sponsored local execution. That is a company that already has advertisers.

RavenClaw v1: one CLI, one first-party ad slot that does not cover the input, one house-ad fallback, one included model (plus BYOK), one root agent that can read/edit/shell and optionally spawn a file-finder and a command runner, mechanical context trim, and a privacy sentence the UI implements.

The idea worth protecting: **ads are a first-class, character-accurate product surface that pays for a locked-down free agent, and the agent is a typed definition that can spawn cheaper specialists without sharing a brain.**
