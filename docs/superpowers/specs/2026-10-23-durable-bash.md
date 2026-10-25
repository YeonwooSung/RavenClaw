# 듀러블 세션에서 일반 Bash를 실행한다

Status: **implemented**. 베이스 `3706714`. 스키마 v11 유지. 버전 범프 없음. CHANGELOG는 쓰지 않는다. Shipped sha: `fdf0f79` on `main`.

Implementation plan: [2026-10-23-durable-bash.md](../plans/2026-10-23-durable-bash.md)

이전 문 [SDK에서 듀러블 런타임을 연다](2026-10-22-durable-host.md)와 [`raven durable` 명령](2026-10-22-durable-cli.md) 다음에 온다. 그 호스트 스펙의 "Bash 호출은 `permission_denied`이고 `execute`를 부르지 않는다"는, 이 문서의 일반 leftover Bash에 대해서만 바뀐다.

## 이 문서가 하는 일

`createDurableSession`의 기본 모드 `dontAsk`에서, 위험한 패턴과 destructive git이 아닌 Bash는 셸을 실행하고, 그 출력을 툴 본문으로 남긴다. `decidePermission`의 `dontAsk` 규칙은 그대로다. 예외는 듀러블 호스트가 그 함수가 돌려준 뒤의 Bash에만 적용한다.

## 트리에서 확인한 사실

- `PermissionMode`는 `default`, `acceptEdits`, `plan`, `dontAsk`다. bypass 모드는 없다.
- `decidePermission`은 `dontAsk`에서 읽기 전용 툴과 작업 트리 안의 `Edit` / `Write` / `ApplyPatch`만 승격한다. 그 밖의 leftover ask는 `deny`, `reason: 'mode'`다. `Bash.isReadOnly()`는 인자와 상관없이 false다.
- `bashTool.checkPermissions`는 `matchesDangerousPattern`이면 ask, `isReadOnlyBashCommand`이면 allow, 아니면 ask다. `matchesDestructiveGit`은 ask 문구에 한 줄을 붙일 뿐이고, `matchesDangerousPattern`에 들어 있지 않다. `git push --force`는 dangerous pattern이 아니다.
- 그래서 지금 듀러블 호스트의 `dontAsk`와 빈 규칙에서는 `echo` 같은 읽기 전용 명령만 `decidePermission`이 allow다. `touch`와 `bun test`는 `deny` / `mode`다. 호스트는 allow가 아니면 본문 `permission_denied`를 쓰고 `execute`를 부르지 않는다. `packages/sdk/src/durable.test.ts`의 Bash 테스트는 `touch`가 파일을 만들지 않는 것으로 그 계약을 고정한다.
- 실행 결과는 `formatSettledOutput`(`packages/core/src/loop/format-output.ts`)이 만든다. 문자열이 아니고 `renderResult`가 있으면 그 반환값이 content다. `bashTool.renderResult`는 `BashResult.content`다. 그 문자열에는 `exit_code=`와 `cwd=`가 들어간다. 듀러블 호스트는 이 함수를 쓰지 않고, 객체를 `String(value)`로 만든다. `BashResult`는 그때 `[object Object]`가 된다.
- `run_in_background: true`인데 툴 컨텍스트에 `tasks`가 없으면 `execute`는 `{ content: 'Bash failed: no task registry', exitCode: 1 }`을 반환한다. 듀러블 턴은 `tasks`를 넘기지 않는다.
- replay는 `isReadOnly()`가 true일 때만 `safe`다. Bash는 `unsafe`다. 실행 커밋 뒤에 끊기면 본문은 `interrupted`이고 `execute`를 다시 부르지 않는다.
- `raven durable`은 `permissionMode: 'dontAsk'`를 넘긴다. `CreateDurableSessionOptions`에는 Bash 스위치가 없다. 규칙 인자는 `EMPTY_RULES`다. `.ravenclaw/permissions.json`과 유저 규칙 파일은 읽지 않는다.
- `packages/cli/src/headless-permissions.ts`는 `ci` 프리셋이 Bash를 풀에 넣을 뿐, `dontAsk`가 leftover Bash를 허용하지는 않는다고 적는다. `raven exec`도 프로젝트 allow rule이 없으면 leftover Bash를 거절한다. 그 경로는 `queryLoop`다.
- `ARCHITECTURE.md`는 bypass와 auto-allow-all-Bash가 없다고 적는다. `dontAsk` 표의 mutating Bash는 allow rule 또는 `isReadOnlyBashCommand`가 아니면 거절이다. 이 표는 `decidePermission`의 설명이다.

