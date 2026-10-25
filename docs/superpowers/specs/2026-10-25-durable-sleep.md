# 듀러블 sleep

Status: **draft**. 베이스 `4924308`. 듀러블 저장 스키마 버전 1 유지. 패키지 버전은 올리지 않는다. CHANGELOG는 쓰지 않는다.

Implementation plan: `docs/superpowers/plans/2026-10-25-durable-sleep.md`

## 이 문서가 하는 일

`@ravenclaw/durable` 태스크가 벽시계 `until`까지 멈추고, 그 시각이 지난 뒤 `resume()`에서 같은 checkpoint의 다음 phase로 이어지게 한다. 프로세스 안의 `setTimeout`은 두지 않는다. 호스트가 시계를 넘기고 `resume()`을 다시 호출한다.

이 문은 2026-10-22 하네스 스펙의 비목표 `sleep`만 연다. inbox, steer, 스트림 partial, fork, compaction, 훅, 중첩 툴, 서브에이전트는 열지 않는다.

## 트리에서 확인한 사실

- `openDurable`은 `now`를 받지만 호출하지 않는다 (`void options.now`).
- 태스크 status는 `pending | running | waiting | terminal`이다. open의 reconcile은 `running`만 `pending`으로 바꾸고 `restarts`를 1 올린다. `close()`도 `running`만 `pending`으로 바꾸며 `restarts`는 올리지 않는다.
- 툴 결과가 커밋되면 부모 generation은 follow-up으로 바로 모델에 간다.
- 스케줄러는 `pending`인 tool, 자식이 모두 terminal인 `waiting` generation, `pending` generation 순으로 고른다.

## 비목표

- `setTimeout`, `onWake`, 재시도 backoff, Cloudflare alarm.
- inbox, steer, 스트림 partial, fork, compaction, 훅, 중첩 툴, 서브에이전트.
- `packages/core`, `packages/sdk`, `packages/cli`, `queryLoop`, `~/.ravenclaw/state.db`.
- 버전 범프, CHANGELOG, pi 소스 복사.
- 공개 타입 이름 `Harness`, `Session`, `Agent`, `Task`, `SessionEngine`.

## 동작

`now`가 없으면 시계는 `() => 0`이다. sleep 경로에서만 시계를 읽는다.

툴 결과는 `{ content: string; isError?: boolean; sleepUntil?: number }`일 수 있다.

- `sleepUntil`이 없으면 오늘의 follow-up이다.
- `sleepUntil`이 유한하고 `>= 0`이면 툴 결과 엔트리와 툴 태스크 terminal은 오늘과 같다. 부모 generation은 그 커밋에서 `status: 'sleeping'`, checkpoint `{ phase: 'sleep', until: sleepUntil, resume: 'tools' }`가 된다. 모델은 호출하지 않는다.
- 그 외 `sleepUntil`은 무시하고 바로 follow-up한다. 툴 결과는 커밋한다.
- 부모 generation이 없으면 `sleepUntil`을 무시하고 결과만 커밋한다.

`DurableTaskStatus`에 `'sleeping'`을 더한다. sqlite 메타 `ravenclaw-durable` 버전은 `'1'`이다. status는 태스크 JSON 안에 있다.

`runGeneration`이 checkpoint `phase === 'sleep'`을 보면:

- `now() < until`이면 status를 `sleeping`으로 두고 모델 없이 반환한다.
- `now() >= until`이면 status를 `pending`, checkpoint를 `{ phase: 'tools' }`로 두고 기존 follow-up을 한 번 돈다.

drive 한 바퀴의 맨 앞에서, due인 `sleeping` 태스크(`until <= now()`)를 한 커밋으로 `pending`으로 올린다. checkpoint와 `restarts`는 그대로다. 그 다음 select다.

select는 `sleeping`, `parked`, `running`, `terminal`을 고르지 않는다.

`DurableRuntime.wake()`는 커밋하지 않는다.

- `active`는 parked가 아닌 `pending`, `running`, 또는 자식이 모두 terminal인 `waiting`이 있거나, due인 `sleeping`이 있으면 true.
- `at`은 아직 due가 아닌 `sleeping`의 `until` 중 최솟값이다. 없으면 필드를 두지 않는다.

`resume()`은 due sleep을 올린 뒤 기존 drive를 돈다. open의 reconcile과 `close()`는 `running`만 본다. `sleeping`은 close와 다음 open을 넘어 남는다.

## 테스트

`packages/durable/src/runtime/turn.test.ts`에 추가한다. 시계는 테스트가 바꾸는 클로저다.

- 미래 `sleepUntil`이면 툴은 한 번 실행되고, 모델 follow-up은 없다. 태스크 status는 `sleeping`이고 checkpoint `until`은 그 값이다.
- 시계를 `until` 이후로 옮기고 `resume()`하면 follow-up 모델 호출은 한 번이다.
- `sleepUntil`이 `now()`보다 작거나 같으면 sleep 없이 follow-up이 바로 돈다.
- `sleepUntil: Number.NaN`은 무시하고 follow-up이 바로 돈다.
- `abandon()` 뒤 새 `openDurable`은 같은 태스크를 `sleeping`으로 둔다. 시계가 지난 뒤 `resume()`이 follow-up을 한 번 돈다. `restarts`는 sleep 때문에 오르지 않는다.
- `wake()`는 미래 sleep에서 `{ active: false, at: <until> }`이고, due이거나 pending 일이 있으면 `active: true`다.

기존 25개 테스트는 그대로 통과한다.

## 이 문이 하지 않는 일

호스트가 `resume()`을 부르지 않으면 due가 되어도 스스로 깨지 않는다. 툴 결과의 `sleepUntil`만 sleep를 만든다. generation이 직접 잠드는 API는 없다.
