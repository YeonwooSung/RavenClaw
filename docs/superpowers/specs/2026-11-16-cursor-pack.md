# cursor-pack — Cursor 플러그인 스킬 마이그레이션

Status: draft

Upstream: https://github.com/cursor/plugins (checkout used for the vendor is a shallow clone of `main`). Each included plugin directory carries its own MIT license. Copyright 2026 Cursor, Copyright 2026 Lauren Tan (`pstack`), Copyright 2026 Dylan Gattey (`dyl-stack`).

This spec adds one builtin router. It does not add a plugin marketplace, a slash command, an engine phase, or a schema bump.

## 문제

`cursor/plugins`는 스킬 173개, 서드파티 MCP 플러그인 122개다. RavenClaw 빌트인은 `packages/core/src/skills/builtin/<name>/SKILL.md` 한 단계만 인덱스에 올라가고, `builtin.test.ts`의 `REQUIRED`와 디렉터리 집합이 같아야 한다. 카탈로그를 최상위로 펼치면 인덱스가 비대해지고 기존 이름 검사가 깨진다.

RavenClaw에 없는 것: Cursor canvas, Cursor SDK, Origin API, cloud agent, stop hook, 서브에이전트별 모델 슬러그, `agents[]`와 `run_in_background`의 동시 사용. 있는 것: Skill 도구의 `path`, Agent 도구(깊이 1, 한 번에 최대 6), `/loop` (최대 20), `~/.ravenclaw/config.yaml`의 `mcp.servers` (`stdio` | `http` | `sse`, `headers`는 리터럴), 로컬 `plugin.json` 커맨드 툴.

## 형상

빌트인 하나. 이름 `cursor-pack`. 디렉터리 `packages/core/src/skills/builtin/cursor-pack/`.

```
cursor-pack/
  SKILL.md          라우터. 원문. allowed-tools 없음.
  LICENSE           MIT. 위 세 copyright 줄을 모두 포함한다.
  NOTICE            업스트림 URL, copyright, 수정 사항.
  catalog/<name>/SKILL.md
  references/catalog-index.md
  references/mcp-servers.json
  references/skipped.md
```

라우터 description은 정확히 `Cursor plugin workflows, principles, and MCP map.` 이다. 60자 이하다. 접힌 `description: >`를 쓰지 않는다.

카탈로그 본문은 인덱스에 없다. Skill 도구 이름 `cursor-pack`, path `catalog/<name>/SKILL.md`.

## 가져오는 스킬

업스트림 스킬 디렉터리 전체를 복사한다. `SKILL.md`의 형제 파일 중 텍스트(`.md`, `.mdc`, `.json`, `.txt`, `.yml`, `.yaml`, `.py`, `.ts`, `.js`, `.toml`, `.html`, `.css`, `.sh`, `.csv`)만 포함한다. 이미지와 바이너리는 제외한다.

| 업스트림 | 비고 |
|---|---|
| `advisor/skills` | |
| `agent-compatibility/skills` | |
| `cli-for-agent/skills` | |
| `continual-learning/skills` | |
| `cursor-team-kit/skills` | `pr-review-canvas` 제외 |
| `dyl-stack/skills` | |
| `grok-voice/skills` | |
| `pstack/skills` | `harness/pstack` 복제본은 제외 |
| `pstack/automations/benny/skills` | 카탈로그 이름에 플러그인 접두 `benny` |
| `ralph-loop/skills` | |
| `teaching/skills` | |
| `thermos/skills` | |

이름 규칙:

- 디렉터리 이름이 서로 겹치면 `<plugin>--<skill>` 로 둘 다 바꾼다. 겹치는 이름은 `thermo-nuclear-code-quality-review` 하나다. 결과는 `cursor-team-kit--thermo-nuclear-code-quality-review` 와 `thermos--thermo-nuclear-code-quality-review`.
- 디렉터리 이름이 빌트인 이름과 같으면 `<plugin>-<skill>` 로 바꾼다. 해당은 `pstack`의 `tdd` → `pstack-tdd`. 빌트인 `tdd`를 가리지 않는다. 카탈로그 frontmatter `name`은 디렉터리 이름과 같다.
- 그 외 이름은 업스트림 스킬 디렉터리 이름을 유지한다.

원문 카탈로그 스킬 둘은 업스트림 복사가 아니다.

- `local-plugin`: RavenClaw `plugin.json` 커맨드 툴. 경로 `<project>/.ravenclaw/plugins/<name>/plugin.json` 또는 `~/.ravenclaw/plugins/<name>/plugin.json`. `.cursor-plugin` 스캐폴드를 만들지 말라고 적는다.
- `mcp-servers`: `references/mcp-servers.json`에서 항목 하나를 `mcp.servers`에 복사하는 절차. `${VAR}`는 사용자가 쓴 파일 안에서만 바꾼다. 시크릿을 커밋하지 않는다.

벤더 스킬의 frontmatter는 `name`과 한 줄 `description`만 남긴다. `description`은 `>`나 `|`가 아니고 길이가 8보다 크다. `allowed-tools`를 넣지 않는다. 본문 바로 위에 이 문장을 넣는다.

