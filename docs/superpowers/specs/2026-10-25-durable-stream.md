# 듀러블 스트림 partial

Status: **draft**. 베이스 `4924308`. 듀러블 저장 스키마 버전 1 유지. 패키지 버전은 올리지 않는다. CHANGELOG는 쓰지 않는다.

Implementation plan: `docs/superpowers/plans/2026-10-25-durable-stream.md`

## 이 문서가 하는 일

모델이 `stream`을 제공하면, 응답이 커밋되기 전에 지금까지의 전문을 `live.partial`에 남긴다. 읽는 쪽은 `runtime.partial(conversationId)`로 그 문자열을 본다. partial은 엔트리가 아니고, 죽으면 다음 요청은 같은 메시지를 다시 보낸다.

## 트리에서 확인한 사실

- `DurableModel.complete`는 한 번에 `{ content, toolCalls?, stopReason }`을 반환한다.
- assistant 엔트리가 커밋되기 전에 죽으면 같은 메시지와 같은 `modelId`로 다시 보낸다. 하네스 스펙은 v1이 스트림 partial을 저장하지 않는다고 적는다. 이 문이 그 문장만 바꾼다.
- `live`는 `{ run?: { submissionId, generationTaskId } }`이다.

## 비목표

- SDK `Provider.stream` 연결, CLI `--json`, ACP, HTTP.
- partial을 assistant 엔트리로 승격하는 일. partial에서 재개하는 일.
- 토큰 usage, provider 세션 id.
- 버전 범프, CHANGELOG, pi 소스 복사.

## 동작

`DurableModel`에 선택 필드를 더한다.

```ts
stream?(input: {
  messages: readonly DurableMessage[]
  modelId: string
  signal: AbortSignal
  onPartial: (text: string) => void
}): Promise<{
  content: string
  toolCalls?: DurableToolCall[]
  stopReason: 'stop' | 'toolUse' | 'error'
}>
```

`request`는 `stream`이 함수이면 `stream`을, 아니면 `complete`를 부른다. `complete`만 있으면 partial을 쓰지 않는다.

`onPartial(text)`의 `text`는 델타가 아니라 지금까지의 전문이다. 호출은 뮤테이션 라인 밖에서 온다. 호스트는 그 문자열로 `live.partial = { taskId, content: text }`를 커밋하고, `live.run`과 다른 키는 유지한다.

stop, toolUse, 모델 에러를 커밋하는 커밋은 `partial` 키를 지운다. `stream`이 던지면 `complete`가 던진 것과 같은 경로이고, partial을 썼다면 그 경로의 커밋이 `partial`을 지운다.

partial 커밋 뒤 assistant 엔트리 전에 죽으면 `partial`은 문서에 남는다. 다음 open의 요청은 같은 메시지를 다시 보낸다. `projectMessages`는 partial을 보지 않는다.

```ts
partial(conversationId: number): string | undefined
```

대화가 없으면 `DurableFault`, 메시지는 `unknown conversation <id>`. partial이 없으면 `undefined`. 있으면 `content` 문자열이다. 루트 키는 `live`, 다른 대화는 `live:<id>`다. 이 문에서는 루트만 테스트한다. 키 분기는 fork 문이 쓴다.

## 테스트

`packages/durable/src/runtime/turn.test.ts`.

- `stream`이 `onPartial('Hel')`, `onPartial('Hello')`를 부르면, 두 번째 호출이 돌아온 시점의 `partial(1)`은 `'Hello'`다. `done` 뒤 `partial(1)`은 `undefined`다.
- `stream`이 없는 모델은 `complete`만 부르고 `partial(1)`은 요청 중에도 `undefined`다.
- partial 커밋 뒤 `abandon()`하고, 다음 open이 다시 `stream` 또는 `complete`에 같은 사용자 메시지를 넘긴다. 저장된 엔트리에는 partial 문자열이 assistant로 없다.
- `partial(99)`는 `unknown conversation 99`다.
- `stream`이 partial 한 번 쓴 뒤 던지면 제출은 unanswered이고 `partial(1)`은 `undefined`다.

## 이 문이 하지 않는 일

partial 쓰기 간격을 제한하지 않는다. 테스트는 partial을 두 번 이하로 부른다. 델타 합치기는 모델 구현의 일이다.
