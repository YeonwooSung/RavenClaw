# Slack / Discord / ACP skip UI — Implementation Plan

I'm using the writing-plans skill to create the implementation plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host parity for `'ignored'`. Slack Skip button + `skip`/`ignore`/`ignored` text, Discord skip text, and ACP Skip option emit the existing `PendingAskAnswer` `'ignored'`. Engine, pairing, HTTP, Ink, OpenTUI stay. Spec + this plan first; then TDD in this isolated worktree.

**Architecture:** Widen host answer unions only. Slack `permissionBlocks` grows Skip (`raven_skip`, value `callId`). `permissionAnswerOf` / `tryResolvePermit` / `parsePermitReply` map that control onto `'ignored'`. Discord `parsePermitReply` grows the same text aliases. ACP appends `{ optionId: 'ignored', name: 'Skip', kind: 'reject_once' }` and maps `ignored`/`skip`/`ignore` → `'ignored'`. Crash-resume skip is `applyAskAnswer(callId, 'ignored')` and does not `submitMessage`. No fourth host entry. No schema bump.

**Tech Stack:** Bun, TypeScript, existing Slack/Discord adapters and ACP protocol/server.

**Spec:** `docs/superpowers/specs/2026-09-22-hitl-skip-hosts.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. **`applyAskAnswer` remains the only non-`submitMessage` closer.** Skip is `'ignored'` through existing `askUser` / `applyAskAnswer`. A fourth host entry is forbidden.
- Pairing 1:1. Persist-before-execute stays. Parked ignored still does not start a model turn. Live ignored still continues (`abortRest: false`).
- Engine already accepts `'ignored'`. This door is **hosts only**. Do **not** edit `session-engine.ts`, `phases.ts`, `pending-asks.ts`, pairing, HTTP resolve, Ink, OpenTUI.
- `dontAsk` leftover stays deny, not ignored. Non-DM Slack/Discord still auto-deny (not skip).
- Abort-pair I2 stays `ABORTED_TEXT`. Timeout / editor `cancelled` stay as today (deny or leave-row). Skip is an operator answer.
- Default prefix unchanged. No new tool. No schema bump. No `bun.lock`. No docker work.
- BYOK. Clean-room. **No web UI. No Slack/Discord Allow-always button. No timeout→ignored. No cancelled→ignored. No dismiss-all host button.**
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push.

## Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification only.

1. **IN is skip UI on Slack, Discord, and ACP.** Each host can emit `'ignored'`. Engine, pairing, HTTP, Ink, OpenTUI stay. Do not invent `'skip'` as an engine answer. User-facing copy is **Skip**; the stored answer is `'ignored'`.

2. **Slack buttons.** `permissionBlocks` appends a third button after Deny: `text: 'Skip'`, `action_id: 'raven_skip'`, `value: callId`. No `style` on Skip. Deny keeps `style: 'danger'`. Order is Allow, Deny, Skip.

3. **Slack live + crash-resume mapping.** `tryResolvePermit` block_actions: `raven_skip` (and `actionValue === 'skip'`, same fallback shape as allow/deny) → `pending.resolve('ignored')`. `permissionAnswerOf`: `raven_skip` → `'ignored'`. Unknown `action_id` still `undefined` / `false` (re-queue). Do not treat `raven_mystery` as skip.

4. **Slack / Discord text.** `parsePermitReply` accepts `skip`, `ignore`, `ignored` (trim + lower, whole message like today’s `allow`/`deny`). Do **not** parse `always` / `allow_always` this door. Do not export `parsePermitReply`; Slack tests go through exported `tryResolvePermit` / `permissionBlocks`; Discord tests go through the live adapter.

5. **Prompt copy.** Slack durable: `Reply *allow*, *deny*, or *skip*.` Slack non-durable adds ` (${seconds}s)` in the same place as today. Discord has no markdown stars: durable `Reply allow, deny, or skip.` Non-durable adds the seconds in the same place as today.

6. **Types.** `SlackPermissionAnswer` and `DiscordPermissionAnswer` add `'ignored'`. `allow_always` stays on the union and stays unused in parse. `applyAskAnswer` on those bound sessions already forwards the host answer; widening the union is enough for crash-resume skip. ACP `AcpPermissionAnswer` adds `'ignored'`.

7. **ACP option.** Append to `PERMISSION_OPTIONS` after deny:

   ```
   { optionId: 'ignored', name: 'Skip', kind: 'reject_once' }
   ```

   Do not add a new `PermissionOptionKind`. Sensitive-path filter still drops **only** `allow_always`. Skip remains on `.env` / `id_rsa`. `mapPermissionOptionId`: `ignored` / `skip` / `ignore` → `'ignored'`. `cancelled` and unknown stay `'deny'`. Also accept a raw string `'ignored'` in `permissionOutcome` (same first-line equality as allow/deny/allow_always). `server.ts` options filter stays `optionId !== 'allow_always'`; do not add a cancelled→ignored branch.

8. **Timeout / cancel / non-DM unchanged.** Slack durable timeout still leaves the row. Slack/Discord non-durable timer still `'deny'`. ACP timeout still `AskWaiterExpired`. ACP `cancelled` still `'deny'`. Esc / `abort('cancel')` still `ABORTED_TEXT`. Slack/Discord `askUser` outside a DM still returns `'deny'` immediately, no prompt, no skip. **No new timeout or non-DM tests** beyond existing still passing.

9. **Crash-resume.** Slack leftover Skip button and Discord leftover skip text call `applyAskAnswer(callId, 'ignored')` and do not `submitMessage` (same shape as today’s allow crash-resume tests).

10. **Docs honesty in Task 4 after code.** Spec Status → implemented; board S1–S4 **done**; Shipped sha empty. Stop saying Slack/Discord/ACP stay 3-way. No version bump. Do not rewrite `2026-09-15-eve-inspired-roadmap.md` except if a one-line pointer is required (this door does not require that file). Do not edit remaining-roadmap.

11. **Worktree.** Implement in this worktree (`/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/hitl-skip-hosts`) or a later isolated worktree. Never on `main`. Do not push.

---

## File map

| File | Responsibility |
|---|---|
| `packages/cli/src/slack/types.ts` | `SlackPermissionAnswer += 'ignored'` |
| `packages/cli/src/slack/adapter.ts` | Skip button; `raven_skip` → ignored; parse skip/ignore/ignored; prompt mentions skip |
| `packages/cli/src/slack/adapter.test.ts` | blocks, live skip, crash-resume ignored |
| `packages/cli/src/discord/types.ts` | `DiscordPermissionAnswer += 'ignored'` |
| `packages/cli/src/discord/adapter.ts` | parse skip/ignore/ignored; prompt mentions skip |
| `packages/cli/src/discord/adapter.test.ts` | live skip aliases; crash-resume ignored |
| `packages/acp/src/protocol.ts` | `AcpPermissionAnswer += 'ignored'`; PERMISSION_OPTIONS Skip; map ignored/skip/ignore |
| `packages/acp/src/protocol.test.ts` | permissionOutcome skip + cancelled/unknown still deny |
| `packages/acp/src/server.ts` | no filter change; Skip remains on sensitive paths |
| `packages/acp/src/server.test.ts` | editor Skip → `'ignored'`; sensitive still has Skip |
| docs listed in Task 4 | honesty after code |

Leave `session-engine.ts`, `phases.ts`, `pending-asks.ts`, pairing, HTTP resolve, Ink, OpenTUI, schema, docker tools, `bun.lock`.

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 S1 Slack | `packages/cli/src/slack/types.ts`, `adapter.ts`, `adapter.test.ts` |
| 2 S2 Discord | `packages/cli/src/discord/types.ts`, `adapter.ts`, `adapter.test.ts` |
| 3 S3 ACP | `packages/acp/src/protocol.ts`, `protocol.test.ts`, `server.ts`, `server.test.ts` |
| 4 S4 Docs | `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`, `SLASH_COMMANDS.md`, `SLASH_COMMANDS.ko.md`, `CHANGELOG.md`, `docs/research/eve-analysis.md`, `docs/research/eve-analysis.ko.md`, `docs/superpowers/specs/2026-09-21-ignored-dismiss.md` ruling 13, `docs/superpowers/specs/2026-09-22-hitl-skip-hosts.md` Status |

Task 1 first. Task 2 independent of 1 (different package). Task 3 independent of 1–2. Task 4 last after 1–3 are green.

---

### Task 1: S1 Slack Skip button + text

**Files:**
- Modify: `packages/cli/src/slack/types.ts:5`
- Modify: `packages/cli/src/slack/adapter.ts` (`tryResolvePermit` ~327–343, `permissionAnswerOf` ~352–359, `parsePermitReply` ~362–366, prompt ~384–386, `permissionBlocks` ~441–462)
- Modify: `packages/cli/src/slack/adapter.test.ts` (import `SlackPermissionAnswer`; blocks ~540; live skip after blocks; crash-resume after allow ~846)

**Interfaces:**
- Consumes: existing `tryResolvePermit`, `permissionBlocks`, `applyAskAnswer`, `askUser`
- Produces: `SlackPermissionAnswer` includes `'ignored'`; Skip button; live/crash-resume skip settles `'ignored'`

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/slack/adapter.test.ts`, add `SlackPermissionAnswer` to the type import from `./types`.

