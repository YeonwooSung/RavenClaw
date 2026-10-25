# 컴팩트는 현재 잎 경로만 접는다

Status: **implemented**. 베이스 `25f5af7`. 스키마 v12. 패키지 버전은 올리지 않는다. CHANGELOG는 쓰지 않는다. Shipped sha: `1c22f0c` on `main`.

Implementation plan: [2026-10-24-session-compact-path.md](../plans/2026-10-24-session-compact-path.md)

앞 문서 [`2026-10-23-session-branch.md`](2026-10-23-session-branch.md)는 공유 앞부분을 `active = 0`으로 끄면 다른 가지에서도 그 앞부분이 사라진다고 적고, 그 한계를 테스트로 고정했다. 이 문서는 자동 컴팩트와 `/compact`만 그 한계에서 뺀다. `/rewind`와 `/clear`는 그대로 id를 모든 경로에서 끈다.

## 이 문서가 하는 일

현재 잎 경로를 컴팩트하면 요약 사용자 메시지를 테이블에 넣고, 보호된 꼬리의 첫 줄만 그 요약의 자식으로 다시 잇는다. 접힌 앞부분은 `active = 1`로 남는다. 다른 잎이 그 앞부분을 조상으로 두면, 그 잎의 로드에는 앞부분이 그대로 있다. 현재 잎의 로드에는 요약과 꼬리만 있다.

꼬리의 첫 줄이 다른 활성 가지의 조상이면 부모를 바꾸지 않고 거절한다. 꼬리를 복제하지 않는다.

## 트리에서 확인한 사실

- `runAutocompact`는 보호 꼬리를 뺀 앞부분 id로 `recordCompact`를 부른다. `recordCompact`는 그 id를 `active = 0`으로 만들고, 잎이 꺼졌으면 활성 조상으로 옮기고, `compact_boundaries`에 요약을 넣고, `compact_generation`을 올린다. 요약 사용자는 반환 배열에만 있고 테이블에는 없다.
- `buildPostCompactMessages`는 꼬리가 사용자로 시작하면 assistant 스텁 `(conversation summary follows)` 다음에 요약 사용자를 둔다. 그 외에는 요약 사용자 다음에 꼬리다. 꼬리가 없으면 요약 사용자만이다. 스텁과 요약의 id는 `crypto.randomUUID()`다.
- `loadMessages`는 잎에서 활성 부모만 걷는다. `active = 0`인 조상은 어떤 잎에서도 빠진다. `parent_id`가 `NULL`이면 그 줄이 뿌리이고 걸음이 끝난다.
- 새 줄의 `parent_id`는 삽입 당시의 잎이다. 기존 줄의 `parent_id`를 바꾸는 쓰기는 없다.
- `upsertSession`은 `leaf_id` 컬럼을 대입하지 않는다. `compactNow`는 `runAutocompact` 뒤에 세션 행을 upsert 한다.
- `branch-store-tests.ts`의 `inactivating a shared prefix hides it from the other branch`는 `recordCompact`로 `a`를 끈 뒤, 다른 끝 `c`의 로드가 `a`를 빼는 것을 기대한다.
- `/rewind`와 `/clear`도 `recordCompact`로 id를 끈다. rewind의 두 번째 호출은 `compact_boundaries`의 `(session_id, generation)` 기본 키 때문에 실패할 수 있다.
- `/compact`는 `compactNow()` 뒤에 notice `compact requested`를 낸다. 자를 앞부분이 없어도 그 문자열이다.
- 스키마는 12다. `compact_boundaries`에는 `message_id` 컬럼이 없다.

## 비목표

- `/rewind`, `/clear`, `recordCompact`, `recordCompactAndUpsertSession`이 id를 `active = 0`으로 끄는 동작. 그 테스트는 유지한다.
- 꼬리를 새 id로 복제하는 일. 공유된 꼬리 첫 줄은 거절한다.
- `microcompact`. 파일 이력, git, todo, `compactGeneration`을 가지마다 나누는 일.
- 스키마 마이그레이션. `Message`에 `parentId`를 넣는 일. `queryLoop`, `assembleRequest`, `decidePermission`.
- 듀러블 fork. HTTP 컴팩트. 패키지 버전. CHANGELOG. `ARCHITECTURE.md`의 구현 목록에 이 draft를 넣는 일.

