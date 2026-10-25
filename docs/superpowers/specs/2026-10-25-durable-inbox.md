# 듀러블 inbox

Status: **draft**. 베이스 `4924308`. 듀러블 저장 스키마 버전 1 유지. 패키지 버전은 올리지 않는다. CHANGELOG는 쓰지 않는다.

Implementation plan: `docs/superpowers/plans/2026-10-25-durable-inbox.md`

## 이 문서가 하는 일

대화가 바쁠 때 `submit`이 항상 `DurableBusy`이던 것을, `whenBusy: 'followUp'`일 때만 inbox에 넣고 현재 run이 `done`으로 끝난 뒤 하나씩 깨운다.

sleep 문의 루프 위다. sleep 규칙을 바꾸지 않는다. steer 배치는 다음 문이다.

## 트리에서 확인한 사실

- `submit`은 `live.run`이 있으면 쓰기 전에 `DurableBusy`를 던진다.
- 같은 conversation의 같은 `requestId`는 기존 제출을 반환하고 사용자 엔트리를 추가하지 않는다.
- run이 끝나면 assistant 엔트리, 제출 `done`, `live`를 `{}`로 지우는 일이 한 커밋이다.
- 문서 키 `agent`, `live`는 루트(id 1) 전역이다.

## 비목표

- `whenBusy: 'steer'`의 postTools 배치. 이 문은 steer 항목을 놓아 두지 않는다.
- 실패한 run이 inbox를 비우거나 다음 항목을 깨우는 일.
- fork, compaction, 훅, 중첩 툴, 서브에이전트, 스트림 partial, SDK, CLI.
- 버전 범프, CHANGELOG, pi 소스 복사.

## 동작

`submit` 입력에 `whenBusy?: 'reject' | 'followUp' | 'steer'`를 더한다. 생략은 `reject`다.

inbox 문서 키는 `inbox:<conversationId>`이다. 값은 `{ items: InboxItem[] }`이다.

```ts
export type InboxItem = {
  id: number
  mode: 'steer' | 'followUp'
  content: string
  requestId?: string
}
```

항목 `id`는 그 항목의 submission id다. 없는 문서는 빈 목록이다.

대화가 idle이고 inbox가 비어 있으면 `whenBusy`와 상관없이 오늘의 submit이다. 항목을 inbox에 남기지 않는다.

대화가 busy이거나 inbox가 비어 있지 않으면:

| whenBusy | 쓰기 |
|---|---|
| 생략 또는 `reject` | 없음. `DurableBusy`. |
| `followUp` | inbox에 항목 하나, status `queued`인 제출. generation과 `live.run`은 만들지 않는다. |
| `steer` | 이 문에서는 followUp과 같은 큐잉만 한다. 배치는 steer 문이 한다. 타입은 지금 받는다. |

같은 `requestId`는 기존 제출을 반환하고 항목을 더하지 않는다.

run이 `done`으로 끝나는 커밋:

- inbox의 첫 `followUp` 항목을 하나 놓는다. 사용자 엔트리, 그 제출의 `entryId` (status는 `queued`), 새 generation, `live.run`은 그 제출을 가리킨다. 그 항목만 제거한다.
- `followUp`이 없고 `steer`만 있으면 `live.run`을 지우고 inbox는 그대로 둔다.
- `followUp`이 없으면 `live`를 `{}`로 둔다.

run이 `unanswered`로 끝나면 inbox를 놓지도 지지도 않는다. 현재 제출만 오늘의 unanswered가 된다.

idle인데 inbox가 비어 있지 않은 `followUp` submit은 새 항목을 추가한 뒤, `live.run`이 없으면 목록의 첫 `followUp`(새 항목이 아닐 수 있다)을 위와 같이 놓는다.

## 테스트

`packages/durable/src/runtime/turn.test.ts`.

- busy일 때 `whenBusy`를 생략하면 `DurableBusy`이고 엔트리는 늘지 않는다.
- busy일 때 `followUp`은 `DurableBusy`가 아니고, `wait`는 첫 run이 끝난 뒤에야 `done`이다. 첫 답 텍스트와 둘째 답 텍스트는 다르다.
- 큐에 두 개의 followUp이 있으면 run이 끝날 때마다 하나다. 모델 사용자 메시지는 그 항목의 content다.
- 같은 `requestId`의 둘째 `followUp`은 제출 id가 같고 inbox 항목은 하나다.
- unanswered(모델 에러) 뒤 inbox의 followUp은 그대로다. 그 제출은 아직 `queued`다.
- `reject`이면서 inbox가 비어 있지 않으면 `DurableBusy`이고 새 항목이 없다.

## 이 문이 하지 않는 일

`steer`를 postTools에서 현재 run에 끼우지 않는다. 한 번에 항목을 모두 깨우지 않는다. 디스플레이 전용 write 제출은 없다.