Widen the existing `tryResolvePermit does not call abort or enqueueSteer` inline union (~510–514) so it still typechecks after the host union grows:

```ts
    const permits = new Map<
      string,
      Array<{ resolve: (answer: SlackPermissionAnswer) => void; callId: string }>
    >()
    let answered: SlackPermissionAnswer | undefined
```

Do not change that test’s assertions.

Next to `slack allow button value is the call id` (~540), add:

```ts
  test('slack permission blocks include Skip without danger style', () => {
    const blocks = permissionBlocks('call_1', 'Bash', 'Allow Bash?')
    const actions = (
      blocks[1] as {
        elements: Array<{
          value: string
          action_id: string
          style?: string
          text: { type: string; text: string }
        }>
      }
    ).elements
    expect(actions).toHaveLength(3)
    expect(actions[0]).toMatchObject({
      action_id: 'raven_allow',
      value: 'call_1',
      text: { type: 'plain_text', text: 'Allow' },
    })
    expect(actions[1]).toMatchObject({
      action_id: 'raven_deny',
      value: 'call_1',
      style: 'danger',
      text: { type: 'plain_text', text: 'Deny' },
    })
    expect(actions[2]).toMatchObject({
      action_id: 'raven_skip',
      value: 'call_1',
      text: { type: 'plain_text', text: 'Skip' },
    })
    expect(actions[2]?.style).toBeUndefined()
  })

  test('tryResolvePermit raven_skip and skip text settle ignored', () => {
    const cases: Array<{ inbound: Parameters<typeof tryResolvePermit>[1]; answer: SlackPermissionAnswer }> = [
      {
        inbound: {
          kind: 'block_actions',
          team: 'T1',
          channel: 'D1',
          userId: 'U1',
          text: '',
          ts: '1.0',
          mentioned: false,
          actionId: 'raven_skip',
          actionValue: 'call_1',
        },
        answer: 'ignored',
      },
      {
        inbound: {
          kind: 'message',
          team: 'T1',
          channel: 'D1',
          userId: 'U1',
          text: 'skip',
          ts: '1.0',
          mentioned: false,
        },
        answer: 'ignored',
      },
      {
        inbound: {
          kind: 'message',
          team: 'T1',
          channel: 'D1',
          userId: 'U1',
          text: 'Ignore',
          ts: '1.0',
          mentioned: false,
        },
        answer: 'ignored',
      },
      {
        inbound: {
          kind: 'message',
          team: 'T1',
          channel: 'D1',
          userId: 'U1',
          text: 'ignored',
          ts: '1.0',
          mentioned: false,
        },
        answer: 'ignored',
      },
    ]
    for (const row of cases) {
      const permits = new Map<
        string,
        Array<{ resolve: (answer: SlackPermissionAnswer) => void; callId: string }>
      >()
      let answered: SlackPermissionAnswer | undefined
      permits.set('T1:D1:U1', [
        {
          callId: 'call_1',
          resolve: (answer) => {
            answered = answer
          },
        },
      ])
      expect(tryResolvePermit(permits, row.inbound)).toBe(true)
      expect(answered).toBe(row.answer)
    }
  })

  test('tryResolvePermit unknown action_id and always text do not settle', () => {
    const permits = new Map<
      string,
      Array<{ resolve: (answer: SlackPermissionAnswer) => void; callId: string }>
    >()
    let answered: SlackPermissionAnswer | undefined
    permits.set('T1:D1:U1', [
      {
        callId: 'call_1',
        resolve: (answer) => {
          answered = answer
        },
      },
    ])
    expect(
      tryResolvePermit(permits, {
        kind: 'block_actions',
        team: 'T1',
        channel: 'D1',
        userId: 'U1',
        text: '',
        ts: '1.0',
        mentioned: false,
        actionId: 'raven_mystery',
        actionValue: 'call_1',
      }),
    ).toBe(false)
    expect(answered).toBeUndefined()
    expect(
      tryResolvePermit(permits, {
        kind: 'message',
        team: 'T1',
        channel: 'D1',
        userId: 'U1',
        text: 'always',
        ts: '1.0',
        mentioned: false,
      }),
    ).toBe(false)
    expect(answered).toBeUndefined()
  })

  test('live askUser Skip button returns ignored and prompt mentions skip', async () => {
    const api = new FakeSlackApi()
    const socket = new FakeSlackSocket()
    let answered: SlackPermissionAnswer | undefined
    let askStarted!: () => void
    const sawAsk = new Promise<void>((resolve) => {
      askStarted = resolve
    })
    const origPost = api.postMessage.bind(api)
    api.postMessage = async (opts) => {
      const result = await origPost(opts)
      if (typeof opts.text === 'string' && opts.text.includes('Allow')) askStarted()
      return result
    }
    const running = runSlackAdapter({
      config: slackConfig(),
      socket,
      api,
      store: createMemoryStore(),
      openSession: async (req) => ({
        sessionId: 'sess_skip',
        async *submitMessage() {
          const ac = new AbortController()
          answered = await req.askUser(
            { id: 'call_1', tool: 'Bash', message: 'Allow Bash?' },
            ac.signal,
          )
        },
      }),
    })
    socket.push(dmMessage({ text: 'please', ts: '400.0' }))
    await sawAsk
    await new Promise((resolve) => setTimeout(resolve, 20))
    const prompt = api.posts.find((post) => typeof post.text === 'string' && post.text.includes('Allow'))
    expect(prompt?.text).toContain('skip')
    expect(prompt?.text).toContain('*allow*')
    expect(prompt?.text).toContain('*deny*')
    socket.push(blockActions({ actionId: 'raven_skip', value: 'call_1', envelopeId: 'env-skip' }))
    socket.end()
    await running
    expect(answered).toBe('ignored')
  })
```

