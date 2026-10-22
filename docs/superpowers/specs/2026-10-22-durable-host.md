# SDK에서 듀러블 런타임을 연다

Status: **draft**. 동작은 이 워크트리 `docs/durable-host`에 구현되어 있다. 베이스 `659cfb9`. 머지 전이므로 Shipped sha는 없다. 스키마 v11 유지. 버전 범프 없음. CHANGELOG는 쓰지 않는다.

이전 문 [듀러블 런타임 패키지](2026-10-22-durable-harness.md)는 `@ravenclaw/durable`만 둔다. 그 문의 비목표에 있던 SDK 연결이 이 문이다. 패키지 계약은 바꾸지 않는다.

## 이 문서가 하는 일

`createRavenSession`은 그대로 `queryLoop`와 `state.db`를 쓴다. 그 옆에 `createDurableSession` 하나를 둔다. 호출자가 sqlite 파일 경로를 넘기면, SDK가 그 파일로 듀러블 런타임을 열고, 프로바이더 스트림을 한 번의 `complete`로 모으고, 파일 툴 여섯 개를 붙인다. 같은 경로로 다시 열면 커밋된 phase 다음부터 이어진다.

## 트리에서 확인한 사실

- `@ravenclaw/sdk`의 `createRavenSession`(`packages/sdk/src/index.ts`)은 `createSessionEngine`을 연다. 기본 `askUser`는 `'deny'`를 반환한다. 저장은 `openStore`로 `state.db`다.
- `@ravenclaw/durable`은 `openSqliteStorage(path)`와 `openDurable(storage, options)`를 내보낸다. `openDurable`은 phase를 돌리지 않는다. `resume()`이나 `submit`이 스케줄러를 켠다. 루트 conversation id는 1이다. 저장소의 `readEntries(1)`로 커밋된 엔트리를 읽을 수 있다.
- 모델 포트는 `Provider.stream`이 청크를 흘리고, 듀러블 모델은 `complete()` 한 번이 텍스트와 툴 호출을 돌려준다. 듀러블 메시지에는 thinking이 없다.
- 코어 툴 `Read`, `Glob`, `Grep`의 `isReadOnly()`는 true다. `Write`, `Edit`, `Bash`는 false다.
- `Edit`은 `turn.readFiles`에 경로가 있어야 한다. `markReadPath`(`packages/core/src/tools/read-files.ts`)가 그 집합과 mtime을 채운다. 이 집합은 `SessionEngine`의 메모리에만 있고 `state.db`에 없다.
- 권한은 `decidePermission`(`packages/core/src/permissions/pipeline.ts`)이 모드를 적용한다. `acceptEdits`와 `dontAsk`는 작업 트리 안의 `Write`/`Edit`만 승격한다. `Bash`는 그 승격에 없다. `dontAsk`에서 남은 ask는 거절이다. 이 호스트에는 사용자에게 묻는 채널이 없다.

## 비목표

- `createRavenSession`, `queryLoop`, `SessionEngine`, `state.db`, 스키마 v11을 바꾸는 일.
- CLI 플래그, TUI, 슬래시, ACP, HTTP, `serve`.
- 듀러블 패키지의 phase, replay, `restartLimit`, 저장 형식 변경.
- compaction, fork, 서브에이전트, MCP, 스킬, cron, AskUser, 스트림 partial을 호출자에게 흘리는 일.
- 권한 질문 UI. `Bash`를 모드만으로 허용하는 일. `bypass` / 전부 허용.
- 기본 툴을 여섯 개보다 늘리는 일. 이미지 블록을 듀러블 메시지에 넣는 일.
- 버전 범프. CHANGELOG. 패키지 소스에 pi 코드를 붙이는 일.

## 동작

새 파일 `packages/sdk/src/durable.ts`. `packages/sdk/src/index.ts`는 `createDurableSession`과 그 옵션, 반환 타입만 다시 내보낸다. `packages/sdk/package.json`에 `@ravenclaw/durable` 워크스페이스 의존을 더한다. `@ravenclaw/durable`은 코어와 프로바이더를 import하지 않은 채로 둔다. 어댑터는 SDK에만 있다.