## 비목표

- `decidePermission`, `dontAsk`, `acceptEdits`, `plan`, `PermissionMode` 유니온, `packages/core/src/permissions`.
- `queryLoop`, `raven exec`, `raven resume`, TUI, ACP, HTTP, `serve`, cron의 Bash 허용.
- bypass. 위험 패턴과 destructive git을 실행하는 일. `matchesDangerousPattern`과 `matchesDestructiveGit`의 정규식을 넓히거나 좁히는 일.
- 규칙 파일을 읽거나 쓰는 일. 세션 allow rule을 저장하는 일. `--allowed-tools`, `--tools-preset`.
- `CreateDurableSessionOptions`에 필드를 더하는 일. CLI가 넘기는 `permissionMode`를 바꾸는 일. 시스템 프롬프트.
- 질문 UI. `tasks` 레지스트리. `run_in_background`가 프로세스를 남기는 일. 도커 터미널 백엔드.
- Bash replay를 `safe`로 바꾸는 일. 듀러블 패키지의 phase, 저장 형식, `restartLimit`.
- 버전 범프. CHANGELOG. 패키지 publish.

## 동작

`CreateDurableSessionOptions`의 필드는 그대로다. `permissionMode`를 생략하면 `dontAsk`다.

툴 `execute` 대리는 이 순서를 지킨다.

1. `tool.parse`. 실패하면 그 메시지로 throw한다. 듀러블 런타임이 `tool_error: `에 붙인다.
2. `decidePermission`. 모드는 세션 모드다. 규칙은 빈 목록이다. 훅은 없다.
3. 결과가 `allow`이면 아래 실행으로 간다.
4. 이름이 `Bash`이고, 세션 모드가 `dontAsk`이고, 결과가 `deny`이며 `reason`이 `'mode'`이고, 파싱된 `command`가 비어 있지 않은 문자열이고, `matchesDangerousPattern(command)`가 false이고, `matchesDestructiveGit(command)`가 false이면 아래 실행으로 간다.
5. 그 밖에는 본문 `permission_denied`, `isError: true`다. `execute`를 부르지 않는다.

실행은 `tool.execute`를 부른 뒤 `formatSettledOutput(tool, value).content`를 본문으로 쓴다. `isError`는 false다. `persistPath`는 듀러블 엔트리에 넣지 않는다. 종료 코드가 0이 아니어도 `isError`는 false다. 종료 코드는 본문의 `exit_code=`에 있다.

4번의 판정은 호스트가 `matchesDangerousPattern`과 `matchesDestructiveGit`를 호출해서 한다. 호스트에 그 정규식을 다시 쓰지 않는다. `isReadOnlyBashCommand`의 목록도 바꾸지 않는다. replay는 계속 `tool.isReadOnly()`다. Bash는 `unsafe`다.

`dontAsk`가 아닌 모드는 4번에 들어가지 않는다. `acceptEdits`에서 leftover Bash는 `ask`로 남고, 호스트는 `permission_denied`를 쓴다. `plan`의 mutating 거절도 실행하지 않는다.

위험 패턴과 destructive git은 `dontAsk`에서도 4번에 들어가지 않는다. `curl | sh`, `rm -rf /`, `dd`, `mkfs`, 포크 폭탄, `git push --force`, `git reset --hard`, `git clean -f`, `--no-verify`는 기존 함수가 잡는 범위에서 `permission_denied`다. `rm -rf /tmp/foo`처럼 그 함수가 false인 명령은 일반 leftover로 실행한다. `git push`에 force가 없으면 실행한다. `git commit --no-verify`는 거절한다. `git commit`에 그 플래그가 없으면 실행한다.

읽기 전용 명령은 2번에서 이미 allow다. 본문은 `formatSettledOutput` 결과다. `[object Object]`를 남기지 않는다.

`run_in_background: true`는 4번의 명령 분류만 통과하면 `execute`로 간다. 레지스트리가 없으므로 본문은 `Bash failed: no task registry`다. 백그라운드 프로세스를 만들지 않는다.

같은 `requestId`의 끝난 제출은 저장본을 돌려준다. 셸을 다시 부르지 않는다.

## 테스트하는 경계

