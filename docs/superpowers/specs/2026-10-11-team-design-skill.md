# `team-design` — 프로젝트 에이전트와 스킬을 설계하는 빌트인

Status: **draft**. Date: 2026-10-11.  
Reviewed against `main` at `094d86c` (`094d86c7f7f0d78a85cc805563c2f71302c27f22`, `feat(cli): play a web game from the session`).  
구현 계획 파일 없음. `docs/superpowers/plans/`에 대응하는 계획을 만들지 않는다. 문은 하나다.

이 문서는 구현 diff에서 Status를 바꾸지 않는다. Shipped sha는 비운다. 정합 패스가 나중에 채운다. `main`에서 구현하지 않는다. 격리된 워크트리만 쓴다.

## 이 문서가 하는 일

프로젝트에 다시 쓸 역할이 필요할 때, 루트 모델이 프로젝트 루트의 `.ravenclaw/agents/*.md`와 `.ravenclaw/skills/<name>/SKILL.md`를 쓰게 하는 빌트인 스킬 하나의 계약이다. 실행은 이미 있는 `Agent` 도구의 `subagent` 호출이다. `/crew`의 세 프리셋은 웨이브 모양의 기준이고, 모델이 그 슬래시를 대신 치지 않는다. 엔진, 스키마, 슬래시, 카탈로그 id, 병렬 상한, 깊이는 그대로다.

선행 검토에서 남긴 유일한 문이다. 회고 스킬, 스크립트 러너, 형제 간 메시지, 에이전트별 모델 필드는 이 문서가 설계하지 않는다.

## 선행 자료

읽기 전용 `/Users/yeonwoosung/Desktop/harness`. 커밋 `92d9f1b29e7af81acebf51a9fcd1832e739a1414` (2026-09-28). 플러그인 `2.1.0`. Apache-2.0. 저작권 2025 robin. 저장소 https://github.com/revfactory/harness. 그 트리의 마크다운과 `LICENSE`에는 카카오 표기가 없다.

그 저장소의 `skills/harness/SKILL.md`, `skills/evolve/SKILL.md`, `references/`를 복사하지 않는다. 라이선스가 복사 자체를 막지는 않는다. 본문이 이 제품에 없는 실행 수단을 가리키므로 벤더하지 않는다.

가져오는 판단은 네 가지다. 역할과 절차를 파일로 나눈다. 같은 역할이 있으면 새 파일을 만들지 않는다. 파일을 쓰기 전에 명단을 사용자에게 확인받는다. 항상 읽는 파일에는 호출 조건만 둔다.

## 트리에서 확인한 사실

이 문이 기대는 코드다. 구현은 이 파일들을 동작 변경 없이 둔다.

**스킬 인덱스.** `discoverSkills` (`packages/core/src/tools/skill.ts`)는 builtin, 그다음 `~/.ravenclaw/skills`, 그다음 `<cwd>/.ravenclaw/skills` 순으로 `Map.set` 한다. 같은 이름이면 나중 것이 이긴다. 프로젝트 스킬은 같은 이름의 빌트인을 이 프로젝트에서 가린다. `loadSkillRoot`는 루트 바로 아래 디렉터리의 `SKILL.md`만 읽는다. 중첩 스킬은 인덱스에 없다. 본문과 `references/`는 Skill 도구의 `path`로 읽고, 스킬 디렉터리 밖이면 `Skill failed: path escape`다.

**description.** `packages/core/src/prompt/builder.ts`의 `clipSkillDescription`이 `SKILL_DESC_MAX` 60에서 자른다. 줄바꿈이 아니라 절단이다. `parseSkillFrontmatter`는 `description: >`를 접지 않는다. 콜론 뒤 `>`는 스칼라 `">"`가 된다. 빌트인 description은 한 물리적 줄이고 60자 이하다.

