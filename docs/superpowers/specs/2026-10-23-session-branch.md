# 기본 세션은 메시지 부모와 잎으로 가지를 남긴다

Status: **draft**. 베이스 `fdf0f79`. 스키마 v12. 패키지 버전은 올리지 않는다. CHANGELOG는 쓰지 않는다. 워크트리 `docs/session-branch`. Shipped sha는 없다.

## 이 문서가 하는 일

`~/.ravenclaw/state.db`의 한 세션 안에서, 과거 메시지를 현재 잎으로 두고 다음 기록을 그 자식으로 남긴다. 잎에서 갈라진 옛 줄은 `active = 1`로 남고, 잎을 그 끝으로 다시 옮기면 그 경로가 돌아온다. 모델에 들어가는 배열은 그 잎에서 뿌리까지 한 길이다. `queryLoop`는 그대로 그 배열을 받는다.

이 문에는 턴을 고르는 UI가 없다. 호출은 `SessionEngine.branchAt(messageId)`다.

## 트리에서 확인한 사실

- 스키마는 11이다. `messages`에는 `id`가 있고 `parent_id`는 없다. `parent_session_id`는 `sessions`에만 있고 자식 세션을 가리킨다. `sessions`에는 잎 컬럼이 없다.
- `loadMessages`와 `loadSession`은 `active = 1`을 `created_at` 순으로 읽는다. 잎에서 부모를 타지 않는다. `loadMessages`는 고아 `tool_use`를 고치거나 저장하지 않는다. `loadSession`은 그 다음에 `repairRoleAlternation`을 돌리고, 합성한 툴 줄을 `persistToolResults`로 쓸 수 있다.
- `Message` 유니온에는 부모 필드가 없다. 엔진은 이 배열을 메모리에 두고 `submitMessage`가 뒤에 붙인다. `assembleRequest`는 `state.turn.messages`를 그대로 프로바이더 요청에 넣는다.
- 새 줄은 `persistUser`, `persistAssistant`, `persistToolCalls`, `persistToolResults`가 넣는다. 같은 assistant id를 다시 쓰면 `UPDATE`다. 툴 줄의 `ON CONFLICT`는 기존 줄을 갱신하고 `active = 1`로 되돌린다.
- `upsertSession`은 세션 행의 나열된 컬럼을 덮어쓴다. `updateSessionTodos`는 `todos_json`과 `updated_at`만 고친다.
- `/rewind`는 메모리 배열에서 마지막 사용자 메시지부터 끝을 잘라 `recordCompact`로 `active = 0`을 만든다. 그 다음 파일 이력을 취소한다. 잡 세션은 그 기록 뒤에 `git reset --hard`를 한다. 살아있는 턴, 실행 중인 Agent 태스크, 짝이 없는 pending ask는 거절한다. 같은 `compact_generation`의 두 번째 rewind는 `compact_boundaries` 기본 키 때문에 `rewind persist failed`다.
- 컴팩트는 메모리에 있는 앞부분을 `recordCompact`로 끄고, 요약이 붙은 새 배열은 메모리에만 둔다. 다시 열면 아직 활성인 꼬리만 보인다. 요약 사용자는 그때 테이블에 없다.
- `/clear`(`clearKeepId`)는 `loadMessages`가 돌려준 id를 모두 끄고 세션 id는 남긴다.
- `active = 0`은 모든 로드에서 빠진다. 경로마다 다른 가시성이 아니다.
- `@ravenclaw/durable`의 엔트리는 숫자 id 순이다. 부모 포인터가 없고, fork는 `2026-10-22-durable-harness.md`의 v1 비목표다.

## 비목표

- 과거 턴을 고르는 TUI, 슬래시, HTTP 경로. `/tree`, `/branch`를 도움말에 넣는 일.
- `/rewind`의 파일 이력 취소, 잡의 `git reset`, todo 스냅샷 복원, `compact_generation` 증가 규칙을 가지에 붙이는 일.
- 컴팩트를 경로 전용으로 바꾸는 일. 컴팩션 노드를 추가하는 일. 요약 사용자를 다시 열 때 테이블에 심는 일.
- 가지로 옮길 때 todo, 체크포인트, 워크트리를 그 시점의 파일 상태로 되돌리는 일.
- `Message`에 `parentId`를 넣는 일. JSONL 세션 파일. 듀러블 패키지, SDK 호스트, `raven durable`.
- `queryLoop`, `assembleRequest`, `decidePermission`, 권한 모드.
- 검색(FTS)을 현재 잎 경로로 좁히는 일. 다른 가지의 활성 줄은 지금처럼 색인에 남는다.
- 켜기 플래그. 패키지 버전. CHANGELOG. `ARCHITECTURE.md`의 구현 목록에 이 draft를 넣는 일.

