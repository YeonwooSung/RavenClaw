# 듀러블 중첩 툴

Status: **draft**. 베이스 `4924308`. 듀러블 저장 스키마 버전 1 유지. 패키지 버전은 올리지 않는다. CHANGELOG는 쓰지 않는다.

Implementation plan: `docs/superpowers/plans/2026-10-25-durable-nested-tools.md`

## 이 문서가 하는 일

툴 `execute`가 같은 대화의 다른 툴을 `ctx.call`로 한 단계 부른다. 중첩 호출은 자기 태스크와 replay checkpoint를 커밋한 뒤에 실행한다. 스케줄러는 그 태스크를 집어 들지 않는다.

`ctx.spawn` 자리는 이 문에서 두고, 서브에이전트 문이 본문을 바꾼다.

## 트리에서 확인한 사실

- 툴 컨텍스트는 `{ signal, taskId }`다.
- replay가 저장값과 현재 선언 모두 `safe`일 때만 `execute`를 다시 부른다. 아니면 결과 본문은 `interrupted`다.
- `projectMessages`는 assistant tool call에 없는 tool 메시지를 뺀다.
- select는 `name === 'tool'`인 pending 태스크를 모두 집는다.

## 비목표

- 깊이 3 이상의 중첩. 서브에이전트 대화. 백그라운드 중첩.
- 중첩 결과를 모델 컨텍스트에 직접 넣는 일. 모델이 보는 것은 부모 툴의 결과뿐이다.
- 스케줄러가 중첩 태스크를 재실행하는 일.
- SDK, CLI, 버전 범프, CHANGELOG, pi 소스 복사.

## 동작

```ts
ctx: {
  signal: AbortSignal
  taskId: number
  call(name: string, args: JsonObject): Promise<{ content: string; isError: boolean }>
  spawn(input: { content: string }): Promise<
    | { status: 'done'; text: string }
    | { status: 'unanswered'; reason: string }
  >
}
```

이 문의 `spawn`은 항상 `{ status: 'unanswered', reason: 'subagent depth' }`를 반환하고 대화를 만들지 않는다.

`DurableTaskRow`에 `nested?: boolean`을 더한다. select는 `nested: true`를 제외한다.

`call`:

- 이름이 없으면 `{ content: 'tool_unavailable', isError: true }`. 태스크 없음.
- 이 태스크가 `nested: true`이면 `{ content: 'nested tool depth', isError: true }`. 실행 없음.
- 아니면 한 커밋으로 tool 태스크를 만든다. `nested: true`, `parentTaskId`는 호출자, `status: 'running'`, checkpoint `{ phase: 'execute', arguments, replay }`. replay는 자식 툴의 `replay` 또는 `'unsafe'`.
- 그 다음 자식 `execute`를 부른다. 자식 컨텍스트의 `call`은 깊이 규칙에 걸린다. `beforeTool`과 `afterTool`은 중첩 호출에도 적용한다.
- 이어서 한 커밋으로 부모 대화에 tool 엔트리를 쓰고 중첩 태스크를 terminal `completed`로 둔다. tool 메시지 id는 `nested:<childTaskId>`다. 반환은 `{ content, isError }`.
- 그 엔트리는 assistant tool call과 짝이 없으므로 `projectMessages`가 뺀다. 다음 모델 요청에 없다. 저장소에는 있다.

open의 reconcile이 `running`인 중첩 태스크를 보면 `execute`하지 않는다. 그 태스크는 terminal `outcome: 'aborted'`다. `restarts`로 다시 집어 들지 않는다. 부모 툴의 safe/unsafe 규칙은 오늘과 같다.

## 테스트

`packages/durable/src/runtime/turn.test.ts`.

- 부모 툴이 `ctx.call('child', { n: 1 })`을 하면 child `execute`는 1이고, 부모 결과에 child 본문이 들어간다. 다음 모델 요청의 tool 메시지는 부모 결과뿐이다. `nested:` 본문은 요청에 없다.
- 저장소 엔트리에는 `nested:` tool call id가 있다.
- `ctx.call('missing', {})`의 content는 `tool_unavailable`이다.
- child가 다시 `ctx.call`하면 content는 `nested tool depth`이고 손자 `execute`는 0이다.
- `beforeTool`이 중첩 이름을 block하면 child `execute`는 0이다.
- 중첩 checkpoint를 `running`으로 남긴 채 `abandon()`한 뒤 open하면 그 중첩 태스크 outcome은 `aborted`이고 child `execute`는 다시 호출되지 않는다.
- 이 문의 `spawn`은 `subagent depth`이고 대화 수는 1이다.

## 이 문이 하지 않는 일

중첩 툴을 병렬 배치로 스케줄하지 않는다. `call`은 부모 `execute` 안에서 끝나야 반환한다.