**`allowed-tools`.** 비어 있지 않으면 `applySkillAllowedTools`가 그 턴의 도구를 교집합으로 줄인다. 설계 스킬에 넣으면 그 턴의 Bash와 Edit가 잘린다. `game-design`과 `gamedev`는 이 키를 넣지 않는다.

**브랜드 문자열.** `packages/core/src/skills/builtin.test.ts`는 각 빌트인 `SKILL.md`에서 `Claude`와 `Anthropic`을 대소문자 구분으로 거절한다. `gamedev` 트리 전체는 소문자로 펼쳐 `claude`와 `anthropic`을 거절한다. 이 문의 테스트는 `team-design` 디렉터리에 그 소문자 검사를 적용한다. 그래서 본문은 `CLAUDE.md`라는 철자를 쓸 수 없다.

**디스크 에이전트.** `loadDiskAgents` (`packages/core/src/agent/load.ts`)는 `~/.ravenclaw/agents/*.md`를 읽고, 그다음 `<cwd>/.ravenclaw/agents/*.md`가 같은 id를 덮어쓴다. 프론트매터 `name`이 id다. `allowed-tools`가 있으면 그 목록이고, 없으면 `Read`, `Grep`, `Glob`이다. `maxRounds`는 12로 고정이다. `spawnableAgents`는 빈 배열이다. `model` 키는 파서가 무시한다. `packages/core/src/agent/load.test.ts`는 프로젝트 파일이 사용자 파일을 이기는 것과, 카탈로그 id `reviewer` 파일을 만들어도 `getAgentDefinition`의 id가 `reviewer`인 것까지만 본다. 본문이 디스크 파일로 바뀌는지는 보지 않는다.

**카탈로그가 디스크 본문을 이긴다.** `agentCatalog` (`packages/core/src/agent/catalog.ts`)는 `loadDiskAgents` 결과에서 카탈로그 id와 같은 것을 버린 뒤 카탈로그 뒤에 붙인다. 카탈로그 id는 `general`, `file-finder`, `command-runner`, `reviewer`, `researcher-web`다. 디스크 파일이 그 id면 실행되는 정의는 카탈로그 파일이다.

카탈로그 경계는 다음 파일이다. `general` (`packages/core/src/agent/general.ts`)는 `Read`, `Grep`, `Glob`, `ListDir`, `Edit`, `Write`, `ApplyPatch`, `Bash`, `Skill`이고 `inheritParentSystemPrompt`가 켜져 있으며 `maxRounds`는 30이다. `file-finder`는 `Read`, `Grep`, `Glob`, `maxRounds` 8이고 시스템 프롬프트가 최대 20줄이다. `command-runner`는 `Read`, `Bash`, `maxRounds` 2이고 저장소를 탐색하거나 명령을 이어서 돌리지 않는다. `reviewer` (`packages/core/src/agent/reviewer.ts`)는 도구가 없고 부모 메시지를 보며 `maxRounds`는 4다. `researcher-web`는 `WebSearch`, `Fetch`, `maxRounds` 12다.

**누가 불려 가나.** `spawnChild` (`packages/core/src/tools/agent.ts`)의 spawnable 집합은 `rootAgent.spawnableAgents`에 디스크 id를 더한 것이다. 루트 목록은 `general`, `file-finder`, `command-runner`, `reviewer`, `researcher-web` (`packages/core/src/agent/root.ts`). 디스크 파일이 없는 `subagent: 'root'`는 `not spawnable`이고 자식 세션을 만들지 않는다 (`packages/core/src/tools/agent.test.ts`). `root`는 카탈로그 id가 아니다. `name: root`인 디스크 파일이 있으면 spawnable에 들어가고, 그 파일 본문이 자식으로 실행된다. 세션 루트가 되지 않는다. 다른 디스크 id는 그 테스트의 `disk-helper`처럼 호출된다. 인자 이름은 `subagent`다.