## 동작

### 스키마 12

`packages/core/src/migrations/012_message_parent.sql`을 `schema.ts`의 마이그레이션 12로 넣는다. 컬럼은 다음 둘이고, 외래 키는 달지 않는다.

- `messages.parent_id TEXT`
- `sessions.leaf_id TEXT`

기존 데이터베이스에서는 세션마다 `active = 1`인 줄을 `created_at`, `rowid` 순으로 잇는다. 첫 줄의 `parent_id`는 `NULL`이다. 다음 줄의 `parent_id`는 바로 앞 줄의 id다. `leaf_id`는 그 마지막 줄이다. 활성 줄이 없으면 `leaf_id`는 `NULL`이다. `active = 0`인 줄의 `parent_id`는 `NULL`로 둔다. 그 줄은 가지로 복원되지 않는다.

새 데이터베이스도 마이그레이션 12를 지나 `schema_version`이 12다. 빈 세션의 `leaf_id`는 `NULL`이다.

### 부모와 잎을 누가 쓰는가

`leaf_id`를 쓰는 곳은 마이그레이션, 새 메시지 삽입, `branchAt`, 그리고 `active = 0`으로 바꾸는 트랜잭션 안의 잎 수리뿐이다.

`createSession`은 `leaf_id`를 `NULL`로 둔다. `SessionRecord.leafId`가 있어도 읽지 않는다. `upsertSession`, `recordCompactAndUpsertSession`, `clearConversation`의 세션 `UPDATE`는 `leaf_id` 컬럼을 대입하지 않는다. `updateSessionTodos`도 그대로다.

`SessionRecord`에 `leafId?: string`을 둔다. `loadSession`이 세션 행에서 채운다. 엔진이 메모리에 들고 있는 복사본은 이 문에서 경로를 고르는 데 쓰지 않는다. 저장 컬럼이 기준이다.

`Message` 유니온은 바꾸지 않는다.

### 새 줄

새 줄을 넣는 트랜잭션은 그때의 `leaf_id`를 그 줄의 `parent_id`로 쓰고, `leaf_id`를 그 줄의 id로 바꾼다. 잎이 `NULL`이면 부모도 `NULL`이다.

`persistToolResults`에 새 id가 여럿이면 인자 순서대로 잇는다. 각각이 앞 줄의 자식이고, 잎은 마지막 id다. 하나라도 실패하면 부모와 잎의 변경은 남기지 않는다.

이미 있는 assistant id의 `UPDATE`, 이미 있는 툴 id의 `ON CONFLICT`는 `parent_id`와 `leaf_id`를 바꾸지 않는다.

`loadSession`의 `repairRoleAlternation`은 지금처럼 걸어서 만든 배열 위의 투영이다. 고친 순서로 부모를 다시 쓰지 않는다. 합성 툴 줄은 새 id이므로 위 삽입 규칙을 따른다.

### 로드

`loadMessages`와 `loadSession`이 읽는 활성 목록은 `created_at` 전체가 아니다. `leaf_id`에서 `parent_id`를 타고 뿌리까지 간 뒤 뒤집는다. 노드는 `active = 1`일 때만 경로에 넣는다. 부모가 없거나, 행이 없거나, `active = 0`이면 그 앞에서 멈춘다. 비활성 부모는 넣지 않는다.

`leaf_id`가 `NULL`이면 빈 배열이다. 잎 id에 행이 없으면 `PersistError` `unknown`, 메시지 `leaf not found: <id>`다. 잎이 비활성이면 쓰지 않고, 활성 조상까지 올라간 경로를 돌려준다. 활성 조상이 없으면 빈 배열이다. 같은 id가 다시 나오면 `PersistError` `unknown`, 메시지 `message cycle`이다.

가지를 만들기 전의 세션에서 이 경로는 마이그레이션이 만든 순서와 같다. 그 순서는 활성 줄의 `created_at`, `rowid` 순이다.

이 배열이 엔진 메모리와 다음 턴의 `turn.messages`가 된다. `assembleRequest`는 고치지 않는다.

`loadMessages`를 쓰는 기존 호출은 이 경로를 본다. 온보딩의 슬래시 횟수도 현재 잎 경로만 센다. pending ask가 짝인지 확인할 때도 이 경로와 엔진 메모리만 본다. 다른 가지의 툴 결과는 짝으로 세지 않는다. 잡 PR의 마지막 assistant도 이 경로의 마지막 assistant다.

