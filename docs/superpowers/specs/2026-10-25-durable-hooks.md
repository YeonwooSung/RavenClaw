# 듀러블 훅

Status: **draft**. 베이스 `4924308`. 듀러블 저장 스키마 버전 1 유지. 패키지 버전은 올리지 않는다. CHANGELOG는 쓰지 않는다.

Implementation plan: `docs/superpowers/plans/2026-10-25-durable-hooks.md`

## 이 문서가 하는 일

`openDurable`에 훅 함수 다섯 개를 선택으로 받는다. 확장 레지스트리, 대화별 훅 선택, 훅 문서 저장은 없다. 훅은 뮤테이션 라인 밖에서 돌고, 그 결과를 다음 커밋이 소비한다.

## 트리에서 확인한 사실

- 모델 호출은 `request`가 checkpoint를 `running`으로 쓴 다음에 `complete`를 부른다.
- 툴은 `{ phase: 'execute', arguments, replay }`를 쓴 다음에 `execute`한다.
- compaction은 `model.complete`로 요약을 만든다. `beforeCompact`가 없으면 그 경로가 그대로다.

## 비목표

- 확장 레지스트리, 훅 이름 목록, 대화마다 다른 훅, 훅 memo.
- `onYield`, `afterTools`, 시스템 프롬프트 섹션.
- SDK, CLI, 버전 범프, CHANGELOG, pi 소스 복사.

## 동작

```ts
export type DurableHooks = {
  beforeRequest?(input: {
    conversationId: number
    taskId: number
    messages: readonly DurableMessage[]
  }): Promise<{ messages: readonly DurableMessage[] } | void> | { messages: readonly DurableMessage[] } | void
  afterResponse?(input: {
    conversationId: number
    taskId: number
    content: string
    stopReason: 'stop' | 'toolUse' | 'error'
  }): Promise<void> | void
  beforeTool?(input: {
    conversationId: number
    taskId: number
    name: string
    arguments: JsonObject
  }): Promise<{ arguments?: JsonObject; block?: string } | void> | { arguments?: JsonObject; block?: string } | void
  afterTool?(input: {
    conversationId: number
    taskId: number
    name: string
    content: string
    isError: boolean
  }): Promise<{ content: string; isError?: boolean } | void> | { content: string; isError?: boolean } | void
  beforeCompact?(input: {
    conversationId: number
    taskId: number
    messages: readonly DurableMessage[]
    instructions?: string
  }): Promise<{ decline: true } | { summary: string } | void> | { decline: true } | { summary: string } | void
}
```

각 이름은 함수 하나다. `openDurable`의 `hooks`가 없으면 오늘과 같다.

- `beforeRequest`가 `{ messages }`를 반환하면 그 배열을 `complete` 또는 `stream`에 넘긴다. 던지면 무시하고 원래 메시지를 보낸다.
- `afterResponse`는 분류 전에 호출한다. `complete`가 값을 반환한 에러 stop도 포함한다. 던지면 무시한다. 반환값으로 응답을 바꾸지 않는다.
- `beforeTool`의 `block`이 문자열이면 `execute`하지 않고 tool 엔트리 content를 그 문자열, `isError: true`로 커밋한다. `arguments`는 `execute`에 넘기는 객체만 바꾼다. 저장된 assistant의 arguments는 바꾸지 않는다. 던지면 block이며 content는 `hook_error`다.
- `afterTool`이 `{ content, isError? }`를 반환하면 그 값이 커밋되는 tool 결과다. 던지면 실행 결과를 그대로 커밋한다.
- `beforeCompact`는 user+assistant가 4보다 많을 때만 호출한다. `{ decline: true }`는 엔트리 없이 `done`, answer `''`다. `{ summary }`는 `model.complete`를 부르지 않고 compaction 스펙의 wrapper로 그 문자열을 놓는다. 던지면 무시하고 모델을 부른다.

훅이 커밋 전에 죽으면 다음 시도가 훅을 다시 부를 수 있다. 훅 안에서 `line.run`을 호출하는 것은 호스트 버그다. 런타임은 훅에 커밋 함수를 넘기지 않는다.

## 테스트

`packages/durable/src/runtime/turn.test.ts`.

- `beforeRequest`가 시스템 메시지를 앞에 붙이면 모델이 받은 첫 메시지는 그 시스템이다. 저장된 엔트리에는 그 시스템이 없다.
- `beforeRequest`가 던지면 모델은 원래 사용자 메시지를 받는다.
- `beforeTool`이 `block: 'no'`이면 `execute` 호출 수는 0이고 tool 엔트리 본문은 `no`다.
- `beforeTool`이 arguments를 `{ path: 'b' }`로 바꾸면 `execute`가 받은 값은 그 객체다.
- `beforeTool`이 던지면 tool 본문은 `hook_error`이고 `execute`는 0이다.
- `afterTool`이 content를 `changed`로 바꾸면 모델이 다음에 보는 tool 본문은 `changed`다.
- `beforeCompact`가 `{ summary: 'kept' }`이면 모델 `complete`는 compaction용으로 호출되지 않고 요약 엔트리에 `kept`가 있다.
- `beforeCompact`가 `{ decline: true }`이면 compact 엔트리가 없고 answer는 `''`이다.
- `hooks`가 없으면 기존 턴 테스트가 통과한다.

## 이 문이 하지 않는 일

훅을 대화 문서에 저장하지 않는다. 훅이 다른 대화를 만들거나 sleep를 걸 API는 없다.