**프로젝트 루트.** `spawnChild`와 Skill 도구의 `discoverSkills`는 `ctx.turn.projectCwd ?? ctx.turn.cwd`를 본다. `EnterWorktree` (`packages/core/src/tools/enter-worktree.ts`)는 `projectCwd`를 원래 프로젝트 루트로 두고 턴의 `cwd`만 워크트리로 바꾼다. 세션 워크트리의 `.ravenclaw/agents`는 다음 `Agent` 호출이 읽지 않는다.

**상한과 깊이.** `MAX_PARALLEL_CHILDREN`는 6이다 (`packages/core/src/tasks/mailbox.ts`). `agents[]`와 `run_in_background: true`는 함께 쓰지 못한다. 반환은 `Agent failed: agents[] cannot run in the background`다 (`packages/core/src/tools/agent.ts`). 자식 도구에서는 `NESTING_DENIED`가 `Agent`를 뺀다. 메일 수신자는 부모 세션뿐이다. `docs/superpowers/specs/2026-09-08-ravenclaw-coding-agent-design.md`는 루트 하나의 루프를 유지한다. `docs/superpowers/specs/2026-09-12-ravenclaw-gateway-and-parallel-agents.md`는 깊이 1과 상한 6을 유지한다. `docs/superpowers/specs/2026-09-28-crew.md`는 `/crew` 프리셋을 `review`, `research`, `implement` 세 개로 고정하고, 새 도구와 피어 버스를 거부한다.

**항상 읽는 파일.** `loadProjectFiles` (`packages/core/src/prompt/project-files.ts`)는 `RAVEN.md`, `CLAUDE.md`, `.ravenclaw/RAVEN.md`, `RAVEN.local.md`, 그리고 모드에 따라 `AGENTS.md`를 읽는다. 파일 상한 `PROJECT_FILE_CHAR_CAP`는 40000, 합계 `PROJECT_FILES_TOTAL_CAP`는 60000이다. 명단과 변경 이력을 여기 넣으면 그 예산을 쓴다.

**빌트인 개수.** `builtin.test.ts`의 `REQUIRED`는 10개다. `review`, `test`, `commit`, `debug`, `tdd`, `plan`, `frontend-design`, `mcp-builder`, `gamedev`, `game-design`. 개수 문장은 README 1곳(`Ten builtins.`), `ARCHITECTURE.md` 2곳(Skills 절의 `Ten builtins (pinned by`, 공식 19개 문단의 `Ten builtins: eight original`), `ARCHITECTURE.ko.md` 3곳(`builtin 10개.`, 스킬 요약의 `builtin은 10개다.`, 공식 19개 요약의 `builtin은 10개다.`)이다. `docs/superpowers/specs/2026-09-13-official-claude-skills-gap.md`의 amendment도 10이다. 공식 19개와의 이름 겹침은 `frontend-design`, `mcp-builder` 두 개다. `team-design`은 그 19개에 없다.

## 목표

- 빌트인 하나. 이름 `team-design`. 디렉터리 `packages/core/src/skills/builtin/team-design/SKILL.md`. `references/`는 만들지 않는다.
- 프론트매터 `name`과 `description`만. `allowed-tools` 키는 없다.
- `description`은 정확히 `Design project agents and skills under .ravenclaw/.` 다. 51자이고 60 이하다. 접힌 스칼라는 쓰지 않는다.
- 아래 「규범 본문」을 그 파일로 쓴다. 업스트림 문장을 섞지 않는다.
- `builtin.test.ts`의 `REQUIRED`에 `team-design`을 넣으면 이름이 11개다. 디렉터리 집합은 그 배열과 정확히 같다.
- 문서 개수 문장을 11로 맞춘다. README 1곳, `ARCHITECTURE.md` 2곳, `ARCHITECTURE.ko.md` 3곳, CHANGELOG Unreleased, 공식 스킬 갭 스펙의 amendment 한 줄. 한 파일에 남은 10은 그대로 두지 않는다.

