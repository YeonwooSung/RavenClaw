# 듀러블 fork

Status: **draft**. 베이스 `4924308`. 듀러블 저장 스키마 버전 1 유지. 패키지 버전은 올리지 않는다. CHANGELOG는 쓰지 않는다.

Implementation plan: `docs/superpowers/plans/2026-10-25-durable-fork.md`

## 이 문서가 하는 일

한 대화의 엔트리를 어떤 엔트리까지 새 대화로 복사한다. 부모 엔트리, 태스크, 제출은 그대로다. 자식은 자기 `live`와 inbox로 `submit`한다.

이 문이 phase의 엔트리 읽기를 `task.conversationId`로 바꾼다. 루트 동작은 유지한다.

## 트리에서 확인한 사실

- 대화 행은 `{ id: number }`뿐이다. 루트 id는 1이고 `mintId()`는 2부터다.
- `prepare`, `request`, 툴 엔트리는 `ROOT_CONVERSATION_ID`만 읽고 쓴다.
- 문서 `agent`, `live`는 키 이름이 고정이다.
- 엔트리 id는 저장소 전역으로 증가한다.

## 비목표

- 문서 fork 정책 `asOf` / `current` / `initial`, Chord, 태스크 복사, 제출 복사.
- 세션 `state.db`의 `branchAt` / `/branch`. 그 트리는 이 패키지 밖이다.
- compaction, 훅, 중첩 툴, 서브에이전트, SDK, CLI.
- 버전 범프, CHANGELOG, pi 소스 복사.

## 동작

```ts
export type DurableConversationRow = {
  id: number
  parentConversationId?: number
  atEntryId?: number
  ownerTaskId?: number
}
```

`ownerTaskId`는 이 문에서 쓰지 않는다. 서브에이전트 문이 쓴다. 타입만 미리 둔다.

```ts
function liveKey(id: number): string {
  return id === 1 ? 'live' : `live:${id}`
}
function agentKey(id: number): string {
  return id === 1 ? 'agent' : `agent:${id}`
}
```

inbox 키는 모든 대화가 `inbox:<id>`다.

```ts
fork(atEntryId: number): Promise<DurableConversation>
```

`runtime.conversation(id)`는 그 id의 핸들이다. 대화 행이 없으면 `DurableFault`, 메시지 `unknown conversation <id>`.

`fork`:

- `atEntryId`가 이 대화의 엔트리가 아니면 `DurableFault`, 메시지 `entry is not on this conversation`. 쓰기 없음.
- 아니면 한 커밋이다.
  - 자식 id는 `mintId()`.
  - 행은 `{ id, parentConversationId: parent.id, atEntryId }`.
  - 부모 엔트리 중 `id <= atEntryId`를 id 오름차순으로 복사한다. 새 id는 `mintId()`. `kind`, `message`, `boundaryId`가 있으면 그것을 유지하고 `conversationId`만 자식이다.
  - 부모 agent 문서가 있으면 자식 agent 키로 복사한다.
  - 태스크, 제출, inbox, live는 복사하지 않는다.
- 부모 엔트리와 부모 live는 바뀌지 않는다. busy여도 fork는 된다.
- 자식을 다시 fork하면 자식 엔트리만 복사한다.

generation과 tool phase는 `task.conversationId`의 엔트리와 그 대화의 live/agent 키를 쓴다. 루트의 키 이름은 계속 `agent`, `live`다.

자식 `submit`은 자식 live가 비어 있으므로 부모 run과 겹쳐도 `DurableBusy`가 아니다.

## 테스트

`packages/durable/src/runtime/turn.test.ts`와 저장 타입이 필요하면 `packages/durable/src/storage/types.ts`의 테스트를 깨지 않는 선에서 고친다.

- 엔트리 a, b, c가 있을 때 `fork(b.id)`의 자식 엔트리 본문은 a, b다. c는 자식에 없다. 부모에는 a, b, c가 있다.
- 자식 id는 1이 아니다. `parentConversationId`는 1이고 `atEntryId`는 b.id다.
- 없는 엔트리로 fork하면 `entry is not on this conversation`이고 대화 행은 그대로다.
- `conversation(404)`는 `unknown conversation 404`다.
- 부모 `submit`이 끝나기 전 fork한 자식에 `submit`하면 둘 다 `done`이 된다. 부모 답과 자식 답은 각자 자기 사용자 메시지에 대한 것이다.
- 자식 agent 문서의 `modelId`는 부모와 같다.
- 자식을 한 번 더 fork하면 그 손자는 자식이 가진 엔트리만 가진다.

기존 루트 테스트는 `live`와 `agent` 키를 그대로 본다.

## 이 문이 하지 않는 일

fork는 파일을 되돌리지 않고, git을 되돌리지 않고, 부모 태스크를 멈추지 않는다. 복사 이후의 부모 엔트리는 자식에 나타나지 않는다.