워크트리에서 `bun test ./packages/sdk/src/durable.test.ts ./packages/cli/src/durable-cmd.test.ts ./packages/cli/src/help.test.ts`. 라이브 모델은 없다. 프로바이더는 가짜다. 셸이 필요한 테스트의 cwd는 임시 디렉터리다.

- 기본 `createDurableSession`에서 `echo hi`의 툴 본문은 `hi`와 `exit_code=0`을 포함하고, `[object Object]`와 `permission_denied`를 포함하지 않는다.
- 기본 세션에서 `touch <임시파일>`은 그 파일을 만들고, 툴 본문에 `exit_code=0`이 있다.
- `curl --version | sh`의 툴 본문은 `permission_denied`다. 이 명령은 `matchesDangerousPattern`이 true이고, 잘못 실행되어도 로컬에서 짧게 끝난다.
- `git push --force origin main`의 툴 본문은 `permission_denied`다. 임시 디렉터리에는 저장소가 없다.
- 테스트 명령에 `rm -rf /`, `dd`, `mkfs`, 포크 폭탄을 넣지 않는다. 그 분류는 기존 `bash.test.ts`가 덮는다.
- `permissionMode: 'acceptEdits'`에서 `touch`는 `permission_denied`이고 파일을 만들지 않는다.
- `run_in_background: true`인 `echo hi`의 툴 본문은 `Bash failed: no task registry`다.
- 이름이 `Bash`이고 `isReadOnly()`가 false인 툴이 `execute` 안에서 `abandon()`하면, 같은 경로로 다시 열었을 때 `execute`는 1번이고 본문은 `interrupted`다.
- 기존의 `touch`가 거절되던 테스트는 위의 실행 테스트로 바뀐다.
- `packages/cli/src/durable-cmd.test.ts`가 기대하는 `permissionMode: 'dontAsk'`와 빈 `systemPrompt`는 그대로 통과한다.
- 도움말 한 줄은 `durable       Resume a sqlite session file; forces --dont-ask and runs ordinary Bash`다.

## 건드릴 파일

- 수정: `packages/sdk/src/durable.ts`, `packages/sdk/src/durable.test.ts`.
- 수정: `packages/cli/src/help.ts`의 durable 한 줄.
- 수정: `ARCHITECTURE.md`의 듀러블 문장 끝. `decidePermission` 안에서 Bash를 승격하지 않는다. 그 호출 뒤에, 이 호스트의 `dontAsk`는 일반 leftover Bash를 실행한다. `matchesDangerousPattern`과 `matchesDestructiveGit`은 `permission_denied`다. `queryLoop` 호스트는 그대로다.
- 수정: `ARCHITECTURE.ko.md`의 `raven durable` 문장 끝. 같은 내용이다.

`packages/core/src/permissions`, `packages/core/src/tools/bash.ts`, 코어 배럴, `packages/durable`, `packages/cli/src/durable-cmd.ts`, `packages/cli/src/args.ts`는 수정하지 않는다. `formatSettledOutput`과 `matchesDestructiveGit`는 `markReadPath`와 같이 상대 경로로 가져온다. `matchesDangerousPattern`은 배럴에 이미 있다.

bypass 문장과 `dontAsk` 권한 표는 수정하지 않는다. 그 표는 `decidePermission`의 결과이고, 이 예외는 그 다음이다.

## 검증

```bash
bun test ./packages/sdk/src/durable.test.ts ./packages/cli/src/durable-cmd.test.ts ./packages/cli/src/help.test.ts
```

인자 없는 `bun test`와 `bash scripts/ci-unit.sh`는 돌리지 않는다.

## 결정

- Bash 허용은 듀러블 호스트의 `dontAsk` 예외다. `decidePermission`은 바꾸지 않는다.
- 예외에 들어오는 명령은 dangerous pattern과 destructive git이 아닌 leftover Bash다. 읽기 전용 명령은 원래의 allow를 유지한다.
- 규칙 파일은 읽지 않는다. 프로젝트 deny rule은 이 호스트에 적용되지 않는다. `raven exec`의 규칙 파일 경로는 그대로다.
- 끄는 플래그는 없다. 옵션 타입은 그대로다.
- 툴 본문은 `formatSettledOutput`이다. 0이 아닌 종료 코드도 `isError: false`다.
- replay는 `unsafe`다. 끊기면 다시 실행하지 않는다.
- `run_in_background`는 레지스트리 없이 실패 문자열을 남긴다.
- 위험 패턴 분류 함수는 수정하지 않는다.