## 비목표

- 회고 스킬. 지난 실행의 문장을 고치는 절차는 나중에 다른 스펙이 다룬다.
- 스크립트 러너. `pipeline`, `parallel`, `schema`, `budget`, 재개 id를 제품 루프에 넣지 않는다. `docs/superpowers/specs/2026-09-08-ravenclaw-coding-agent-design.md`가 닫아 둔 경계다.
- 형제 간 메시지, 이름 있는 에이전트를 세션 너머로 깨우기, `TaskCreate`를 기본 루트 도구로 켜기.
- 디스크 에이전트의 `model` 필드. 로더가 읽게 바꾸는 일도 이 문이 아니다.
- `MAX_PARALLEL_CHILDREN` 변경, `NESTING_DENIED`에서 `Agent`를 빼기, `/crew` 프리셋 추가.
- 업스트림 트리 벤더. `LICENSE`나 `NOTICE`를 빌트인 옆에 두지 않는다. 원문은 RavenClaw가 쓴다.
- 새 도구, 스키마 범프, 엔진 단계, 권한 모드, 슬래시 명령.
- 저장소 루트 `RAVEN.md`, `AGENTS.md`, 벤더 지시 파일을 이 스킬이 쓰게 하는 일.
- RavenClaw 저장소 `.gitignore` 변경. 버전 범프. `packages/core`의 로더와 에이전트 런타임 수정.
- Slack, Discord, ACP, `raven exec`의 슬래시 파싱.

## 규범 본문

구현은 다음 파일을 그대로 둔다. 바깥 펜스는 백틱 네 개다. 그 안의 백틱 세 개 펜스는 파일 내용이다.

````markdown
---
name: team-design
description: Design project agents and skills under .ravenclaw/.
---

# team-design

Load this before designing a reusable agent team for the current project. The skill index cannot carry every trigger, so the body does. Use it for 하네스 구성, 에이전트 팀, "design a team", project agents, and project skills.

Do not apply retrospective feedback here. Adding, removing, or replacing a role is in scope. Tuning prose from a past run is not.

Ask the user to accept the roster before writing files.

## Look first

Read .ravenclaw/agents/ and .ravenclaw/skills/ on the project root, plus ~/.ravenclaw/agents/ and ~/.ravenclaw/skills/. The project root is projectCwd when the turn has one, and cwd otherwise. Compare them with the catalog ids general, file-finder, command-runner, reviewer, and researcher-web.

general edits and inherits the parent prompt, with Read, Grep, Glob, ListDir, Edit, Write, ApplyPatch, Bash, and Skill, for at most 30 rounds. file-finder returns at most 20 lines, with Read, Grep, and Glob, for at most 8 rounds. command-runner has Read and Bash, runs at most 2 rounds, and does not explore the repo or chain extra commands. reviewer has no tools, sees the parent messages, and runs at most 4 rounds. researcher-web has WebSearch and Fetch, for at most 12 rounds.

Do not reuse a catalog agent id for a new disk agent. A file with one of those ids is ignored when a child runs. The catalog definition runs instead.

Do not shadow a builtin skill name. A project skill with the same name replaces the builtin for this project. The live skill index is the list of names you must not reuse.

If a catalog id already covers the role, name that id in the orchestrator and do not write a disk file. If a project skill already covers the procedure, extend that skill.

Do not write an agent named root. A disk file named root becomes a spawnable child and runs that file. It does not become the session root.

## What a roster contains

Propose, and stop:

- each disk agent id, one line on the role
- each project skill name, one line on the procedure
- one orchestrator skill
- whether an always-on hook will be written

Write project agents under the project root .ravenclaw/agents/ and project skills under the project root .ravenclaw/skills/. A session worktree cwd is the wrong directory. Use ~/.ravenclaw/agents/ and ~/.ravenclaw/skills/ only when the user asks for every project.

