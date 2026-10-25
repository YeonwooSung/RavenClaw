# 듀러블 steer

Status: **draft**. 베이스 `4924308`. 듀러블 저장 스키마 버전 1 유지. 패키지 버전은 올리지 않는다. CHANGELOG는 쓰지 않는다.

Implementation plan: `docs/superpowers/plans/2026-10-25-durable-steer.md`

## 이 문서가 하는 일

`whenBusy: 'steer'`로 넣은 사용자 메시지를, 툴 라운드가 끝난 뒤 같은 run의 다음 모델 호출에 한 개 끼운다. 모델이 툴 없이 멈추면 그 steer는 다음 run의 입력이 된다.

inbox 문의 큐를 쓴다. `reject`와 `followUp` 배치는 바꾸지 않는다.

## 트리에서 확인한 사실

- 툴 라운드가 끝나면 generation follow-up이 `projectMessages`로 모델을 다시 부른다.
- 모델이 `stop`이면 그 텍스트로 제출이 `done`이 되고 `live`가 비워진다.
- inbox 항목은 `{ id, mode, content, requestId? }`이고 문서는 `inbox:<conversationId>`다.

## 비목표

- `all` 모드, steeringMode 설정 필드.
- steer가 자기만의 답 텍스트를 갖는 일. postTools에 합류한 steer는 현재 run의 답을 같이 받는다.
- 실패한 run이 steer를 배치하는 일.
- fork, compaction, 훅, 중첩 툴, 서브에이전트, SDK, CLI.
- 버전 범프, CHANGELOG, pi 소스 복사.

## 동작

idle이고 inbox가 비어 있으면 `steer`도 오늘의 즉시 submit이다.

busy이거나 inbox가 비어 있지 않으면 `steer`는 `mode: 'steer'` 항목과 `queued` 제출을 추가한다. generation을 만들지 않는다.

배치는 한 번에 항목 하나다. 같은 모드의 첫 항목만 고른다.

postTools. 툴 결과가 커밋된 뒤, follow-up 모델 호출 전에:

- 첫 `steer` 항목이 있으면 사용자 엔트리로 놓고 inbox에서 뺀다.
- 그 제출 id를 현재 run이 끝낼 입력 목록에 넣는다. `live.run`은 유지한다.
- `followUp`은 여기서 놓지 않는다.
- 그 다음 `projectMessages`에는 그 사용자 엔트리가 들어간다.

final. 모델이 툴 없이 `stop`인 커밋:

- 현재 run의 입력 제출은 모두 같은 assistant 텍스트로 `done`이다. postTools에서 합류한 steer도 그 텍스트다.
- steer가 남아 있으면 그 첫 항목만 다음 run으로 놓는다. 사용자 엔트리, 그 `queued` 제출, 새 generation, 새 `live.run`.
- steer가 없고 followUp이 있으면 inbox 문의 done 배치를 그대로 쓴다.
- 둘 다 있으면 steer를 먼저 놓고 followUp은 inbox에 남긴다.

`unanswered`는 steer도 followUp도 놓지 않는다.

## 테스트

`packages/durable/src/runtime/turn.test.ts`.

- 툴 호출 뒤 `steer` 한 개. 다음 모델 요청의 마지막 사용자 메시지는 그 content다. 최종 `done` 텍스트는 원래 제출과 steer 제출이 같다.
- steer가 두 개면 postTools는 첫 항목만 놓는다. 둘째는 그 run이 `stop`한 뒤의 다음 run 입력이다.
- 툴이 없는 `stop`에서 큐에 있던 steer는 다음 run의 사용자 엔트리가 되고, 첫 제출의 답은 첫 assistant 텍스트다.
- 같은 경계에 followUp과 steer가 있으면 postTools는 steer만 놓는다.
- 모델 에러로 unanswered가 되면 steer 항목은 inbox에 남고 제출은 `queued`다.
- `whenBusy` 생략은 여전히 `DurableBusy`다.

## 이 문이 하지 않는 일

진행 중인 모델 HTTP를 취소하지 않는다. steer는 다음 경계에서만 보인다. 한 경계에 steer를 둘 이상 놓지 않는다.