### 잎 수리

`recordCompact`와 `clearConversation`이 id를 `active = 0`으로 만드는 그 트랜잭션에서, 잎이 비활성이면 부모를 비활성 줄까지 포함해 타고 가장 가까운 활성 조상으로 `leaf_id`를 옮긴다. 활성 조상이 없으면 `NULL`이다. 잎이 아직 활성이면 그대로 둔다.

그래서 선형 세션의 rewind와 컴팩트 뒤에 다시 열면, 지금처럼 남은 활성 꼬리만 보인다.

### `branchAt`

스토어 메서드다.

```ts
branchAt(sessionId: string, messageId: string): Promise<Message[]>
```

세션이 없으면 지금의 `session not found: <id>`다. 그 메시지가 그 세션의 `active = 1` 줄이 아니면 `PersistError` `unknown`, 메시지 `message is not on this session`이다. 실패하면 `leaf_id`를 바꾸지 않는다.

성공하면 `leaf_id`만 그 id로 바꾼다. 어떤 줄의 `active`와 `parent_id`도 바꾸지 않는다. 반환값은 그 잎의 로드 경로다. 이미 그 잎이면 같은 경로를 돌려주고 성공이다.

엔진 메서드다.

```ts
branchAt(messageId: string): Promise<
  | { ok: true; messages: Message[] }
  | { ok: false; notice: string }
>
```

순서는 이렇다.

1. `rewindLast`와 같이 `maybeFinishRewindReset`을 먼저 기다린다. `ran`이면 잎을 옮기지 않고, rewind가 그때 돌려주는 것과 같은 `ok`와 notice로 끝낸다.
2. `whenTreeStop`을 기다린다. 메시지 부모는 여기서 바꾸지 않는다.
3. 이 세션의 짝 없는 pending ask가 있으면 `{ ok: false, notice: 'pending permission ask' }`다. ask를 지우지 않는다.
4. `liveTurn`이 있거나, 실행 중인 Agent 태스크가 있으면 `{ ok: false, notice: 'a turn is in progress' }`다.
5. 스토어 `branchAt`을 부른다. `message is not on this session`이면 그 문자열을 notice로 돌려준다. 그 밖의 예외는 `{ ok: false, notice: 'branch persist failed' }`다. 엔진의 `messages`는 그대로다.
6. 성공하면 엔진의 `messages`를 반환 경로로 바꾼다. 파일 이력, git, todo, `compactGeneration`, 권한 모드는 건드리지 않는다.

다음 `persistUser`는 그 잎의 자식이다. 옛 끝은 `active = 1`로 남아 있고, 그 id로 다시 `branchAt`을 하면 그 경로가 돌아온다.

### 지우기와 컴팩트의 한계

`clearKeepId`는 잎 경로만이 아니라 그 세션의 `active = 1` id를 모두 `clearConversation`에 넘긴다. 이를 위해 스토어에 `listActiveMessageIds(sessionId): Promise<string[]>`를 둔다. 순서는 상관없다. 저장하지 않는다. 세션이 없으면 `session not found: <id>`다. 전부 꺼지면 잎 수리가 `leaf_id`를 `NULL`로 둔다. 다른 가지도 활성으로 남지 않는다.

`clearConversation` 자체는 넘겨받은 id만 끈다. 부분 id로 부르는 기존 동작은 그대로다.

컴팩트와 rewind는 지금처럼 넘겨받은 id만 끈다. `active = 0`은 그 줄을 지나는 모든 경로에서 빠지게 한다. 두 가지가 앞부분을 공유할 때 한쪽 컴팩트나 rewind가 그 앞부분을 끄면, 다른 가지를 다시 열어도 그 앞부분은 없다. 이 문은 그 한계를 고치지 않는다. 테스트가 그 결과를 고정한다.

## 테스트하는 경계

워크트리에서 아래 명령만 돌린다. 라이브 모델은 없다.

