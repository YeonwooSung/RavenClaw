# `raven durable` 명령

Status: **draft**. 베이스 `6d4235d`. 스키마 v11 유지. 버전 범프 없음. CHANGELOG는 쓰지 않는다. 워크트리 `docs/durable-cli`. 동작은 이 브랜치에 구현되어 있다. 머지 전이므로 Shipped sha는 없다.

Implementation plan: [2026-10-22-durable-cli.md](../plans/2026-10-22-durable-cli.md)

이전 문 [SDK에서 듀러블 런타임을 연다](2026-10-22-durable-host.md)의 `createDurableSession`을 CLI에서 연다. 기본 TUI와 `raven exec`, `raven resume`은 그대로다.

## 이 문서가 하는 일

`raven durable --path <file> <prompt>` 한 명령이다. 같은 경로와 같은 프롬프트를 다시 실행하면 그 제출을 이어 받고, 끝난 답을 표준 출력에 찍는다. 세션 데이터베이스 `state.db`는 열지 않는다.

## 트리에서 확인한 사실

- 명령 이름은 `parseArgv`(`packages/cli/src/args.ts`)의 첫 위치 인자다. `exec`의 나머지 위치 인자는 공백으로 이어 프롬프트가 된다.
- `raven resume`은 `state.db` 세션을 TUI로 연다. 이 이름과 겹치지 않는다.
- `bootCli`는 `createSession: false`여도 `createSqliteStore(join(home, 'state.db'))`를 연다. 프로바이더만 만드는 함수는 `providerFromConfig`(`packages/cli/src/engine.ts`)다.
- 키가 없으면 `exec`와 같이 `providerConfigured`가 실패하고 `SETUP_HINT`를 찍은 뒤 종료 코드 1이다.
- `createDurableSession`은 열릴 때 `resume()`을 한 번 기다린다. `submit`의 `requestId`가 같으면 사용자 엔트리를 더하지 않고 기존 제출을 돌려준다. 진행 중이면 `DurableBusy`다.
- CLI의 `package.json`은 SDK를 의존하지 않는다. SDK는 CLI를 의존하지 않는다.

## 비목표

- 기본 TUI, `raven exec`, `raven resume`, `queryLoop`, `SessionEngine`, `state.db`.
- `createDurableSession`의 인자나 반환 타입을 바꾸는 일. 프롬프트 없이 마지막 답만 다시 찍는 일.
- `--json`, 스트림 partial, 권한 질문, `Bash`를 허용하는 일.
- `--allowed-tools`, `--tools-preset`, `--agent`, `--worktree`, `--json-schema`를 이 명령에 적용하는 일.
- 시스템 프롬프트 조립. `buildSystemParts`는 부르지 않는다.
- 버전 범프. CHANGELOG.

## 동작

```
raven durable --path <file> <prompt>
```

`--path`는 이 명령에서만 받는다. `durable`이 아닌데 `--path`가 있으면 `unknown flag: --path`다. 값은 `--path <file>` 또는 `--path=<file>`이다. 빠지면 표준 에러에 `usage: raven durable --path <file> <prompt>`를 찍고 종료 코드 2다. 프롬프트가 없어도 같다.

프롬프트는 `durable`과 `--path` 값을 뺀 위치 인자를 공백으로 잇는다. 기존 `exec`와 같다.

경로는 그대로 `createDurableSession`의 `path`로 넘긴다. basename이 `state.db`이면 SDK가 거절한다. 그 메시지는 표준 에러이고 종료 코드 1이다. 명령은 그 파일을 미리 만들지 않는다.

프로바이더는 `loadConfig` 다음에 `providerFromConfig`다. `bootCli`는 부르지 않는다. `state.db`는 열지 않는다. `providerFromConfig`가 하는 included gateway 확인은 그대로다. 모델 문자열은 플래그가 반영된 `config.model`이다. `cwd`는 `--cwd`가 있으면 그 값이고, 없으면 `process.cwd()`다.

`createDurableSession`에는 `permissionMode: 'dontAsk'`를 넘긴다. `systemPrompt`는 넘기지 않는다. `--dont-ask`는 `exec`처럼 이 명령에서도 켠다. 질문 UI는 없다.