After `crash-resume allow button calls applyAskAnswer and does not submitMessage` (~846), add:

```ts
  test('crash-resume skip button calls applyAskAnswer ignored and does not submitMessage', async () => {
    const store = createMemoryStore()
    const sessionId = 'sess_resume_skip'
    await store.upsertPendingAsk({
      callId: 'call_1',
      sessionId,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Allow Bash?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    const applied: Array<{ callId: string; answer: string }> = []
    const submitted: string[] = []
    const socket = new FakeSlackSocket()
    const running = runSlackAdapter({
      config: slackConfig(),
      socket,
      api: new FakeSlackApi(),
      store,
      openSession: async () => ({
        sessionId,
        async *submitMessage(input: UserSubmitInput) {
          submitted.push(submitText(input))
        },
        async applyAskAnswer(callId, answer) {
          applied.push({ callId, answer })
          await store.deletePendingAsk(callId)
          return 'matched'
        },
        listPendingAsks: () => store.listPendingAsks(sessionId),
        getPendingAsk: (callId) => store.getPendingAsk(callId),
      }),
    })
    socket.push(blockActions({ actionId: 'raven_skip', value: 'call_1' }))
    socket.end()
    await running
    expect(applied).toEqual([{ callId: 'call_1', answer: 'ignored' }])
    expect(submitted).toEqual([])
    expect(await store.listPendingAsks(sessionId)).toHaveLength(0)
  })
```