Write generated files in the language the user is using. Keep the language of a file you are extending.

## Agent file

An agent file says who works. A skill file says how.

```markdown
---
name: analyst
allowed-tools: Read, Grep, Glob
---

Role, inputs, outputs, and what to do on a bad input.
```

`name` matches the file name without `.md`. Default disk agent tools are Read, Grep, and Glob. Omit `allowed-tools` to keep that default. A disk agent that edits lists Edit, Write, and ApplyPatch in allowed-tools. A disk agent that must run a command lists Bash in allowed-tools. Read-only review uses the catalog reviewer.

The root opens the procedure skill and copies the steps the child needs into the Agent prompt. The disk agent body stays the role. A disk agent does not see the skill index.

Disk agents run at most 12 rounds. Do not promise another limit. Do not put a model key in an agent file. The loader ignores it. A disk agent cannot spawn a child.

## Skill file

```markdown
---
name: domain-run
description: Run the domain team for this project.
---
```

The description is one line of at most 60 characters. The trigger words sit inside those 60 characters. Do not fold the description. Do not set allowed-tools on a generated skill. Keep each generated SKILL.md under 500 lines. Move detail next to it under references/. Open a generated reference with the Skill tool name of that generated skill and the path of the reference. A path opened from team-design stays inside the team-design directory.

The orchestrator skill includes one success check and one failure check.

## How the team runs

The root still does the work. A child does not spawn another child. At most 6 children run together.

Do not set agents[] and run_in_background together. That call returns Agent failed: agents[] cannot run in the background.

Call Agent with subagent set to a catalog id or a disk agent id. Call a disk id only after the user has accepted that id in the roster. Do not add a preset to /crew.

When the graph matches a preset, match the wave shape and do not invent a slash. Review is one file-finder, then one reviewer. Research is researcher-web, plus file-finder in the same agents[] batch when the goal refers to this repository. Implement is agents[] of general, 1 through 6, each prompt listing exclusive paths, then one reviewer.

If the tool result contains Agent failed:, Subagent ', Unknown subagent:, aborted:, or permission_denied:, report that result and stop. Do not retry. Do not invent the missing judgment.

Do not create .ravenclaw/workspace/ unless the user asks for intermediate files. Add .ravenclaw/workspace/ to the project's .gitignore when you create it.

## Always-on hook

The always-on hook is .ravenclaw/RAVEN.md and only after a separate yes. Append exactly this section, or replace an existing section with the same heading. Do not write any other instruction file.

```markdown
## Team: {name}

**Goal:** {one line}

**When:** For {domain} work, open the skill `{skill-name}`. A direct question can be answered without it.
```

Put the change log in the orchestrator skill under ## Changes. Each entry is one line with the date, the target, and the reason. Do not put the roster or the change log in the hook.
````

구현 파일은 위 펜스 안의 바이트와 같다. 닫는 펜스 직전의 줄바꿈까지 포함한다. 테스트는 그 문자열과 `toBe`로 비교한다. 아래 문장 목록은 그 본문의 색인이고, 각 문장도 `toContain`으로 확인한다.

`## Changes`의 각 항목은 날짜, 대상, 사유를 담은 한 줄이다. 표로 바꾸지 않는다. 훅에는 그 줄을 넣지 않는다.

생성된 오케스트레이터의 `description`도 한 줄이고 60자 이하다. 접지 않는다. `allowed-tools`를 넣지 않는다. 도메인마다 문장이 달라지므로 예시 `Run the domain team for this project.` 한 줄만 본문에 둔다. 테스트는 그 예시를 포함 여부로 본다.

명단을 보여 준 턴에서는 파일을 쓰지 않는다. 사용자가 그 명단을 받아들인 다음 턴에 쓴다. 훅은 그 수락과 별개의 수락이 있어야 한다. 이 강제는 본문 문장이다. 권한 게이트나 새 도구가 아니다.

## 테스트