`RavenClaw note: upstream MIT text from https://github.com/cursor/plugins. Ignore Cursor stop hooks, cloud agents, canvases, and model slugs. Use the cursor-pack router limits.`

트리 전체(라우터, 카탈로그, references, LICENSE, NOTICE)를 소문자로 펼쳤을 때 `claude`와 `anthropic`이 없다. 그 부분 문자열은 복사 중에 지운다. `CLAUDE.md`는 `RAVEN.md`로, `AGENTS.md`는 `.ravenclaw/RAVEN.md`로 바꾼 뒤에 남은 부분 문자열을 지운다.

## MCP 맵

`third_party/*/mcp.json`의 서버를 `references/mcp-servers.json` 배열로 모은다. 요소는 `name`, `plugin`, `type`, 그리고 `url` 또는 `command`다. `args`, `headers`, `env`가 있으면 그대로 둔다. `url`이 있으면 `type`은 업스트림 값 또는 `http`. `command`가 있으면 `type`은 `stdio`. 이름이 겹치면 `plugin`을 접두로 붙인다.

고정 항목:

- plugin `github`, url `https://api.githubcopilot.com/mcp/`
- plugin `playwright`, command `npx`, args에 `@playwright/mcp@latest`

URL이 `https://`도 아니고 `${`로 시작하지도 않으면 실패다. 헤더 값의 비밀은 `${...}` 자리표시자이거나 비어 있다. 설치는 하지 않는다.

## 제외

`references/skipped.md`에 이유를 적는다. 본문을 복사하지 않는다.

- `cursor-sdk`: Cursor TypeScript SDK
- `origin-apps`: Cursor Origin API
- `docs-canvas`, `pr-review-canvas`: Cursor canvas. team-kit 사본도 제외
- `orchestrate`: Cursor cloud agent와 SDK 스크립트
- `harness` 아래 pstack 복제본
- `create-plugin`: `.cursor-plugin` 스캐폴드. 대신 `local-plugin`
- `third_party`의 로고와 마케팅 문서. 엔드포인트만 MCP 맵으로 옮긴다

제외 문서에도 `claude` / `anthropic` 부분 문자열을 넣지 않는다.

## 라우터 한계

카탈로그 문장과 충돌하면 라우터가 이긴다. 라우터 본문에 다음을 적는다.

- Skill 도구 이름 `cursor-pack`와 예시 path `catalog/cli-for-agents/SKILL.md`
- `references/catalog-index.md`, `references/mcp-servers.json`, `references/skipped.md`
- Agent 깊이 1, 한 번에 최대 6. `agents[]`와 `run_in_background`를 같이 두지 않는다.
- 카탈로그 id는 `general`, `file-finder`, `command-runner`, `reviewer`, `researcher-web`. 자식 모델 슬러그와 cloud environment는 없다.
- Ralph 반복은 `/loop <n> <prompt>` 이고 n은 최대 20이다. stop hook은 없다.
- 상태 파일은 `.ravenclaw/` 아래다. `.cursor/`가 아니다.
- 게임은 `gamedev`, 프로젝트 에이전트 설계는 `team-design`.

## 테스트

`packages/core/src/skills/builtin.test.ts`의 `REQUIRED`에 `cursor-pack`를 넣는다. 기존 11개 이름과 team-design 바이트 핀은 유지한다.

같은 파일에 `cursor-pack` 검사를 추가한다.

- 최상위 디렉터리 집합이 `REQUIRED`와 같다.
- 라우터 description 정확 일치, `allowed-tools` 없음, 위 한계 문장을 포함한다.
- 카탈로그 디렉터리 이름이 frontmatter `name`과 같고, description 규칙과 벤더 노트(원문 둘은 노트 없음)를 지킨다.
- `local-plugin`, `mcp-servers`, `pstack-tdd`, `cli-for-agents`, `ralph-loop`, 두 thermo 접두 이름이 있다.
- 트리 소문자에 `claude`와 `anthropic`이 없다.
- MCP 맵의 github / playwright 고정과 URL 규칙을 검사한다.
- `skipped.md`가 제외 플러그인 이름을 포함한다. `cursor-sdk`, `origin-apps`, `docs-canvas`, `orchestrate`, `create-plugin`.

검증은 워크트리에서만 한다.

`bun test ./packages/core/src/skills/builtin.test.ts`

저장소 전체 `bun test`와 `bash scripts/ci-unit.sh`는 돌리지 않는다. `package.json`의 `test`는 바꾸지 않는다.

## 문서

구현과 같은 변경에서 개수 11을 12로 고친다.

- `ARCHITECTURE.md`의 빌트인 개수와 `cursor-pack` 한 문장
- `ARCHITECTURE.ko.md`의 같은 개수
- `README.md`의 Eleven builtins 문장
- `CHANGELOG.md` Unreleased 항목 하나

버전은 올리지 않는다. 공식 19-skill 세트는 계속 복사하지 않는다.

## 하지 않는 것

슬래시 추가, `packages/cli` 동작 변경, MCP 자동 설치, 시크릿 기록, `bun.lock` 커밋, 마켓플레이스, canvas/SDK/Origin/cloud agent 구현, `harness` 복제본 벤더.