Keep the existing allow-button value test. Do not add new timeout or non-DM tests.

- [ ] **Step 2: Run tests to confirm they fail**

If bun type-checks `'ignored'` off the host union, apply the `types.ts` one-liner from Step 3 first so the tests compile. They must still fail on adapter behavior.

```bash
bun test ./packages/cli/src/slack/adapter.test.ts
```

Expected: FAIL — `permissionBlocks` has two buttons; `raven_skip` does not settle; live Skip does not return `'ignored'`; crash-resume skip does not call `applyAskAnswer` with `'ignored'`. Existing allow/deny/timeout/non-DM tests still compile.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/slack/types.ts`:

```ts
export type SlackPermissionAnswer = 'allow' | 'deny' | 'allow_always' | 'ignored'
```

`packages/cli/src/slack/adapter.ts`:

In `tryResolvePermit` block_actions, after the deny branch:

```ts
    if (action === 'raven_skip' || inbound.actionValue === 'skip') {
      pending.resolve('ignored')
      return true
    }
```

`permissionAnswerOf`:

```ts
function permissionAnswerOf(inbound: SlackInbound): SlackPermissionAnswer | undefined {
  if (inbound.kind === 'block_actions') {
    const action = inbound.actionId ?? ''
    if (action === 'raven_allow') return 'allow'
    if (action === 'raven_deny') return 'deny'
    if (action === 'raven_skip') return 'ignored'
    return undefined
  }
  return parsePermitReply(inbound.text)
}
```

`parsePermitReply`:

```ts
function parsePermitReply(text: string): SlackPermissionAnswer | undefined {
  const trimmed = slackUserText(text).toLowerCase()
  if (trimmed === 'allow' || trimmed === 'yes') return 'allow'
  if (trimmed === 'deny' || trimmed === 'no') return 'deny'
  if (trimmed === 'skip' || trimmed === 'ignore' || trimmed === 'ignored') return 'ignored'
  return undefined
}
```

Prompt in `askSlackPermission`:

```ts
  const prompt = durable
    ? `Allow \`${opts.event.tool}\`${child}? Reply *allow*, *deny*, or *skip*.`
    : `Allow \`${opts.event.tool}\`${child}? Reply *allow*, *deny*, or *skip* (${Math.round(opts.timeoutMs / 1000)}s).`
```

`permissionBlocks` elements: Allow, Deny (danger), then:

```ts
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Skip' },
          action_id: 'raven_skip',
          value: callId,
        },
```

No `style` on Skip. Do not add an Allow-always button. Do not remap durable abort/timer to ignored.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/cli/src/slack/adapter.test.ts
```

Expected: PASS. Skip button + text → `'ignored'`. Deny still danger. Unknown action_id re-queues. `always` does not parse. Existing durable leave-row / non-DM deny / allow crash-resume still green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/slack/types.ts \
  packages/cli/src/slack/adapter.ts \
  packages/cli/src/slack/adapter.test.ts
git commit -m "$(cat <<'EOF'
feat: Slack skip button and skip text emit ignored