## 동작

### 스토어

`SessionStore`에 메서드를 더한다. `recordCompact`는 바꾸지 않는다.

```ts
spliceCompactPath(sessionId: string, opts: {
  generation: number
  summaryText: string
  inserted: Message[]
  boundaryId: string | null
}): Promise<void>
```

한 트랜잭션이다. 실패하면 부모, 잎, 세대, 경계 행이 그대로다.

세션이 없으면 `session not found: <id>`다.

`inserted`는 1개 또는 2개다. 1개면 역할이 `user`다. 2개면 첫 줄이 `assistant`, 둘째가 `user`다. 그 외는 `PersistError` `unknown`, 메시지 `invalid compact splice`다. 이미 있는 id면 `duplicate message id <id>`다.

저장 경로는 지금의 잎 걸음이다. `boundaryId`가 있고 그 id가 이 경로에 없으면 `compact boundary is not on this path`다. 잎은 그대로다.

`boundaryId`가 경로에 있을 때, 경로 밖에 있는 활성 줄의 부모 걸음이 그 id를 지나면 `compact would move another branch`다. 아무 줄도 넣지 않고 부모도 바꾸지 않는다.

통과하면 `inserted`를 배열 순서로 넣는다. 첫 줄의 `parent_id`는 `NULL`이다. 둘째가 있으면 그 `parent_id`는 첫 줄 id다. 이 삽입은 잎을 현재 잎으로 두지 않는다. 새 줄은 `active = 1`이고 FTS에 올라간다.

`boundaryId`가 있으면 그 줄의 `parent_id`만 마지막 `inserted` id로 바꾼다. `active`와 잎은 그대로다. `boundaryId`가 `NULL`이면 잎을 마지막 `inserted` id로 둔다.

그 다음 `compact_boundaries`에 `summaryText`를 넣고 `compact_generation`을 `opts.generation`으로 올린다. 기본 키가 겹치면 트랜잭션이 롤백된다. 앞부분 id는 끄지 않고 FTS에서도 빼지 않는다.

### `runAutocompact`

요약과 스텁은 지금처럼 `buildPostCompactMessages`가 만든다. 그 배열에서 꼬리에 없던 id가 `inserted`다. 꼬리가 있으면 `boundaryId`는 꼬리 첫 id다. 없으면 `NULL`이다.

`recordCompact`를 부르지 않는다. `spliceCompactPath`를 부른다. 반환 `messages`는 그 스텁, 요약, 꼬리다. `inactivatedIds`는 빈 배열이다. `generation`은 넘긴 세대에 1을 더한 값이고, 그 값을 `opts.generation`으로 스토어에 넘긴다.

스토어가 거절하면 예외가 그대로 올라간다. 메모리 배열은 호출자가 바꾸기 전에 실패한다.

앞부분이 없는 호출은 지금처럼 스토어를 부르지 않는다. 그 판단은 `compactNow`와 `phases.ts`에 이미 있다.

### 로드와 `/branch`

현재 잎의 `loadMessages`는 요약 또는 스텁에서 끊긴다. 요약의 부모가 `NULL`이므로 접힌 앞부분은 이 경로에 없다. 다른 잎이 그 앞부분을 조상으로 두면 그 로드에는 앞부분이 있다.

선형 세션에서는 접힌 앞부분의 끝이 더 이상 자식을 갖지 않으면 `/branch`의 `other`에 그 끝이 나온다. 그 번호로 `branchAt`을 하면 접기 전 경로가 돌아온다. 다른 가지가 그 앞부분을 이미 쓰고 있으면 그 가지의 끝이 `other`에 나온다.

### 슬래시