```ts
export async function createDurableSession(opts: {
  path: string
  cwd: string
  provider: Provider
  model: string
  systemPrompt?: string
  permissionMode?: PermissionMode
}): Promise<DurableRavenSession>

export type DurableRavenSession = {
  submit(input: { content: string; requestId?: string }): Promise<DurableSubmission>
  resume(): Promise<void>
  close(): Promise<void>
}
```

`permissionMode`의 기본값은 `'dontAsk'`다. `DurableSubmission`은 `@ravenclaw/durable`의 그 타입이다.

`path`는 호출자가 고른 sqlite 파일이다. 빈 문자열이면 연다기 전에 거절한다. 정규화한 basename이 `state.db`이면 거절한다. 거절은 throw이고 파일은 만들지 않는다. 잠금은 이 문에 없다. 한 번에 한 호출만 그 파일을 연다.

열 때 `openSqliteStorage(path)` 다음에 `openDurable`을 호출한다. `modelId`는 `opts.model`이다. `systemPrompt`가 있으면 그 문자열을 넘긴다. 없으면 넘기지 않는다. 이 함수는 `buildSystemParts`를 호출하지 않는다. 열린 뒤 `resume()`을 한 번 기다린다. 그래서 이전에 `running`으로 남은 작업이 있으면 반환 전에 이어진다.

`submit`은 루트 conversation의 `submit`이다. `resume`은 런타임의 `resume`이다. `close`는 런타임 `close()` 다음에 저장소 `close()`다.

### 모델

`complete`는 `Provider.stream`을 끝까지 읽는다. 청크를 호출자에게 다시 흘리지 않는다. 죽은 스트림의 바이트 위치는 저장하지 않는다. 다시 열면 듀러블 런타임이 같은 메시지를 처음부터 다시 보낸다.

요청을 이렇게 만든다.

- 듀러블 메시지 안의 `role: 'system'`은 순서대로 이어 하나의 `SystemPart`(`tier: 'stable'`)가 된다. system이 없으면 `system` 배열은 비운다.
- `user`는 텍스트 블록 하나의 user `Message`다.
- `assistant`는 텍스트 블록과, `toolCalls`마다 `tool_use` 블록이다. `input`은 그 호출의 `arguments`다.
- `tool`은 `toolUseId`가 `toolCallId`인 tool `Message`다. `ok`는 `isError`의 반대다. 블록은 텍스트 하나다.
- `tools`는 아래 여섯 툴의 `name`, `description`, `inputSchema`다.
- `maxTokens`는 `provider.profile(model).reserveOutputTokens`다. `profile`이 던지면 `complete`가 던지고, 듀러블 런타임이 `model_error`로 정산한다.

청크는 이렇게 모은다.

- `text_delta`는 순서대로 이어 content가 된다.
- `thinking_delta`와 `usage`는 버린다.
- `tool_call`의 `input`이 JSON 객체이면 툴 호출로 남긴다. 배열, null, 문자열, 빈 값이 아니면 `complete`가 `tool input was not a JSON object`로 던진다.
- 툴 호출이 하나라도 있으면 `stopReason`은 `'toolUse'`다. 없고 텍스트라도 있으면 `'stop'`이다.
- 청크가 하나도 없으면 `complete`가 `empty model response`로 던진다.
- `stream`이 던지면 그 에러가 `complete` 밖으로 나간다.

### 툴

기본 툴은 `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`다. 이름은 코어 툴 이름 그대로다. 호출자가 목록을 바꾸지 못한다. 이 문에는 `tools` 옵션이 없다.

`replay`는 `isReadOnly()`가 true면 `'safe'`, 아니면 `'unsafe'`다. 그래서 `Read`, `Glob`, `Grep`만 다시 실행된다. `Write`, `Edit`, `Bash`는 실행이 커밋되기 전에 끊기면 `interrupted` 한 줄이고, 핸들을 다시 부르지 않는다.

`execute`는 코어 툴을 이렇게 부른다.

1. `tool.parse(args)`. 실패하면 그 `message`로 throw한다. 듀러블 런타임이 `tool_error: `에 그 메시지를 붙인다.
2. `decidePermission`. 규칙은 빈 목록이다. 훅은 없다. `mode`는 이 세션의 `permissionMode`다.
3. 결과가 `allow`이면 `tool.execute`를 부른다. 반환값이 문자열이면 그 문자열이 content다. 문자열이 아니면 `String(value)`를 content로 쓴다. `isError`는 false다.
4. 결과가 `deny`이거나, 아직 `ask`이면 핸들을 부르지 않는다. content는 `permission_denied`이고 `isError`는 true다. 묻지 않고 기다리지 않는다.