Skip is raven_skip / skip|ignore|ignored. Deny stays danger.
Crash-resume skip uses applyAskAnswer and does not submit.
EOF
)"
```

---

### Task 2: S2 Discord skip text

**Files:**
- Modify: `packages/cli/src/discord/types.ts:33`
- Modify: `packages/cli/src/discord/adapter.ts` (`parsePermitReply` ~298–302, prompt ~320–322)
- Modify: `packages/cli/src/discord/adapter.test.ts` (live skip after leftover-ask labels ~407; crash-resume after allow ~672)

**Interfaces:**
- Consumes: existing `parsePermitReply`, `askUser`, `applyAskAnswer`
- Produces: `DiscordPermissionAnswer` includes `'ignored'`; skip/ignore/ignored text settles `'ignored'`

- [ ] **Step 1: Write the failing tests**

After `discord leftover-ask labels childSessionId` (~407), add:

```ts
  test('DM leftover-ask skip / ignore / ignored settles ignored and prompt mentions skip', async () => {
    for (const text of ['skip', 'ignore', 'ignored'] as const) {
      const store = createMemoryStore()
      const api = new FakeDiscordApi()
      const gateway = new FakeDiscordGateway()
      let answered: string | undefined
      let askStarted!: () => void
      const sawAsk = new Promise<void>((resolve) => {
        askStarted = resolve
      })
      const running = runDiscordAdapter({
        config: cfg({ allowFrom: ['U1'] }),
        pairingHome: home(),
        ledger: createMemoryDeliveries(),
        store,
        openSession: async (req) => ({
          sessionId: `sess_skip_${text}`,
          async *submitMessage() {
            const ac = new AbortController()
            askStarted()
            answered = await req.askUser(
              { id: 'call_1', tool: 'Bash', message: 'Allow Bash?' },
              ac.signal,
            )
          },
        }),
        gateway,
        api,
      })
      gateway.push(dmPayload({ id: `m-please-${text}`, authorId: 'U1', content: 'please' }))
      await sawAsk
      await new Promise((resolve) => setTimeout(resolve, 20))
      const prompt = api.posts.find((post) => post.content.includes('Allow'))
      expect(prompt?.content).toContain('skip')
      expect(prompt?.content).toContain('allow')
      expect(prompt?.content).toContain('deny')
      expect(prompt?.content.includes('*skip*')).toBe(false)
      gateway.push(dmPayload({ id: `m-${text}`, authorId: 'U1', content: text }))
      gateway.end()
      await running
      expect(answered).toBe('ignored')
    }
  })
