# 듀러블 compaction

Status: **draft**. 베이스 `4924308`. 듀러블 저장 스키마 버전 1 유지. 패키지 버전은 올리지 않는다. CHANGELOG는 쓰지 않는다.

Implementation plan: `docs/superpowers/plans/2026-10-25-durable-compact.md`

## 이 문서가 하는 일

idle인 대화에서 `compact()`가 앞부분을 요약 엔트리로 바꾸고, 그 뒤 `projectMessages`는 요약과 꼬리만 모델에 넘긴다. 오래된 엔트리는 저장소에 남는다.

수동 compaction만 있다. 토큰 추정, 백그라운드 compaction, overflow 재시도, usage 문서는 없다.

## 트리에서 확인한 사실

- `projectMessages`는 cutoff 이하의 엔트리를 id 순으로 넣고, `aborted`/`error` assistant와 짝이 없는 tool을 뺀 뒤 system을 맨 앞으로 보낸다.
- 엔트리 kind는 `system | user | assistant | tool`이다.
- 대화가 busy이면 `submit`은 `DurableBusy`다.

## 비목표

- 토큰 카운터, `keepRecentTokens`, 백그라운드 compaction, 재시도 sleep, usage.
- 엔트리 삭제, `active = 0`. 이 패키지 엔트리에는 active가 없다.
- 세션 경로의 `spliceCompactPath`. 그 코드는 `packages/core`다. 이 문은 그 파일을 고치지 않는다.
- 훅의 `beforeCompact`. 훅 문이 이 경로에 연결한다. 이 문의 기본 경로는 훅 없이 모델을 부른다.
- SDK, CLI, 버전 범프, CHANGELOG, pi 소스 복사.

## 동작

```ts
compact(instructions?: string): Promise<DurableSubmission>
```

그 대화가 busy이거나 inbox가 비어 있지 않으면 `DurableBusy`이고 쓰기가 없다.

한 커밋으로 `name: 'compaction'` 태스크를 `pending`, checkpoint `{ phase: 'select', instructions? }`, 제출 `queued`, `requestId` `compaction:<taskId>`로 만든다. `live.run`은 만들지 않는다.

select 순서: pending인 일반 tool, 자식이 끝난 waiting generation, pending compaction, pending generation. compaction은 채팅 generation보다 먼저다.

select phase:

- 활성 엔트리는 마지막 `compact` 엔트리가 있으면 그 엔트리부터, 없으면 전부다.
- 그 투영에서 `user`와 `assistant`만 센다. system과 tool은 세지 않는다.
- 그 수가 `<= 4`이면 태스크는 `completed`, 제출은 `done`, answer는 `''`이다. 엔트리는 없다.
- 아니면 꼬리는 마지막 user 또는 assistant 2개다. 꼬리의 assistant에 tool call이 있으면 그 tool 엔트리도 꼬리에 남긴다. 잘린 지점이 tool 엔트리면 그 tool을 호출한 assistant까지 꼬리에 넣는다. `boundaryId`는 남는 첫 엔트리의 id다.
- `boundaryId`보다 앞선 메시지와, 활성 머리가 compact 엔트리이면 그 요약이 요약 원본이다.

요약은 `model.complete`다. `stream`이 있어도 compaction은 `complete`만 쓴다.

1. system 본문은 정확히 `Summarize the conversation so a later turn can continue. Keep decisions, errors, and file paths. Omit chatter.`
2. user 본문은 원본 메시지마다 한 줄이다. 접두사는 `[User] `, `[Assistant] `, `[Tool] ` 중 하나다. 각 본문은 2000자를 넘기면 2000자에서 자른다. `instructions`가 빈 문자열이 아니면 끝에 `\nAdditional focus: `와 그 문자열을 붙인다.

분류:

- `stop`이고 content가 비어 있지 않으면 `kind: 'compact'` 엔트리를 추가한다. 메시지는 `{ role: 'user', content }`이고 content는 정확히 `The conversation history before this point was compacted into the following summary:\n\n<summary>\n` + 모델 텍스트 + `\n</summary>`이다. `boundaryId`를 둔다. 태스크는 `completed`. 제출은 `done`이고 answer는 그 감싼 텍스트다.
- 그 외에는 태스크 `failed`, 제출 `unanswered`, reason `model_error`. 엔트리 없음.

`DurableEntryRow.kind`에 `'compact'`를 더한다. `boundaryId?: number`를 더한다.

`projectMessages`는 cutoff 이하에서 id가 가장 큰 `compact` 엔트리를 시작으로 한다. 그 엔트리를 포함하고, 그보다 앞은 뺀다. `boundaryId` 이상이고 cutoff 이하인 엔트리를 포함한다. 기존의 aborted/error 제거와 tool 짝 맞추기는 그 구간 안에서 그대로다. compact 엔트리의 user 메시지는 모델 메시지에 남는다.

오래된 엔트리는 삭제하지 않는다.

## 테스트

`packages/durable/src/runtime/turn.test.ts`.

- user/assistant가 4개 이하면 `compact()`의 answer는 `''`이고 엔트리 수는 그대로다.
- user, assistant, user, assistant, user, assistant(6)이면 compact 엔트리가 하나 생기고, 다음 모델 요청에는 그 요약 user와 마지막 두 메시지만 있다. 첫 user 본문은 요청에 없다. 저장소에는 첫 user가 남아 있다.
- 요약 본문은 `<summary>`를 포함한다.
- 모델이 `error`를 반환하면 reason은 `model_error`이고 compact 엔트리는 없다.
- busy이면 `DurableBusy`이고 compaction 태스크는 없다.
- 두 번째 `compact()`는 첫 요약 이전 엔트리를 원본에 넣지 않는다.

## 이 문이 하지 않는 일

자동 임계값은 없다. 요약이 다른 대화를 옮기지 않는다. 이 패키지에는 대화 가지가 엔트리를 공유하지 않으므로 세션 스펙의 `compact would move another branch`는 쓰지 않는다.