`dontAsk`가 기본이므로 읽기 툴과 작업 트리 안의 `Write`/`Edit`은 `decidePermission`이 허용한다. `Bash`는 허용 규칙이 없어 거절되고, 결과는 `permission_denied`다. `acceptEdits`를 넘겨도 `Bash`는 승격되지 않는다. `Bash`를 실행하는 경로는 이 문에 없다.

툴 컨텍스트의 `turn.cwd`는 `opts.cwd`다. `turn.model`은 `opts.model`이다. `turn.permissionMode`는 세션 모드다. `signal`은 듀러블 실행 신호다. `onProgress`는 빈 함수다. `store`, `fileHistory`, `tasks`는 넘기지 않는다.

`readFiles`와 `readFileMtimes`는 그 런타임이 열려 있는 동안 하나다. `Read`가 `isError: false`로 끝나면 `markReadPath(turn, path)`를 부른다. `path`는 그 호출 arguments의 `path` 문자열이다. 파일을 다시 열 때는, 커밋된 엔트리에서 이름 `Read`인 툴 호출과 에러가 아닌 tool 결과를 짝지어 같은 `markReadPath`를 다시 부른다. mtime은 다시 연 시점의 파일 시각이다. 프로세스가 죽어 있는 동안의 변경은 stale로 보지 않는다. 그 다음 `Read`부터 다시 센다.

## 테스트하는 경계

워크트리에서 `bun test ./packages/sdk/src/durable.test.ts`. 라이브 모델 호출은 없다. 프로바이더와 툴은 가짜다. 경로는 임시 디렉터리의 sqlite이고 basename은 `state.db`가 아니다.

- basename `state.db`는 throw하고, 그 경로는 생기지 않는다.
- 가짜 프로바이더가 `Write` 툴 호출을 흘린 뒤, 툴 `execute`가 런타임을 `abandon()`한다. 같은 `path`로 `createDurableSession`을 다시 부르면 `Write` 실행 횟수는 1이고, 툴 본문은 `interrupted`다.
- `Read`는 `replay`가 safe라서 같은 방식으로 끊기면 다시 열었을 때 실행 횟수가 2다.
- `thinking_delta`는 `complete`에 넘기는 메시지에 남지 않는다. 텍스트 델타만 content가 된다.
- 툴 `input`이 문자열이면 `complete`가 `tool input was not a JSON object`로 던진다.
- 기본 모드에서 `Bash` 호출의 툴 본문은 `permission_denied`이고 `execute`는 부르지 않는다.
- `createRavenSession`의 시그니처와 `packages/core` 소스는 그대로다.

## 건드릴 파일

- 추가: `packages/sdk/src/durable.ts`, `packages/sdk/src/durable.test.ts`.
- 수정: `packages/sdk/src/index.ts`의 export. `packages/sdk/package.json`의 의존성.

`packages/durable`, `packages/cli`, `packages/core`, `scripts/ci-unit.sh`는 건드리지 않는다. SDK 테스트는 이미 `bun test packages/sdk`에 들어 있다.

## 검증

```bash
bun test ./packages/sdk/src/durable.test.ts
```

인자 없는 `bun test`와 `bash scripts/ci-unit.sh`는 돌리지 않는다.

## 결정

- 호스트는 SDK 함수 `createDurableSession` 하나다. `createRavenSession`은 그대로다.
- sqlite 경로는 호출자가 정하고, basename `state.db`는 거절한다.
- 스트림은 SDK 안에서 한 번의 `complete`로 모은다. 이어 받기 단위는 듀러블 phase다.
- 기본 툴은 `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`다. 읽기 전용만 `safe`다.
- 권한은 `decidePermission`에 맡기고, 남은 `ask`는 `permission_denied`다. 기본 모드는 `dontAsk`다.
- `Read`가 남긴 경로 기억은 프로세스가 다시 열릴 때 커밋된 Read 결과로 다시 만든다.
- CLI 연결, `Bash` 허용, 듀러블 패키지 계약 변경은 다음 문이다.