- 스키마 11로 만든 데이터베이스에 활성 세 줄과 비활성 한 줄이 있으면, 마이그레이션 뒤 `schema_version`은 12다. 활성 줄의 부모는 `created_at`, `rowid` 순의 이전 줄이다. 잎은 마지막 활성 줄이다. 비활성 줄의 `parent_id`는 `NULL`이다.
- 새 데이터베이스의 `schema_version`은 12다. 지금 11을 기대하는 스키마 테스트와 `sqlite-store`의 fresh install 테스트는 12를 기대한다.
- 한 세션에 사용자 줄을 세 번 넣으면 `loadMessages`는 그 순서를 돌려주고, 잎은 세 번째다. 두 번째의 부모는 첫 번째다.
- 그 세션에서 `branchAt(첫 줄)` 뒤에 새 사용자 줄을 넣으면 로드는 첫 줄과 새 줄이다. 둘째와 셋째는 `active = 1`로 남는다. `branchAt(셋째)`의 로드는 다시 첫·둘·셋째다.
- 비활성 id, 다른 세션의 id는 `message is not on this session`이고 잎은 그대로다.
- `upsertSession`은 `leaf_id`를 바꾸지 않는다.
- 툴 결과 두 개를 한 번에 넣으면 부모는 호출 당시의 잎, 그 다음 첫 툴 줄이다. 잎은 둘째 툴 줄이다.
- 같은 assistant id를 다시 써도 부모와 잎은 그대로다.
- 꼬리를 `recordCompact`로 끄면 잎은 남은 활성 조상이고, 로드에는 꺼진 id가 없다.
- 가지를 만든 뒤 현재 경로의 공유 앞부분을 컴팩트로 끄면, 다른 끝을 잎으로 삼아도 그 앞부분은 로드에 없다.
- `clearKeepId`는 다른 가지의 활성 줄까지 끄고, 잎은 `NULL`이며, 로드는 빈 배열이다.
- 엔진 `branchAt`은 살아있는 턴에서 `a turn is in progress`이고 메모리 배열과 잎을 그대로 둔다. 짝 없는 pending ask에서는 `pending permission ask`다.
- 엔진 `branchAt`이 성공하면 메모리 배열이 그 경로다. 파일 이력과 git은 호출되지 않는다.
- 메모리 스토어와 sqlite 스토어가 같은 스토어 경계를 통과한다.
- 기존 rewind 테스트는 통과한다. rewind는 `branchAt`을 부르지 않는다.

## 건드릴 파일

- 추가: `packages/core/src/migrations/012_message_parent.sql`.
- 수정: `packages/core/src/session/schema.ts`, `packages/core/src/session/schema.test.ts`.
- 수정: `packages/core/src/types.ts`의 `SessionRecord`, `SessionStore`.
- 수정: `packages/core/src/types.test.ts`에서 `satisfies SessionStore`인 객체에 새 메서드를 더한다.
- 수정: `packages/core/src/session/sqlite-store.ts`, `packages/core/src/session/sqlite-store.test.ts`.
- 수정: `packages/core/src/session/memory-store.ts`, `packages/core/src/session/memory-store.test.ts`.
- 수정: `packages/core/src/loop/session-engine.ts`의 `branchAt`과 `clearKeepId`가 id를 모으는 부분. `packages/core/src/loop/session-engine.test.ts`.

`packages/core/src/loop/phases.ts`, `packages/core/src/loop/query-loop.ts`, `packages/core/src/session/rewind.ts`, `packages/durable`, `packages/sdk`, `packages/cli`의 슬래시와 도움말, CHANGELOG, `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`는 수정하지 않는다.

## 검증

```bash
bun test ./packages/core/src/session/schema.test.ts ./packages/core/src/session/sqlite-store.test.ts ./packages/core/src/session/memory-store.test.ts ./packages/core/src/loop/session-engine.test.ts ./packages/core/src/session/rewind.test.ts ./packages/core/src/compact/prune.test.ts ./packages/core/src/types.test.ts
```

인자 없는 `bun test`와 `bash scripts/ci-unit.sh`는 돌리지 않는다.

## 결정

- 가지는 기본 세션의 `parent_id`와 `leaf_id`다. JSONL로 저장소를 바꾸지 않는다.
- 분기는 잎만 옮긴다. 옛 줄을 끄지 않는다. 다음 삽입이 그 잎의 자식이다.
- 모델 문맥은 잎 경로 하나다. `queryLoop`는 두 번째 루프가 되지 않는다.
- 잎은 컬럼에 남는다. 세션 upsert는 그 컬럼을 덮지 않는다.
- `branchAt`의 대상은 그 메시지 자신이다. 사용자 메시지의 부모로 한 칸 물러서는 동작은 턴 선택 UI 문에 둔다.
- `/rewind`와 컴팩트는 id를 끄는 지금 동작으로 남는다. 공유 앞부분을 끄면 다른 가지에서도 그 앞부분이 사라진다.
- 가지로 옮겨도 파일, git, todo는 그대로다.
- `/clear`는 세션의 활성 줄을 모두 끈다.
- 듀러블 fork와 턴 선택 UI는 이 문서 밖에 있다.