`packages/core/src/skills/builtin.test.ts`에 테스트를 하나 추가한다. 기존 10개 이름 검사는 유지한다.

- `REQUIRED`에 `team-design`이 있고, 빌트인 디렉터리 이름 집합이 정렬 후 그 배열과 같다.
- `parseSkillFrontmatter`의 `name`은 `team-design`, `description`은 위 문장과 같고, `allowedTools`는 `undefined`다.
- `description.length`는 60 이하다.
- 본문은 다음 문장을 각각 포함한다.
  - `Ask the user to accept the roster before writing files.`
  - `Do not reuse a catalog agent id for a new disk agent.`
  - `Do not shadow a builtin skill name.`
  - `The live skill index is the list of names you must not reuse.`
  - `Do not write an agent named root.`
  - `A disk file named root becomes a spawnable child and runs that file. It does not become the session root.`
  - `The project root is projectCwd when the turn has one, and cwd otherwise.`
  - `general edits and inherits the parent prompt, with Read, Grep, Glob, ListDir, Edit, Write, ApplyPatch, Bash, and Skill, for at most 30 rounds.`
  - `file-finder returns at most 20 lines, with Read, Grep, and Glob, for at most 8 rounds.`
  - `command-runner has Read and Bash, runs at most 2 rounds, and does not explore the repo or chain extra commands.`
  - `reviewer has no tools, sees the parent messages, and runs at most 4 rounds.`
  - `researcher-web has WebSearch and Fetch, for at most 12 rounds.`
  - `Write project agents under the project root .ravenclaw/agents/ and project skills under the project root .ravenclaw/skills/.`
  - `A session worktree cwd is the wrong directory.`
  - `Write generated files in the language the user is using.`
  - `Keep the language of a file you are extending.`
  - `Default disk agent tools are Read, Grep, and Glob.`
  - `A disk agent that edits lists Edit, Write, and ApplyPatch in allowed-tools.`
  - `Read-only review uses the catalog reviewer.`
  - `The root opens the procedure skill and copies the steps the child needs into the Agent prompt.`
  - `The disk agent body stays the role.`
  - `A disk agent does not see the skill index.`
  - `Open a generated reference with the Skill tool name of that generated skill and the path of the reference.`
  - `A path opened from team-design stays inside the team-design directory.`
  - `Disk agents run at most 12 rounds.`
  - `Do not put a model key in an agent file.`
  - `The orchestrator skill includes one success check and one failure check.`
  - `Call a disk id only after the user has accepted that id in the roster.`
  - `When the graph matches a preset, match the wave shape and do not invent a slash.`
  - `Review is one file-finder, then one reviewer.`
  - `Research is researcher-web, plus file-finder in the same agents[] batch when the goal refers to this repository.`
  - `Implement is agents[] of general, 1 through 6, each prompt listing exclusive paths, then one reviewer.`
  - `If the tool result contains Agent failed:, Subagent ', Unknown subagent:, aborted:, or permission_denied:, report that result and stop. Do not retry. Do not invent the missing judgment.`
  - `The root still does the work.`
  - `A child does not spawn another child.`
  - `At most 6 children run together.`
  - `Do not set agents[] and run_in_background together.`
  - `That call returns Agent failed: agents[] cannot run in the background.`
  - `Do not add a preset to /crew.`
  - `Do not create .ravenclaw/workspace/ unless the user asks for intermediate files.`
  - `The always-on hook is .ravenclaw/RAVEN.md and only after a separate yes.`
  - `Do not write any other instruction file.`
  - `Each entry is one line with the date, the target, and the reason.`
  - `Do not apply retrospective feedback here.`
- `team-design` 디렉터리의 모든 파일을 소문자로 펼쳐 `claude`, `anthropic`이 없다.
- 같은 파일들에 `SendMessage`, `TeamCreate`, `TeamDelete`, `.claude/`, `fable`, `opus`, `sonnet`, `Workflow`가 없다.