`requestId`는 `durable:` 뒤에, 정규화한 절대 경로와 프롬프트를 NUL 한 글자로 잇고 SHA-256한 hex다. 같은 경로와 같은 프롬프트는 같은 id다. 경로 표기가 달라도 같은 파일이면 같다. `path.resolve`로 절대 경로를 만든 뒤 해시한다.

순서는 이렇다.

1. 키가 없으면 `SETUP_HINT`를 찍고 1로 끝난다.
2. `createDurableSession`이 열리며 끊긴 phase를 이어 받는다.
3. 그 세션에 프롬프트와 이 `requestId`로 `submit`한다.
4. `wait`이 `{ status: 'done', text }`이면 text를 표준 출력에 한 줄로 찍고 0이다.
5. `{ status: 'unanswered', reason }`이면 reason을 표준 에러에 찍고 1이다.
6. `DurableBusy`를 비롯한 예외는 메시지를 표준 에러에 찍고 1이다.
7. `close()`는 성공이든 실패든 마지막에 호출한다.

끝난 제출을 같은 명령으로 다시 실행하면 저장본의 답을 다시 찍고, 사용자 엔트리는 늘지 않는다. 모델은 다시 부르지 않는다.

## 테스트하는 경계

워크트리에서 `bun test ./packages/cli/src/args.test.ts ./packages/cli/src/durable-cmd.test.ts ./packages/cli/src/help.test.ts ./packages/cli/src/completions.test.ts`. 라이브 모델은 없다. `createDurableSession`은 테스트에서 바꾼다.

- `parseArgv(['durable', '--path', 'sess.sqlite', 'hello', 'there'])`는 명령 `durable`, 경로 `sess.sqlite`, 프롬프트 `hello there`다.
- `parseArgv(['exec', '--path', 'sess.sqlite', 'hi'])`는 throw한다.
- 경로나 프롬프트가 없으면 실행기는 종료 코드 2이고 `createDurableSession`을 부르지 않는다.
- 실행기는 `bootCli`를 부르지 않는다. 넘기는 `permissionMode`는 `dontAsk`이고 `systemPrompt`는 없다.
- 같은 절대 경로와 같은 프롬프트의 `requestId`는 같다. 프롬프트가 다르면 id도 다르다.
- 가짜 세션이 `done` / `hello`를 돌려주면 표준 출력은 `hello\n`이고 종료 코드는 0이다. `unanswered` / `task_parked`이면 표준 에러에 그 reason이 있고 종료 코드는 1이다.
- 도움말과 완성 목록에 `raven durable`과 `durable`이 있다.
- `createRavenSession`과 `packages/durable` 소스는 그대로다.

## 건드릴 파일

- 추가: `packages/cli/src/durable-cmd.ts`, `packages/cli/src/durable-cmd.test.ts`.
- 수정: `packages/cli/src/args.ts`, `packages/cli/src/index.ts`, `packages/cli/src/help.ts`, `packages/cli/src/help.test.ts`, `packages/cli/src/completions.ts`.
- 수정: `packages/cli/package.json`에 `@ravenclaw/sdk` 워크스페이스 의존.
- 수정: `ARCHITECTURE.md`와 `ARCHITECTURE.ko.md`의 의존 문장. CLI가 `raven durable`을 위해 SDK를 의존한다. SDK는 CLI를 의존하지 않는다.

`packages/sdk/src/durable.ts`, `packages/durable`, `packages/core`는 건드리지 않는다.

## 검증

```bash
bun test ./packages/cli/src/durable-cmd.test.ts ./packages/cli/src/help.test.ts ./packages/cli/src/completions.test.ts
```

인자 없는 `bun test`와 `bash scripts/ci-unit.sh`는 돌리지 않는다. `args` 파싱 테스트가 이미 다른 파일에 있으면 그 파일도 같은 방식으로 돌린다.

## 결정

- 명령 이름은 `durable`이다. `resume`은 `state.db`용으로 남긴다.
- 재실행은 같은 경로와 같은 프롬프트의 `requestId`다.
- `bootCli`와 `state.db`는 쓰지 않는다. 프로바이더는 `providerFromConfig`다.
- 권한 모드는 `dontAsk`로 고정한다. `Bash` 허용은 다음 문이다.
- 시스템 프롬프트는 비운다.
- SDK 함수 시그니처는 바꾸지 않는다.