`/compact`는 그대로 `compactNow()`를 부른다. 예외 메시지가 `compact would move another branch` 또는 `compact boundary is not on this path`이면 그 문자열을 notice로 내고 `handled`다. 그 외 예외는 지금처럼 올라간다. 성공 notice는 그대로 `compact requested`다.

`phases.ts`의 컴팩트 `catch`는 그대로다. 거절은 연속 실패로 센다. 턴 메시지는 바뀌지 않는다.

## 테스트하는 경계

- `recordCompact`로 공유 앞부분을 끄면 다른 끝의 로드에서 그 앞부분이 빠진다. 기존 테스트는 유지한다.
- `a-b-c`에서 `a`로 가지를 만들고 `d`를 넣은 뒤, 현재 경로 `a,d`를 요약 하나로 접으면 현재 로드는 그 요약 id뿐이다. `branchAt(c)`는 `a,b,c`다. `a`는 `active = 1`이다.
- 가지가 없는 `u0,a0,u1,a1`을 꼬리 2개로 접으면 로드는 요약 사용자, `u1`, `a1`이다. `u0`와 `a0`는 활성으로 남고 현재 로드에는 없다.
- 꼬리가 사용자로 시작하면 로드는 스텁 assistant, 요약 사용자, 꼬리다. 스텁 본문은 `(conversation summary follows)`다.
- 꼬리 첫 줄이 다른 활성 가지의 조상이면 `spliceCompactPath`는 `compact would move another branch`를 던지고, 부모와 잎과 세대가 그대로다.
- 경로에 없는 `boundaryId`는 `compact boundary is not on this path`다.
- 같은 세대의 두 번째 splice는 롤백된다.
- `/compact`가 그 두 거절 문자열을 notice로 낸다. 성공은 `compact requested`다.
- 메모리 스토어와 sqlite 스토어가 같은 경계를 통과한다.

## 건드릴 파일

- 수정: `packages/core/src/types.ts`의 `SessionStore`. `packages/core/src/types.test.ts`의 `satisfies SessionStore` 객체.
- 수정: `packages/core/src/session/sqlite-store.ts`, `packages/core/src/session/memory-store.ts`, `packages/core/src/session/branch-store-tests.ts`.
- 수정: `packages/core/src/compact/prune.ts`의 `runAutocompact`. `packages/core/src/compact/prune.test.ts`에서 `recordCompact`로 앞부분을 끈다고 기대하는 부분.
- 수정: `packages/cli/src/slash/dispatch.ts`의 `compact` 분기. `packages/cli/src/slash/dispatch.test.ts`.

`packages/core/src/session/rewind.ts`, `packages/core/src/loop/query-loop.ts`, `packages/core/src/loop/phases.ts`의 제어 흐름, 스키마 SQL, `packages/durable`, `packages/sdk`, CHANGELOG, `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`는 수정하지 않는다. `phases.ts`는 이미 `runAutocompact`의 예외를 잡는다.

## 검증

```bash
bun test ./packages/core/src/compact/prune.test.ts ./packages/core/src/session/sqlite-store.test.ts ./packages/core/src/session/memory-store.test.ts ./packages/core/src/session/rewind.test.ts ./packages/core/src/loop/session-engine.test.ts ./packages/core/src/types.test.ts ./packages/cli/src/slash/dispatch.test.ts
```

인자 없는 `bun test`와 `bash scripts/ci-unit.sh`는 돌리지 않는다.

## 결정

- 자동 컴팩트는 앞부분을 끄지 않는다. 요약을 새 뿌리로 넣고 꼬리의 첫 줄만 그 요약에 다시 잇는다.
- 다른 가지가 그 앞부분을 조상으로 두면 그 경로는 앞부분을 유지한다.
- 꼬리의 첫 줄이 다른 가지의 조상이면 거절한다. 복제하지 않는다.
- `/rewind`와 `/clear`는 모든 경로에서 id를 끈다.
- 스키마는 12다. 요약이 컴팩트 경계인 것은 그 줄의 부모가 `NULL`이라는 점으로 나타낸다.