```

After `crash-resume allow text calls applyAskAnswer and does not submitMessage` (~672), add:

```ts
  test('crash-resume skip text calls applyAskAnswer ignored and does not submitMessage', async () => {
    const store = createMemoryStore()
    const sessionId = 'sess_resume_skip'
    await store.upsertPendingAsk({
      callId: 'call_1',
      sessionId,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Allow Bash?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    const applied: Array<{ callId: string; answer: string }> = []
    const submitted: string[] = []
    const gateway = new FakeDiscordGateway()
    const running = runDiscordAdapter({
      config: cfg({ allowFrom: ['U1'] }),
      pairingHome: home(),
      ledger: createMemoryDeliveries(),
      store,
      openSession: async () => ({
        sessionId,
        async *submitMessage(input: UserSubmitInput) {
          submitted.push(submitText(input))
        },
        async applyAskAnswer(callId, answer) {
          applied.push({ callId, answer })
          await store.deletePendingAsk(callId)
          return 'matched'
        },
        listPendingAsks: () => store.listPendingAsks(sessionId),
        getPendingAsk: (callId) => store.getPendingAsk(callId),
      }),
      gateway,
      api: new FakeDiscordApi(),
    })
    gateway.push(dmPayload({ id: 'm-skip', authorId: 'U1', content: 'skip' }))
    gateway.end()
    await running
    expect(applied).toEqual([{ callId: 'call_1', answer: 'ignored' }])
    expect(submitted).toEqual([])
    expect(await store.listPendingAsks(sessionId)).toHaveLength(0)
  })
```

Do not export `parsePermitReply`. Do not add an Allow-always Discord button. Do not add new timeout tests.

- [ ] **Step 2: Run tests to confirm they fail**

If bun type-checks `'ignored'` off `DiscordPermissionAnswer`, apply the `types.ts` one-liner from Step 3 first so the tests compile. They must still fail on adapter behavior.

```bash
bun test ./packages/cli/src/discord/adapter.test.ts
```

Expected: FAIL — `skip` does not settle; prompt has no skip; crash-resume skip does not call `applyAskAnswer` with `'ignored'`. Existing deny/timeout/allow crash-resume still compile.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/discord/types.ts`:

```ts
export type DiscordPermissionAnswer = 'allow' | 'deny' | 'allow_always' | 'ignored'
```

`packages/cli/src/discord/adapter.ts` `parsePermitReply`:

```ts
function parsePermitReply(text: string): DiscordPermissionAnswer | undefined {
  const trimmed = text.replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  if (trimmed === 'allow' || trimmed === 'yes') return 'allow'
  if (trimmed === 'deny' || trimmed === 'no') return 'deny'
  if (trimmed === 'skip' || trimmed === 'ignore' || trimmed === 'ignored') return 'ignored'
  return undefined
}
```

Prompt in `askDiscordPermission`:

```ts
  const prompt = durable
    ? `Allow \`${opts.event.tool}\`${child}? Reply allow, deny, or skip.`
    : `Allow \`${opts.event.tool}\`${child}? Reply allow, deny, or skip (${Math.round(opts.timeoutMs / 1000)}s).`
```

Do not parse `always`. Non-DM `askUser` still returns `'deny'` before posting. Non-durable timer still `'deny'`. Durable abort still leaves the row.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/cli/src/discord/adapter.test.ts
```

Expected: PASS. `skip`/`ignore`/`ignored` → `'ignored'`. Prompt mentions skip without markdown stars. Crash-resume skip uses `applyAskAnswer` and does not submit. Existing deny/timeout still green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/discord/types.ts \
  packages/cli/src/discord/adapter.ts \
  packages/cli/src/discord/adapter.test.ts
git commit -m "$(cat <<'EOF'
feat: Discord skip text emits ignored

skip / ignore / ignored settle ignored. Prompt mentions skip.
Crash-resume skip uses applyAskAnswer and does not submit.
EOF
)"
```

---

### Task 3: S3 ACP Skip option

**Files:**
- Modify: `packages/acp/src/protocol.ts` (`AcpPermissionAnswer` ~102, `PERMISSION_OPTIONS` ~112–116, `permissionOutcome` ~351–352, `mapPermissionOptionId` ~369–383)
- Modify: `packages/acp/src/protocol.test.ts` (`permissionOutcome` describe ~128)
- Modify: `packages/acp/src/server.ts` only if the sensitive filter needs a comment/no-op confirmation — filter stays `optionId !== 'allow_always'`
- Modify: `packages/acp/src/server.test.ts` (permission_ask ~490; sensitive ~713)

**Interfaces:**
- Consumes: existing `permissionOutcome`, `PERMISSION_OPTIONS`, `askPermissionOnce` options filter
- Produces: `AcpPermissionAnswer` includes `'ignored'`; editor Skip → `'ignored'`; `cancelled` still `'deny'`

- [ ] **Step 1: Write the failing tests**

In `packages/acp/src/protocol.test.ts`, import `PERMISSION_OPTIONS` next to `permissionOutcome`. Replace the `permissionOutcome` test body (~128–141) with:

```ts
describe('permissionOutcome', () => {
  test('maps ACP option ids and unknown outcomes to deny', () => {
    expect(permissionOutcome({ outcome: { outcome: 'selected', optionId: 'allow' } })).toBe('allow')
    expect(permissionOutcome({ outcome: { outcome: 'selected', optionId: 'allow-once' } })).toBe(
      'allow',
    )
    expect(permissionOutcome({ outcome: { outcome: 'selected', optionId: 'allow_always' } })).toBe(
      'allow_always',
    )
    expect(permissionOutcome({ outcome: { outcome: 'selected', optionId: 'deny' } })).toBe('deny')
    expect(permissionOutcome({ outcome: { outcome: 'selected', optionId: 'ignored' } })).toBe(
      'ignored',
    )
    expect(permissionOutcome({ outcome: { outcome: 'selected', optionId: 'skip' } })).toBe('ignored')
    expect(permissionOutcome({ outcome: { outcome: 'selected', optionId: 'ignore' } })).toBe(
      'ignored',
    )
    expect(permissionOutcome('ignored')).toBe('ignored')
    expect(permissionOutcome({ outcome: { outcome: 'cancelled' } })).toBe('deny')
    expect(permissionOutcome({ outcome: { outcome: 'selected', optionId: 'mystery' } })).toBe('deny')
    expect(ACP_METHODS.sessionRequestPermission).toBe('session/request_permission')
  })

  test('PERMISSION_OPTIONS appends Skip as ignored reject_once', () => {
    expect(PERMISSION_OPTIONS).toContainEqual({
      optionId: 'ignored',
      name: 'Skip',
      kind: 'reject_once',
    })
    expect(PERMISSION_OPTIONS[PERMISSION_OPTIONS.length - 1]).toEqual({
      optionId: 'ignored',
      name: 'Skip',
      kind: 'reject_once',
    })
  })
})
```

In `packages/acp/src/server.test.ts`, after `permission_ask requests allow / deny / allow_always from the editor` (~490), add:

```ts
  test('editor Skip option settles askUser as ignored', async () => {
    const requests: JsonRpcRequest[] = []
    let decided: string | undefined
    const server = createAcpServer({
      engineFactory: (_sessionId, opts) => ({
        async *submitMessage() {
          decided = await opts?.requestPermission?.({
            id: 'call_skip',
            tool: 'Bash',
            input: { command: 'ls' },
            message: 'run ls',
          })
          return { reason: 'completed' }
        },
        abort() {},
      }),
      request: async (req) => {
        requests.push(req)
        return { outcome: { outcome: 'selected', optionId: 'ignored' } }
      },
    })
    const sessionId = resultOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: ACP_METHODS.sessionNew,
        params: { cwd: '/tmp' },
      }),
    ).sessionId
    await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: ACP_METHODS.sessionPrompt,
      params: { sessionId, prompt: 'ls' },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.params).toMatchObject({
      sessionId,
      title: 'Allow Bash?',
      options: PERMISSION_OPTIONS,
    })
    expect(
      (requests[0]?.params as { options: Array<{ optionId: string }> }).options.some(
        (option) => option.optionId === 'ignored',
      ),
    ).toBe(true)
    expect(decided).toBe('ignored')
  })
```

In `sensitive .env / id_rsa never auto-approve` (~713), after the `allow_always` assertion, add:

```ts
    expect(options?.some((option) => option.optionId === 'ignored')).toBe(true)