실행은 워크트리에서 `bun test ./packages/core/src/skills/builtin.test.ts` 만 한다. 저장소 전체 `bun test`는 돌리지 않는다. `package.json`의 `test`와 `scripts/ci-unit.sh`는 그대로 둔다. 유닛 잡이 `packages/core`를 이미 돌린다.

## 구현할 때 건드릴 파일

- `packages/core/src/skills/builtin/team-design/SKILL.md` (신규, 위 펜스와 바이트가 같음)
- `packages/core/src/skills/builtin.test.ts` — 그 파일 전체 `toBe`, 그리고 아래 문장 `toContain`
- `README.md` — `Ten builtins.` 한 곳을 11로. 표에 `team-design` 한 줄. description 문장을 표의 설명으로 쓴다.
- `ARCHITECTURE.md` — Skills 절의 `Ten builtins (pinned by` 한 곳과 공식 19개 문단의 `Ten builtins: eight original` 한 곳. 이름 목록에 `team-design`을 넣고, `allowed-tools`가 없다고 적는다.
- `ARCHITECTURE.ko.md` — `builtin 10개.` 한 곳, 스킬 요약의 `builtin은 10개다.` 한 곳, 공식 19개 요약의 `builtin은 10개다.` 한 곳. 한 줄 설명을 더한다.
- `CHANGELOG.md` — Unreleased의 Added에 이 스펙 경로를 가리키는 불릿 하나.
- `docs/superpowers/specs/2026-09-13-official-claude-skills-gap.md` — amendment를 11로 고치고, `team-design`은 원문이며 공식 19개에 속하지 않는다고 한 줄 덧붙인다. 겹침 2/19는 유지한다.

슬래시 문서, `packages/cli`, `packages/core/src/agent`, `packages/core/src/tools/agent.ts`, `packages/core/src/tools/skill.ts`는 건드리지 않는다.

## 수용

- 인덱스가 받는 줄은 `team-design` 하나이고, 잘린 description이 위 문장 전체다.
- 모델이 이 스킬을 따른 뒤 쓰는 경로는 프로젝트 루트의 `.ravenclaw/agents/`와 `.ravenclaw/skills/`다. 루트는 `projectCwd`가 있으면 그 경로이고, 없으면 `cwd`다. 세션 워크트리의 `cwd`에 쓰지 않는다. 사용자 홈은 사용자가 모든 프로젝트에 쓰라고 한 경우에만 쓴다.
- 카탈로그 id와 같은 디스크 에이전트 파일을 만들지 않는다. 빌트인과 같은 스킬 이름을 만들지 않는다.
- 명단 수락 전에 파일이 생기지 않는다. 훅은 `.ravenclaw/RAVEN.md`에만, 별도의 수락 뒤에만 붙는다.
- 팀의 실행 지시는 `Agent`의 `subagent` 웨이브다. 프리셋과 같은 그래프는 `review`, `research`, `implement`의 웨이브 모양만 맞춘다. 모델은 슬래시를 치지 않는다. 디스크 id는 명단에 수락된 것만 부른다. 루트는 절차 스킬을 읽어 자식 `prompt`에 단계를 넣는다. 자식이 자식을 부르지 않고, 한 번에 6명을 넘기지 않는다.
- 위 테스트가 통과한다.

## 구현 제약

1. `main`에서 구현하지 않는다. 격리된 워크트리만 쓴다.
2. 이 스펙의 Status는 구현 diff에서 draft로 남긴다. Shipped sha를 채우지 않는다.
3. 버전을 올리지 않는다. 스키마를 올리지 않는다.
4. 클린룸. 업스트림 문장과 벤더 브랜드 부분 문자열을 넣지 않는다.
5. 구현 계획은 세부만 더할 수 있다. 이 문서의 규범 본문, 비목표, 테스트 문장과 어긋나면 안 된다.
