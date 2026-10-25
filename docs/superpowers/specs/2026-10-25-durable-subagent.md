# 듀러블 서브에이전트

Status: **draft**. 베이스 `4924308`. 듀러블 저장 스키마 버전 1 유지. 패키지 버전은 올리지 않는다. CHANGELOG는 쓰지 않는다.

Implementation plan: `docs/superpowers/plans/2026-10-25-durable-subagent.md`

## 이 문서가 하는 일

툴이 `ctx.spawn({ content })`로 자식 대화를 하나 만들고, 그 대화의 제출이 끝날 때까지 그 대화의 태스크만 펌프한 뒤 답 텍스트를 받는다. 깊이는 1이다. 백그라운드 서브에이전트는 없다.

중첩 툴 문이 넣어 둔 `spawn`의 본문을 이 문이 바꾼다.

## 트리에서 확인한 사실

- drive는 한 번에 tool 배치 또는 generation 하나를 돈다. 부모 툴 `execute` 안에서 바깥 `drive()`가 끝나기를 기다리면 자식 generation은 돌지 않는다.
- fork 문은 대화 행에 `ownerTaskId?`를 둔다. 자식 대화의 live 키는 `live:<id>`다.
- inbox의 `followUp`은 바쁠 때 큐에 넣었다가 경계에서 놓는다.
- 같은 `requestId`는 기존 제출을 반환한다.

## 비목표

- 이름으로 찾는 레지스트리, 백그라운드 anchor, reporter, 부모 턴이 끝난 뒤에도 사는 자식.
- `conversation.spawn` 호스트 메서드. 입구는 툴 컨텍스트뿐이다.
- 깊이 2. 자식 툴의 `spawn`은 대화를 만들지 않는다.
- 자식이 부모 엔트리를 복사하는 일. fork와 다르다.
- `packages/core`의 Agent 툴, `queryLoop`, SDK, CLI.
- 버전 범프, CHANGELOG, pi 소스 복사.

## 동작

`ctx.spawn({ content })`:

- 이 툴의 대화 행에 `ownerTaskId`가 있으면 `{ status: 'unanswered', reason: 'subagent depth' }`다. 쓰기 없음.
- 아니면 `ownerTaskId === ctx.taskId`인 대화가 있는지 본다. 있으면 그 대화를 다시 쓴다.
- 없으면 한 커밋으로 `{ id: mintId(), ownerTaskId: taskId }`를 만들고, 부모 agent 문서가 있으면 자식 agent 키로 복사한다. 엔트리는 복사하지 않는다.
- 자식에 `{ content, requestId: 'subagent:' + taskId, whenBusy: 'followUp' }`를 submit한다. 재실행이 같은 requestId를 쓰면 기존 제출이다.
- 바깥 drive가 부모 툴 안에 있는 동안, spawn은 자식 대화의 `nested`가 아닌 태스크만 그 제출이 `queued`가 아니게 되거나 signal이 abort될 때까지 펌프한다. 다른 대화의 태스크는 집어 들지 않는다.
- 반환은 `{ status: 'done', text }` 또는 `{ status: 'unanswered', reason }`이다.
- 자식 툴의 `spawn`은 깊이 규칙에 걸린다. 자식은 같은 모델과 같은 툴 목록을 쓴다.
- signal이 abort되면 아직 `queued`인 자식 제출은 `unanswered`, reason `aborted`다.

부모 툴이 `safe`로 다시 실행되면 같은 `ownerTaskId` 대화를 찾고 같은 requestId로 기다린다. 자식을 둘 만들지 않는다.

## 테스트

`packages/durable/src/runtime/turn.test.ts`.

- 부모 툴이 `spawn({ content: 'child question' })`을 하면 자식 대화가 하나 생기고, 그 제출의 사용자 본문은 `child question`이다. 부모 툴 결과에 자식 assistant 텍스트가 들어간다. 부모 대화 엔트리에는 자식 사용자 메시지가 없다.
- 자식 대화의 `ownerTaskId`는 부모 툴 태스크 id다. requestId는 `subagent:`로 시작한다.
- 자식 모델이 툴을 부르면 그 툴 `execute`가 자식 cwd가 아니라 같은 툴 구현으로 한 번 돌고, 그 결과가 자식 모델의 다음 요청에 있다. 부모 모델 요청에는 없다.
- 자식 툴이 `spawn`하면 reason은 `subagent depth`이고 대화는 부모와 자식 둘뿐이다.
- 부모 툴을 safe replay로 다시 실행해도 자식 대화는 하나다.
- 펌프 중 signal이 abort되면 반환 reason은 `aborted`다.

## 이 문이 하지 않는 일

자식을 부모 트랜스크립트 fork로 만들지 않는다. 자식이 끝난 뒤 호스트가 그 대화에 다시 `submit`하는 API는 `runtime.conversation(id)`로 이미 가능하다. spawn이 그 핸들을 반환하지는 않는다.