```

Do not remap `cancelled` to ignored. Do not add a new `PermissionOptionKind`. `requestPermission` on `AcpEngineFactoryOpts` is the ACP `askUser`.

- [ ] **Step 2: Run tests to confirm they fail**

If bun type-checks `'ignored'` off `AcpPermissionAnswer`, apply the `protocol.ts` union one-liner from Step 3 first so the tests compile. They must still fail on `PERMISSION_OPTIONS` / `mapPermissionOptionId` behavior.

```bash
bun test ./packages/acp/src/protocol.test.ts ./packages/acp/src/server.test.ts
```

Expected: FAIL — `optionId: 'ignored'` maps to `'deny'`; `PERMISSION_OPTIONS` has no Skip; editor Skip settles `'deny'`; sensitive options have no `'ignored'`. Existing cancelled → deny still passes.

- [ ] **Step 3: Write the implementation**

`packages/acp/src/protocol.ts`:

```ts
export type AcpPermissionAnswer = 'allow' | 'deny' | 'allow_always' | 'ignored'

export const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  { optionId: 'ignored', name: 'Skip', kind: 'reject_once' },
]
```

`permissionOutcome` first line:

```ts
  if (result === 'allow' || result === 'deny' || result === 'allow_always' || result === 'ignored') {
    return result
  }
```

`mapPermissionOptionId` — keep allow / allow_always cases; **before** `default`:

```ts
    case 'ignored':
    case 'skip':
    case 'ignore':
      return 'ignored'
    default:
      // Unknown outcomes are not approval (ACP: do not treat as selected allow).
      return 'deny'
```

Do not map `cancelled` here. `permissionOutcome` already returns `'deny'` for `outcome === 'cancelled'`.

`packages/acp/src/server.ts` `askPermissionOnce` options stay:

```ts
      options: sensitive
        ? PERMISSION_OPTIONS.filter((option) => option.optionId !== 'allow_always')
        : PERMISSION_OPTIONS,
```

Do not filter Skip. Do not change `racePermission` timeout (`AskWaiterExpired`) or `catch (() => finish('deny'))`. If `server.ts` needs no line change, leave it.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/acp/src/protocol.test.ts ./packages/acp/src/server.test.ts
```

Expected: PASS. Skip → `'ignored'`. `cancelled` / unknown still `'deny'`. Sensitive `.env` hides `allow_always` and still offers Skip. Existing allow/deny/allow_always loop still green (`PERMISSION_OPTIONS` now includes Skip in the `toMatchObject` options array).

- [ ] **Step 5: Commit**

```bash
git add packages/acp/src/protocol.ts \
  packages/acp/src/protocol.test.ts \
  packages/acp/src/server.ts \
  packages/acp/src/server.test.ts
git commit -m "$(cat <<'EOF'
feat: ACP Skip option emits ignored

PERMISSION_OPTIONS appends Skip. cancelled and unknown stay deny.
Sensitive paths keep Skip and still drop allow_always.
EOF
)"
```

If `server.ts` is unchanged, omit it from `git add`.

---

### Task 4: S4 Docs honesty (after code)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-22-hitl-skip-hosts.md` (Status → implemented; board S1–S4 **done**; Shipped sha empty)
- Modify: `docs/superpowers/specs/2026-09-21-ignored-dismiss.md` ruling 13
- Modify: `ARCHITECTURE.md` (`raven slack` leftover-ask buttons ~194; ACP permission ~168)
- Modify: `ARCHITECTURE.ko.md` (DM leftover-ask ~208; ACP leftover ~171)
- Modify: `SLASH_COMMANDS.md` (Permission ask ~96)
- Modify: `SLASH_COMMANDS.ko.md` (OpenTUI permission row ~138)
- Modify: `CHANGELOG.md` Unreleased ### Added (prepend)
- Modify: `docs/research/eve-analysis.md` closer (~326)
- Modify: `docs/research/eve-analysis.ko.md` closer (~191)

Do **not** edit `session-engine.ts`, `phases.ts`, `pending-asks.ts`, pairing, HTTP, Ink, OpenTUI. No version bump. No `bun.lock`. Do not rewrite `2026-09-15-eve-inspired-roadmap.md`. Do not edit remaining-roadmap.

- [ ] **Step 1: Point docs at the shipped behavior**

Do this only after Task 1–3 are green. Spec Status → **implemented**. Board S1 Slack / S2 Discord / S3 ACP / S4 Docs **done**. Leave Shipped sha empty until it lands on `main`.

`docs/superpowers/specs/2026-09-21-ignored-dismiss.md` ruling 13. Replace the 3-way sentence with a pointer, keep timeout/cancel law:

```
13. **Slack / Discord / ACP skip UI.** Amended by [`2026-09-22-hitl-skip-hosts.md`](2026-09-22-hitl-skip-hosts.md). Those hosts emit `'ignored'` via Skip / skip text / Skip option. Timeout/cancel mappings stay. Unmatched leftover responses still re-queue.
```

`ARCHITECTURE.md` `raven slack` (~194): leftover-ask buttons are Allow / Deny / Skip (`raven_skip` → `'ignored'`). Durable timeout still leaves the row; non-durable timer still deny; non-DM still auto-deny. ACP (~168): editor Skip option (`optionId: 'ignored'`) maps to `'ignored'`; `cancelled` still deny; timeout still `AskWaiterExpired` leave-row. Pointer: [`2026-09-22-hitl-skip-hosts.md`](docs/superpowers/specs/2026-09-22-hitl-skip-hosts.md).

