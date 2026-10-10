# 게임 개발 편의 로드맵 (gamedev 팩 이후)

Status: **draft**. Date: 2026-10-10.  
Reviewed against worktree `feat/gamedev-skills`, base `16d706f` (`16d706fb490faaf034ec73cc28bd114af02c69a4`, Merge pull request #26).  
구현 계획 파일 없음. `docs/superpowers/plans/`에 대응하는 계획을 만들지 않는다. 문은 독립이다. 사용자가 나중에 문 하나를 고른다. 고르지 않은 문을 그 구현에 끼워 넣지 않는다.

Door 0은 이 워크트리에 아직 커밋되지 않은 채로 들어와 있다. `packages/core/src/skills/builtin/gamedev/`가 있고, `builtin.test.ts`의 `REQUIRED`는 9개(`review`, `test`, `commit`, `debug`, `tdd`, `plan`, `frontend-design`, `mcp-builder`, `gamedev`)다. 이 스펙은 그 벤더 트리를 다시 고치지 않는다. 아래 "건드릴 파일"은 각 문을 나중에 구현할 때의 목록이다.

## 이 문서가 하는 일

gamedev 스킬 팩이 들어온 다음, 게임을 만들 때 비는 제품 구멍을 문으로 나눈다. 팩은 엔진·장르·레벨·피드를 가르친다. 제품 한 장(판타지, 코어 루프, 기둥, 스코프)과, 웹 게임이 생긴 뒤 로컬에서 브라우저로 여는 명령은 팩 밖에 있다.

OS 브라우저를 여는 것은 웹 UI가 아니다. 닫힌 경계는 그대로다. 웹 UI, Next.js BFF, 앱 안 브라우저, 호스티드 웹 클라이언트, 두 번째 에이전트 루프는 만들지 않는다. `queryLoop`는 하나다. 호스트는 `submitMessage`만 호출한다.

## 권장 순서

1. Door 0 — 이미 진행 중. 이 스펙이 다시 설계하지 않는다.
2. Door 1과 Door 2 — Door 0이 같은 브랜치에서 진행된 뒤 병렬. 행동 의존은 없다. 파일이 겹치는 곳은 Door 1의 `REQUIRED` 한 줄뿐이다.
3. Door 3과 Door 5 — Door 2가 머지된 뒤. 둘은 서로 독립이다.
4. Door 4 — 열어 두지 않는다. Door 2 이후에 사용자가 다시 물어볼 때만 연다.

## 로드맵 전체의 비목표

- 웹 UI, Next.js BFF, Prisma Task, Socket.IO, 앱 안 브라우저, 호스티드 웹 클라이언트.
- 공식 19-스킬 팩 복사 (`ARCHITECTURE.md`의 그 금지와 같음). 벤더 브랜드 문자열을 의존성으로 추천하지 않는다.
- 버전 범프.
- 카탈로그 74개를 항상 켜진 프롬프트 인덱스로 펼치기.
- Godot / Unity / Unreal 에디터 자동화, 실행, 익스포트. 그 절차는 카탈로그 스킬에 남긴다.
- Playwright, CDP, 콘솔 캡처, 스크린샷을 세션으로 가져오기 (Door 4에만 해당하고, 그 문은 닫혀 있다).
- 게임 스캐폴드, `npm install` 자동 실행, itch / Steam 업로드.

## 트리에서 확인한 사실

구현 문이 공통으로 기대는 코드다. 추측으로 파일을 늘리지 않는다.

**CLI.** 명령 토큰은 `packages/cli/src/args.ts`의 `parseArgv`가 인식한다. `cmd`가 아직 `interactive`이고 포지셔널이 비어 있을 때만 명령 이름 목록(약 166–191행의 `arg === 'doctor' || …`)에 들어 있는 단어가 `ParsedArgv['cmd']`가 된다. 목록에 없으면 포지셔널 프롬프트가 된다. 디스패치는 `packages/cli/src/index.ts`의 `main`이다. 키 없이 동작해야 하는 명령은 `providerConfigured` 게이트(약 268행, `acp` / `exec` / `serve` 등)보다 앞에서 반환한다. `doctor`가 그 패턴이다. `runDoctor`는 `packages/cli/src/doctor.ts`, 테스트는 옆의 `doctor.test.ts`다. `serve`는 패턴이 아니다. `packages/cli/src/serve.ts`의 `runServe`는 에이전트 HTTP(`Bun.serve`, 기본 `127.0.0.1:8787`)이고 키가 필요하다. 비루프백 `--listen`은 `serve binds loopback only`로 거절한다. 새 명령의 체크리스트는 `parseArgv` 유니온과 이름 목록, `main`, `HELP_TEXT`(`packages/cli/src/help.ts`), `COMPLETION_COMMANDS`(`packages/cli/src/completions.ts`), `args.test.ts`, `help.test.ts`다. `help.test.ts`는 `raven doctor`처럼 명령 문자열을 하나씩 `toContain`한다.

**슬래시.** 카탈로그는 `packages/cli/src/commands.ts`의 `SLASH_COMMANDS`다. `handleSlashCommand`는 등록되지 않은 이름도 `{ type: 'command', name }`으로 돌려준다. Ink(`app.tsx`)와 OpenTUI(`opentui-app.ts`) 둘 다 그 다음 `dispatchSharedSlash`(`packages/cli/src/slash/dispatch.ts`)를 호출한다. `HOST_ONLY`(`quit`, `stop`, `clear`, `resume`, `diff`, `retry`, `queue`, `loop`, `bash`)만 `'host'`를 반환하고, 그때만 각 TUI의 `switch`가 돈다. 그 외의 모르는 이름은 `dispatchSharedSlash`의 `default`가 `unknown command: /…`를 내고 `'handled'`를 반환한다. TUI `switch`까지 가지 않는다. 그래서 CONTRIBUTING의 "commands.ts 다음에 app.tsx와 opentui-app.ts"만 고치면 `/play`는 먹히지 않는다. 공유 동작이면 `dispatch.ts`의 case다. TUI 크롬이면 `HOST_ONLY`에 넣고 두 앱의 `switch`에 넣는다. `/bash`와 `!cmd`는 `packages/cli/src/bash-line.ts`의 `runBangCommand`다. `Bun.spawnSync`, `TIMEOUT_MS` 30초. 서버를 여기 태우면 TUI가 최대 30초 멈추고 프로세스가 죽는다. Slack/Discord는 `dispatchSharedSlash`를 호출하지 않는다. `commands.test.ts`는 `SLASH_COMMANDS` 이름 배열의 순서를 통째로 기대한다.

**미리보기 서버는 없다.** 정적 파일 서버, Playwright, 게임 프리뷰 명령은 없다. `Bun.serve`는 `serve.ts`뿐이다. `node:http` `createServer`는 `packages/core/src/mcp/oauth.ts`의 루프백 OAuth 콜백이다. `127.0.0.1`을 쓰는 다른 코드는 Ollama 기본 `127.0.0.1:11434`, vLLM 기본 `127.0.0.1:8000`, `raven serve`다. OS 브라우저를 여는 코드는 광고 독뿐이다. `packages/cli/src/ad-dock.tsx`의 `adOpenCommand`는 darwin `open`, linux `xdg-open`이고 win32는 `undefined`다. 광고 URL 정화를 타며 실패를 삼킨다. 게임 프리뷰가 이 함수를 재사용하지 않는다. `Fetch`는 `127.0.0.1`을 막는다 (`packages/core/src/tools/fetch.test.ts`). 에이전트가 프리뷰 URL을 `Fetch`로 읽는 경로는 없다.

**스킬 로딩.** `packages/core/src/tools/skill.ts`의 `loadSkillRoot`는 루트 바로 아래 디렉터리의 `SKILL.md`만 읽는다. `discoverSkills` 인덱스에 중첩 스킬은 안 올라온다. 본문은 Skill 도구의 `path`로 읽고, `realpath`가 그 스킬 디렉터리 밖이면 `Skill failed: path escape`다. 휘발 프롬프트는 `packages/core/src/prompt/builder.ts`의 `clipSkillDescription`이 `SKILL_DESC_MAX`(60)에서 자른다. 줄바꿈이 아니라 절단이다. 트리거 단어는 앞 60자 안에 있어야 한다. `parseYamlish`는 `description: >`를 접지 않는다. 콜론 뒤 `>`는 스칼라 문자열 `">"`가 되고, 다음 들여쓴 줄은 키가 아니면 버린다. 값이 빈 `key:`만 리스트(`- item`)로 모은다. 접힌 description은 본문이 되지 않는다. 새 최상위 스킬은 한 줄 description, `builtin.test.ts`의 `REQUIRED`에 이름 추가, 본문에 벤더 브랜드 부분 문자열 `Claude`와 `Anthropic` 금지(그 테스트가 `toContain`으로 거절한다). `allowed-tools`가 비어 있지 않으면 `applySkillAllowedTools`가 그 턴의 도구 목록을 교집합으로 줄인다. 설계 스킬에 넣으면 그 턴의 Bash/Edit가 잘린다.

**Bash로 명령을 돌릴 수 있다.** `packages/core/src/tools/bash.ts`의 Bash 도구가 `bash -c`를 실행한다. 기본 타임아웃은 120000ms다. `run_in_background: true`면 task id를 바로 반환한다. 새 도구는 필요 없다.

**업스트림 팩 (읽기 전용 `/tmp/awesome-gamedev-agent-skills`).** `skills/**/SKILL.md` 74개. 제품 설계 스킬은 없다. `router/SKILL.md`는 엔진을 지문하고 스킬을 고른다. 판타지, 기둥 세 개, in/out 스코프 박스, 세션 길이, 가장 위험한 가정, 플레이테스트 질문 한 개를 쓰는 문서가 아니다. 인접 스킬은 다른 일을 한다. `level-design`은 블록아웃·동선·페이싱이다. `game-feel`은 히트스톱·셰이크 같은 주스다. `prototype-fast`는 한 시간을 주고 메커닉 하나인가를 묻는 프로토타입 브리프다. `game-jam`은 마감에 맞춰 자르고 제출하는 일정이다. `create-game-assets`는 에셋이다. `phaser-core`를 포함한 웹 엔진 스킬은 API다. 본문은 이 스펙에 옮기지 않는다.

이름 (카탈로그 경로 기준, 본문 없음):

- disciplines: `ai-behavior-trees-utility-ai`, `audio-design`, `camera-systems`, `create-game-assets`, `dialogue-systems`, `game-ai`, `game-feel`, `game-ui-ux`, `input-systems`, `level-design`, `performance-optimization`, `physics-tuning`, `procedural-gen`, `save-systems`, `shader-programming`
- genres: `card-game`, `fps-shooter`, `platformer`, `puzzle`, `roguelike`, `rpg`, `survival-crafting`, `tower-defense`, `visual-novel`
- godot: `godot-2d-movement`, `godot-3d-essentials`, `godot-animation`, `godot-audio`, `godot-csharp`, `godot-export`, `godot-gdscript`, `godot-gdscript-headless-testing`, `godot-multiplayer`, `godot-nodes-scenes`, `godot-physics`, `godot-resources`, `godot-shaders`, `godot-signals-groups`, `godot-tilemap`, `godot-ui-control`
- other-engines: `bevy-ecs`, `love2d-core`, `pygame-core`, `roblox-characters`, `roblox-datastores`, `roblox-luau`, `roblox-networking`, `roblox-physics`, `roblox-studio-workflow`, `roblox-ui`
- unity: `unity-animation`, `unity-build-pipeline`, `unity-csharp-scripting`, `unity-input-system`, `unity-navmesh`, `unity-physics`, `unity-scriptableobjects`, `unity-tilemap-2d`
- unreal: `unreal-behavior-trees`, `unreal-blueprints`, `unreal-cpp-gameplay`, `unreal-enhanced-input`, `unreal-niagara`, `unreal-packaging`
- web-engines: `phaser-arcade-physics`, `phaser-core`, `pixijs-rendering`, `threejs-gltf-loading`, `threejs-materials-lighting`, `threejs-scene-setup`
- workflows: `game-jam`, `itch-publish`, `prototype-fast`, `steam-publish`

라이선스 Apache-2.0. NOTICE의 저작권 표시는 2026 Abhishek Barali and the awesome-gamedev-agent-skills contributors.

`frontend-design` 빌트인은 UI 미감을 고르는 스킬이다. 게임 설계 문이 아니다.

---

## Door 0 — gamedev builtin pack

Status: `feat/gamedev-skills` 워크트리에 들어와 있다. 커밋 전. `bun test ./packages/core/src/skills/builtin.test.ts ./packages/core/src/prompt/builder.test.ts`는 23 pass. 이 스펙은 다시 설계하지 않는다.

형상은 하나로 고정한다. 빌트인 라우터는 `packages/core/src/skills/builtin/gamedev/SKILL.md` 하나다. 카탈로그 74개는 `gamedev/catalog/<name>/SKILL.md`다. `loadSkillRoot`가 한 단계만 보므로 항상 켜진 인덱스에는 `gamedev` 한 줄만 올라간다. 비게임 턴이 74개 description을 물지 않는다. 에이전트는 Skill 도구로 `name: gamedev`, `path: catalog/<name>/SKILL.md`를 연다. 74개를 인덱스에 다시 펼치는 일은 범위 밖이다. 라우터 description은 한 줄이고 60자 이하여야 한다. 접힌 `description: >`를 쓰지 않는다.

의존: 없음. 이후 문은 이 경로 규칙을 가리키기만 한다.

## Door 1 — `game-design` builtin skill

의존: 행동 의존 없음. 본문이 `gamedev` 카탈로그를 가리키므로, 머지는 Door 0이 트리에 있은 뒤가 안전하다. 병렬로 써도 된다. `builtin.test.ts`의 `REQUIRED`만 Door 0과 같은 배열이다. Door 0이 그 파일을 놓은 뒤에 이름을 추가하거나, 배열 충돌만 머지한다.

문제: 팩은 "어떻게 만드는가"만 있고 "무엇을 만들기로 했는가"가 없다. `game-jam`의 한 문장 콘셉트와 `prototype-fast`의 프로토타입 질문은 마감과 메커닉 검증이다. 판타지, 기둥, 스코프 박스, 플레이테스트 질문을 대체하지 않는다. 인덱스가 라우터 한 줄뿐이면 "game design"으로 최상위 스킬을 고를 수 없다. 라우터를 열어야만 기획이 보이면 안 된다.

제안 동작: 최상위 빌트인 `packages/core/src/skills/builtin/game-design/SKILL.md`. 원문은 RavenClaw가 쓴다. 업스트림 본문을 복사하지 않는다. 모델은 코드를 쓰기 전에 이 스킬을 연다. 트리거(본문에 적는다. 60자 인덱스에 다 넣지 못한다): 게임 기획, GDD, core loop, pillars, 무엇을 만들지, 잼 게임의 범위를 자르기, 구현 전.

스킬이 시키는 산출은 한 페이지다.

- fantasy 한 문장
- player verb 하나
- core loop
- pillars 세 개
- scope box (in / out)
- session length
- 가장 위험한 가정 하나
- playtest question 하나

사용자가 그 페이지를 받아들이기 전에는 구현하지 않는다. 받아들인 뒤에만 Skill `name: gamedev`를 열고, 잘린 조각에 해당하는 `path: catalog/<name>/SKILL.md`만 연 다음 그 조각만 구현한다. 구현 중에 스코프를 넓히지 않는다. 사용자가 넓히라고 한 경우에만 페이지를 다시 쓴다. 이것은 스킬 문장이다. 권한 게이트나 새 도구가 아니다.

description은 이 한 줄로 고정한다. 55자, 60 이하, 접기 없음.

```yaml
name: game-design
description: One-page game design before code: loop, pillars, scope.
```

`allowed-tools` 키를 넣지 않는다. 레벨 레이아웃과 주스는 여기 다시 쓰지 않는다. 페이지가 통과되면 본문이 다음 경로만 가리킨다. `catalog/level-design/SKILL.md`, `catalog/game-feel/SKILL.md`. 잼 일정은 `catalog/game-jam/SKILL.md`, 한 시간 프로토타입은 `catalog/prototype-fast/SKILL.md`. 그 워크플로를 `game-design` 안에 옮기지 않는다.

이 문은 스펙만이다. 여기서 `SKILL.md`를 쓰지 않는다.

건드릴 파일:

- `packages/core/src/skills/builtin/game-design/SKILL.md` (신규)
- `packages/core/src/skills/builtin.test.ts`의 `REQUIRED`에 `game-design` 추가. 기존 이름과, Door 0이 넣었다면 `gamedev`는 유지한다. 테스트는 디렉터리 집합이 `REQUIRED`와 정확히 같기를 요구한다.

수용:

- `parseSkillFrontmatter`의 description이 위 문자열 전체다. `">"`가 아니다.
- 본문에 `Claude`, `Anthropic` 부분 문자열이 없다.
- `allowed-tools`가 없다.
- 한 페이지 필드 여덟 개, 스코프 고정 문장, `name: gamedev`와 카탈로그 `path` 지시가 있다.
- `level-design` / `game-feel` 절차를 본문에 다시 teaching하지 않는다.
- 검증: 워크트리에서 `bun test ./packages/core/src/skills/builtin.test.ts`. bare `bun test`는 돌리지 않는다.

비목표: CLI 명령, `/play`, 카탈로그 복사, `frontend-design`으로 대체, 스코프를 코드로 강제하는 도구.

## Door 2 — `raven play` (웹 게임, OS 브라우저)

의존: 없음. Door 0/1과 병렬로 구현할 수 있다. Door 3과 Door 5가 이것을 기다린다.

문제: 웹 게임이 cwd에 있어도 정적 파일을 서빙하거나 브라우저를 여는 제품 명령이 없다. `raven serve`는 에이전트 턴 API다. 광고 독의 `open`은 win32가 없고 게임과 묶이면 안 된다.

제안 동작: 키 없는 명령 `raven play`. `main`이 `doctor`와 같이 프로바이더 게이트 앞에서 반환한다. `bootCli`를 호출하지 않는다. 포지셔널 인자를 받지 않는다. 있으면 exit 2, stderr `usage: raven play`. 디렉터리는 `process.cwd()`다. `--cwd`는 `bootCli`용이라 이 명령에 적용하지 않는다. 에이전트는 Bash의 cwd에서 `raven play`를 실행한다. 경로 인자로 게임을 지정하지 않는다. 게임이 없으면 스캐폴드하지 않는다.

감지는 엔진별 설명이 아니라 파일 규칙이다. 이미 떠 있는 리스너는 보지 않는다. `raven serve`(8787), Ollama(11434), vLLM(8000)이 루프백에 있다. 포트를 스캔하면 게임이 아닌 서버를 연다. 테스트도 안 된다. 첫 일치에서 멈춘다.

1. `package.json`의 `dependencies` / `devDependencies` / `optionalDependencies` 키에 `phaser`, `pixi.js`, `three`, `vite` 중 하나가 있고, `scripts.dev` 또는 `scripts.start`가 있다. 스크립트는 `dev`가 있으면 `dev`, 없을 때만 `start`. 이 경우가 cwd의 `index.html`보다 이긴다. Vite 프로젝트의 루트 `index.html`을 정적 파일로 주면 변환 없이 열려 게임이 돌지 않는다.
2. 아니면 cwd의 `index.html`이 파일이면 정적 루트는 cwd.
3. 아니면 `dist/index.html`이 파일이면 정적 루트는 `dist`. `build/`나 `public/`은 보지 않는다. cwd와 `dist`가 둘 다 있고 1번이 아니면 cwd가 이긴다.
4. 아니면 exit 1. stderr 한 줄: `raven play: no web entry (index.html, dist/index.html, or dev/start with phaser|pixi.js|three|vite)`. 파일을 만들지 않는다. `package.json`이 깨져 있으면 1번이 아닌 것으로 보고 2번으로 넘어간다.

패키지 매니저는 락파일 순서로 고른다. `bun.lock` 또는 `bun.lockb`, 아니면 `pnpm-lock.yaml`, 아니면 `yarn.lock`, 아니면 `npm`. 여러 개면 앞의 것이 이긴다. 설치하지 않는다. 바이너리가 없으면 exit 1, stderr 한 줄에 없는 바이너리 이름. 인자 배열로 spawn한다. 셸 문자열로 붙이지 않는다.

바인드는 `127.0.0.1`만. 호스트 플래그를 받지 않는다. `parseListen`을 재사용하지 않는다. 그 함수는 문자열상 다른 호스트를 돌려주고, 거절은 `serve.ts` 안에만 있다.

- 정적: `Bun.serve({ hostname: '127.0.0.1', port: 0 })`. OS가 포트를 고른다. 잡고 있는 동안 그 포트를 쓴다. `/`는 `index.html`. 그 외는 루트 기준 상대 경로다. `realpath`가 루트 밖이면 403. 디렉터리 목록은 만들지 않는다. 없는 파일은 404. Content-Type은 html, js, css, json, wasm, png, jpg, svg, ogg, mp3, woff2만 구분하고 나머지는 `application/octet-stream`.
- 스크립트: `127.0.0.1:0`에 잠깐 붙여 포트 번호를 얻은 뒤 닫고, 그 번호로 자식을 띄운다. 사이에는 다른 프로세스가 그 포트를 가져갈 수 있다. 정적 모드는 이 경쟁이 없다. 환경 변수 `HOST=127.0.0.1`, `PORT=<n>`. `vite` 키가 있을 때만 인자를 덧붙인다. npm/pnpm/bun은 `run <script> -- --host 127.0.0.1 --port <n>`. yarn은 `<script> --host 127.0.0.1 --port <n>`. `vite`가 없으면 인자를 덧붙이지 않는다. 커스텀 서버가 플래그를 파일 이름으로 먹을 수 있다. 자식을 열기 전에 종료하면 브라우저를 열지 않고 자식 종료 코드로 나간다.

stdout에는 브라우저를 열기 전에 한 줄만 쓴다. `http://127.0.0.1:<port>/`.

브라우저 열기는 `play.ts`가 한다. `adOpenCommand` / `openCreativeUrl`을 호출하지 않는다.

| platform | argv |
|---|---|
| darwin | `open <url>` |
| linux | `xdg-open <url>` |
| win32 | `cmd.exe /c start "" <url>` (`start`의 첫 따옴표 인자는 창 제목이다) |

다른 플랫폼은 열지 않는다. URL은 이미 찍혔다. stderr 한 줄 `raven play: no browser opener for <platform>`. 서버는 유지하고 exit 0으로 기다린다. opener spawn이 실패해도 같다. stderr 한 줄, 프로세스는 서버가 살아있는 동안 0이다. 감지 실패만 서빙 전에 비영이다.

프로세스는 포그라운드다. SIGINT/SIGTERM에 정적 서버를 닫거나 스크립트 자식을 죽이고 exit 0. 데몬으로 빠지지 않는다. 에이전트는 Bash로 실행한다. 명령은 끝나지 않으므로 `run_in_background: true`다. 기본 120초 타임아웃에 두면 서버가 죽는다. 새 도구는 만들지 않는다.

건드릴 파일:

- `packages/cli/src/args.ts` — `ParsedArgv['cmd']`에 `'play'`, 명령 이름 목록에 `play`
- `packages/cli/src/index.ts` — `main`이 `./play`의 `runPlay`를 게이트 전에 호출
- `packages/cli/src/play.ts` — 신규. `doctor.ts`처럼 순수 함수와 `runPlay`를 export. `detectWebEntry`, opener, `runPlay`. `serve.ts`를 import하지 않는다
- `packages/cli/src/play.test.ts` — 모듈 옆. `doctor.test.ts`와 같은 배치
- `packages/cli/src/help.ts`, `help.test.ts` — `raven play` 한 줄. 키 없음
- `packages/cli/src/completions.ts` — `COMPLETION_COMMANDS`
- `packages/cli/src/args.test.ts` — `parseArgv(['play'])`는 `{ cmd: 'play', flags: {} }`
- `README.md` 명령 표에 키 없는 `play` 한 행. Door 0이 README를 열고 있으면 그 커밋 뒤에 한다
- `CONTRIBUTING.md`의 키 없는 명령 목록에 `play` 한 단어

수용:

- 위 우선순위의 임시 디렉터리. 스크립트가 있으면 `index.html`이 있어도 스크립트. `dev`가 `start`보다 앞. 락파일 순서. `vite`일 때만 `--host 127.0.0.1 --port`. phaser만 있으면 env만.
- 정적 서버 테스트는 진짜 `127.0.0.1`에 붙인다. `/`가 index를 준다. 루트 밖은 거절. 디렉터리 목록 본문이 없다. `0.0.0.0`으로 열지 않는다. opener는 주입한다. `open`을 실행하지 않는다.
- 감지 실패는 exit 1, stderr 한 줄, cwd에 파일을 만들지 않는다.
- 여분 포지셔널은 exit 2.
- 홈이나 API 키 없이 `runPlay`가 정적 케이스를 연다.
- 검증: 워크트리에서 `bun test ./packages/cli/src/play.test.ts ./packages/cli/src/args.test.ts ./packages/cli/src/help.test.ts`. bare `bun test` 금지.

비목표: Playwright, CDP, 콘솔 캡처, 자동 `npm install`, 게임 스캐폴드, Godot/Unity/Unreal 에디터 실행, itch/Steam 업로드, `raven serve` 재사용, 광고 독 재사용, 앱 안 브라우저, 호스트 플래그, 이미 떠 있는 포트에 붙기. 업로드와 에디터 절차는 카탈로그 스킬에 남긴다.

## Door 3 — 세션 안 `/play`

의존: Door 2. 같은 `detectWebEntry` / `runPlay`(또는 그 파일에서 export한 start/stop). 감지 규칙을 다시 쓰지 않는다.

문제: 구현 중인 TUI에서 게임을 보려면 셸로 나갔다가 `raven play`를 쳐야 한다. `/bash`로 대신 띄우면 `runBangCommand`가 30초 뒤에 죽이고, 그동안 컴포저가 멈춘다.

제안 동작: `SLASH_COMMANDS`에 `play`를 넣는다. `usage: /play [stop]`, summary는 웹 엔트리를 로컬에서 열고 OS 브라우저를 연다는 한 줄. 별칭 없음.

`HOST_ONLY`에 넣지 않는다. `dispatchSharedSlash`의 case로 처리하고 `'handled'`를 반환한다. `app.tsx`와 `opentui-app.ts`에 case를 추가하지 않는다. 두 파일은 이미 `dispatchSharedSlash`를 호출한다. TUI 크롬(피커, 캔버스, diff 패널)이 아니다. CONTRIBUTING 문장만 따르면 `default`가 `unknown command`로 삼키므로, 공유 case가 먼저다.

`/play`는 감지를 돌리고 서버 또는 자식을 기다리지 않은 채 띄운 다음 `host.notice`에 URL을 찍고 같은 opener로 브라우저를 연다. TUI는 입력을 받는다. 같은 세션에서 이미 띄웠으면 포트를 하나 더 열지 않고 같은 URL을 다시 찍는다. `/play stop`은 그 자식과 정적 서버를 끝내고 포트를 놓는다. 떠 있는 것이 없으면 notice 한 줄. Slack/Discord에는 넣지 않는다.

건드릴 파일:

- `packages/cli/src/commands.ts`
- `packages/cli/src/slash/dispatch.ts`
- `packages/cli/src/commands.test.ts` — `names` 기대 배열에 `play`를 등록 순서대로 추가
- `packages/cli/src/slash/dispatch.test.ts`
- `SLASH_COMMANDS.md`, `SLASH_COMMANDS.ko.md` 한 행 (CONTRIBUTING: 사용자에게 보이는 슬래시)
- `app.tsx`, `opentui-app.ts`는 수정하지 않는다. 공유 case가 두 호스트에 동시에 적용되는지 기존 앱 테스트가 깨지지 않는지만 본다.

수용:

- 임시 `index.html`에서 `/play`가 `unknown command`가 아니고 notice에 `http://127.0.0.1:`이 있다.
- `runBangCommand`를 호출하지 않는다.
- 두 번째 `/play`가 포트를 추가하지 않는다. `/play stop` 뒤에 그 포트가 닫힌다.
- 게임 프레임을 그리는 위젯이 없다.
- 검증: 워크트리에서 `bun test ./packages/cli/src/slash/dispatch.test.ts ./packages/cli/src/commands.test.ts ./packages/cli/src/play.test.ts`.

비목표: 게임을 그리는 TUI 캔버스, 새 에이전트 루프, 채팅 호스트(Slack/Discord)로의 확장, Door 4의 캡처.

## Door 4 — 플레이테스트 캡처 (parked)

의존: 없음. 구현하지 않는다. Door 2가 머지된 뒤 사용자가 다시 요청하면 연다.

문제: 브라우저에 연 뒤에도 세션은 콘솔 에러와 화면을 보지 못한다. `Fetch`는 `127.0.0.1`을 거절한다. 성공적인 프로세스 시작은 씬이 보인다는 증거가 아니다.

왜 별도 문인가: 그 증거를 세션으로 넣으려면 브라우저 드라이버(Playwright, CDP)나, 페이지에 심는 비콘이 필요하다. Door 2는 둘 다 일부러 안 한다. 드라이버를 여기 설계하지 않는다. 도구 이름, 프로토콜, 의존성 버전을 정하지 않는다.

다시 여는 조건: Door 2가 있고, 사용자가 콘솔이나 스크린샷을 세션으로 되돌리라고 한 때.

## Door 5 — Door 2 이후 라우터 한 줄

의존: Door 2. Door 3에는 의존하지 않는다. 벤더 PR에 넣지 않는다. 명령이 없는 스킬이 `raven play`를 말하면 거짓이다. Door 0이 `gamedev/SKILL.md`를 아직 쓰는 동안에는 고치지 않는다.

문제: 웹 엔진 카탈로그는 페이지를 만들게 하지만, 만든 사람이 브라우저로 확인하기 전에 씬이 된다고 말하기 쉽다.

제안 동작: `packages/core/src/skills/builtin/gamedev/SKILL.md`의 웹 엔진 절에 문장 하나만 추가한다. description은 건드리지 않는다. 인덱스가 한 줄로 유지되어야 한다.

```text
After a web page exists, run `raven play` and do not claim the scene works until the browser has been looked at.
```

Bash로 띄울 때는 `run_in_background: true`다. Door 4가 닫혀 있는 동안 "looked at"은 사용자 눈이다. 모델은 스크린샷을 지어내지 않는다. `Fetch`로 `127.0.0.1`을 읽으라고 쓰지 않는다.

건드릴 파일: 그 `SKILL.md`만. `REQUIRED`는 이미 `gamedev`가 있을 때다.

수용:

- 웹 엔진 절의 추가가 그 한 문장이다.
- description은 한 줄이고, 벤더 브랜드 부분 문자열 두 개가 여전히 없다.
- 검증: 워크트리에서 `bun test ./packages/core/src/skills/builtin.test.ts`.

비목표: 카탈로그 74개의 본문 수정, `raven play`의 재구현, 캡처 도구.

## 구현 시 합치지 말 것

문을 고를 때 그 문의 수용만 만족하면 된다. Door 1 구현이 `play.ts`를 만들지 않는다. Door 2 구현이 `game-design`을 쓰지 않는다. Door 2 구현이 `gamedev/SKILL.md`에 Door 5 문장을 넣지 않는다. Door 4는 어느 구현의 후속 작업 목록에도 설계를 남기지 않는다.