`ARCHITECTURE.ko.md` (~208): DM leftover-ask는 Allow / Deny / Skip. Skip은 `'ignored'`. 120초 durable timeout은 행을 남긴다. 비-DM은 묻지 않고 deny. ACP leftover (~171): 에디터 Skip → `'ignored'`. `cancelled`는 여전히 deny.

`SLASH_COMMANDS.md` Permission ask row (~96): stop “stay 3-way”. Slack Skip button / `skip`/`ignore`/`ignored` text; Discord `skip`/`ignore`/`ignored`; ACP Skip option. All emit `'ignored'`. Esc abort. Timeout and editor `cancelled` stay deny/leave-row. Spec: [`2026-09-22-hitl-skip-hosts.md`](docs/superpowers/specs/2026-09-22-hitl-skip-hosts.md).

`SLASH_COMMANDS.ko.md` OpenTUI permission row (~138): `Slack/Discord/ACP는 3-way` 삭제. Slack Skip / Discord skip 텍스트 / ACP Skip → `'ignored'`. 스펙 포인터를 이 스펙으로.

`CHANGELOG.md` Unreleased ### Added, **prepend**:

```md
- Slack Skip button (`raven_skip`) and `skip`/`ignore`/`ignored` text, Discord `skip`/`ignore`/`ignored`, and ACP Skip option (`optionId: 'ignored'`) emit `'ignored'`. Deny stays danger. Sensitive ACP paths keep Skip and still hide `allow_always`. Timeout / editor `cancelled` / non-DM auto-deny unchanged. Crash-resume skip uses `applyAskAnswer` and does not `submitMessage`. Schema stays **v11**. Spec: [docs/superpowers/specs/2026-09-22-hitl-skip-hosts.md](docs/superpowers/specs/2026-09-22-hitl-skip-hosts.md). Plan: [docs/superpowers/plans/2026-09-22-hitl-skip-hosts.md](docs/superpowers/plans/2026-09-22-hitl-skip-hosts.md).
```

The dismiss-on-message Unreleased bullet still says “Slack/Discord/ACP stay 3-way”. Drop that parenthetical (keep the follow-up **message** through `submitMessage` dismisses as a side effect). Do not rewrite older **Shipped** bullets.

`docs/research/eve-analysis.md` closer paragraph (~326): append that Slack / Discord / ACP skip UI now emits `'ignored'` ([`2026-09-22-hitl-skip-hosts.md`](../superpowers/specs/2026-09-22-hitl-skip-hosts.md)). Timeout / editor `cancelled` stay. `eve-analysis.ko.md` (~191): matching Korean pointer.

- [ ] **Step 2: Run host tests once more (docs-only; no product edits)**

```bash
bun test ./packages/cli/src/slack/adapter.test.ts ./packages/cli/src/discord/adapter.test.ts ./packages/acp/src/protocol.test.ts ./packages/acp/src/server.test.ts
```

Expected: PASS. Docs-only commit does not change those files.

- [ ] **Step 3: Commit**

```bash
git add ARCHITECTURE.md ARCHITECTURE.ko.md \
  SLASH_COMMANDS.md SLASH_COMMANDS.ko.md \
  CHANGELOG.md \
  docs/superpowers/specs/2026-09-22-hitl-skip-hosts.md \
  docs/superpowers/specs/2026-09-21-ignored-dismiss.md \
  docs/research/eve-analysis.md docs/research/eve-analysis.ko.md
git commit -m "$(cat <<'EOF'
docs: mark Slack Discord ACP skip UI implemented

Hosts emit ignored. Timeout and cancelled stay. No version bump.
EOF
)"
```

---

## Success checks

1. Slack Skip button and `skip`/`ignore`/`ignored` text → `'ignored'`; Allow/Deny unchanged; Deny still danger.
2. Discord `skip`/`ignore`/`ignored` → `'ignored'`. Prompt mentions skip.
3. ACP Skip option → `'ignored'`; `cancelled` still `'deny'`; sensitive path can skip and still hides `allow_always`.
4. Timeouts and I2 abort still not ignored. Non-DM Slack/Discord still auto-deny.
5. Crash-resume skip pairs via `applyAskAnswer` and does not submit.
6. Docs stop saying Slack/Discord/ACP stay 3-way. Spec Status implemented. Shipped sha empty. No version bump.

---

## Self-review

**Spec coverage:** S1 → Task 1. S2 → Task 2. S3 → Task 3. S4 → Task 4. Engine / pairing / HTTP / Ink / OpenTUI untouched. Timeout→ignored OUT. cancelled→ignored OUT. Allow-always Slack/Discord button OUT. Fourth host entry OUT. Schema bump OUT.

**Placeholder scan:** none. Targeted bun commands start with `./`. Commits are HEREDOC.

**Type consistency:** `SlackPermissionAnswer` / `DiscordPermissionAnswer` / `AcpPermissionAnswer` include `'ignored'`. User-facing copy is Skip; engine answer is `'ignored'`. `allow_always` remains on the Slack/Discord unions and stays unused in parse.

**Existing tests:** Slack `tryResolvePermit` inline union widens to `SlackPermissionAnswer`. ACP `permission_ask` loop still matches `PERMISSION_OPTIONS` (now four options). Sensitive filter still only drops `allow_always`.
