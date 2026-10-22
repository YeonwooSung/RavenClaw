# 듀러블 런타임 패키지

Status: **draft**. 베이스 `c4831c1`. 스키마 v11 유지. 버전 범프 없음. CHANGELOG는 쓰지 않는다. 워크트리 `feat/durable`.

## 이 문서가 하는 일

`@ravenclaw/durable`은 세션 바깥에 트랜스크립트와 태스크 행을 두고, 모델 호출과 툴 실행이 커밋 사이에 죽으면 그 지점부터 다시 잇는 런타임이다. CLI, SDK, ACP, HTTP의 턴은 그대로 `queryLoop`만 탄다. 이 패키지는 호스트가 나중에 골라 여는 형제 런타임이고, v1은 그 호스트 연결을 넣지 않는다.

계약의 출처는 `@earendil-works/pi-durable` 1.4.0 (MIT, Earendil Works, <https://github.com/earendil-works/pi>, `packages/durable`)의 공개 재개 규칙이다. 이 트리는 그 소스를 복사하지 않는다. `packages/durable/NOTICE`에 출처와 clean-room임을 적는다.

## 트리에서 확인한 사실

- 턴 루프는 `packages/core`의 `queryLoop` 하나다. 호스트가 스트리밍, 툴 실행, compact, pairing을 다시 구현하지 않는다.
- 세션 저장은 `~/.ravenclaw/state.db`, 스키마 v11이다. 툴 실행 도중 죽으면 unpaired `tool_use`가 `incomplete:`로 바뀌고, 툴은 다시 실행되지 않는다.
- 패키지 테스트는 `scripts/ci-unit.sh`의 `bun test packages/<name>`이다. 인자는 없는 `bun test`를 쓰지 않는다.

## pi-durable에서 가져온 계약

- 한 커밋은 엔트리, 태스크 행, 제출, 문서 교체를 한 덩어리로 쓴다. 커밋 전에는 관찰되지 않는다.
- 모델 호출과 툴 실행은 커밋 콜백 밖에서 돈다. 효과 앞에 intent checkpoint가 있다.
- 프로세스가 죽으며 남긴 `running`은 다음 open이 `pending`으로 되돌리고 `restarts`를 1 올린다. `close()`는 `running`을 `pending`으로 되돌리지만 `restarts`를 올리지 않는다.
- phase는 맨 위부터 다시 돈다. 툴은 `call`에서 `{ phase: "execute", arguments, replay }`를 쓴 뒤에만 `execute`한다. 저장 replay와 현재 선언이 둘 다 `"safe"`일 때만 `execute`를 다시 호출한다. 그 외에는 `execute`를 호출하지 않고 결과 본문을 `interrupted`로 쓴다.
- 끝난 툴 태스크는 다시 실행하지 않는다.
- 같은 conversation의 같은 `requestId`는 기존 제출을 돌려주고 사용자 엔트리를 추가하지 않는다.
- `commit` / `mintId`의 저장 실패는 런타임을 닫는다. 그 다음 호출은 `DurableClosed`다.
- 같은 checkpoint를 다시 쓰는 것은 진행이 아니다. `restarts`를 0으로 지우지 않는다. checkpoint가 바뀌거나 태스크가 terminal이 되면 `restarts`는 0이다.
- open이 `restarts`를 올린 값이 `restartLimit`(기본 5) 이상이면 `parked: true`로 두고 phase를 호출하지 않는다. 다섯 번 잘린 태스크는 다음 open에서 주차된다.

문서 저장은 Chord delta가 아니다. 값 전체를 교체한다.

## 비목표

- `queryLoop`, `SessionEngine`, `packages/core` 소스, `~/.ravenclaw/state.db`, 스키마 v11.
- CLI 플래그, SDK 옵션, ACP/HTTP 연결.
- compaction, fork, 서브에이전트, 중첩 툴, 훅, 확장 레지스트리, 스트리밍 partial, 사용량, provider 세션 id, inbox, steer, sleep, 재시도 backoff, code mode, 이미지, 내장 bash/read/edit/write, telemetry, IndexedDB, JSONL, Cloudflare.
- pi 소스 복사. 버전 범프. CHANGELOG.
- 공개 타입 이름 `Harness`, `Session`, `Agent`, `Task`, `SessionEngine`.

`now`는 시그니처에 받되 v1은 호출하지 않는다. sleep가 없기 때문이다.

## 동작

패키지 `@ravenclaw/durable`, 디렉터리 `packages/durable`, Apache-2.0, 버전 `0.1.33`, private, `"type": "module"`, export `"."` → `./src/index.ts`. `@ravenclaw/core`, providers, CLI, TUI에 의존하지 않는다.

```ts
export type JsonObject = { [key: string]: JsonValue }
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export type DurableReplay = 'safe' | 'unsafe'
export type DurableToolCall = { id: string; name: string; arguments: JsonObject }
export type DurableMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: DurableToolCall[]; stopReason: 'stop' | 'toolUse' | 'aborted' | 'error' }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError: boolean }
export type DurableModel = {
  complete(input: {
    messages: readonly DurableMessage[]
    modelId: string
    signal: AbortSignal
  }): Promise<{
    content: string
    toolCalls?: DurableToolCall[]
    stopReason: 'stop' | 'toolUse' | 'error'
  }>
}
export type DurableTool = {
  name: string
  replay?: DurableReplay
  execute(
    args: JsonObject,
    ctx: { signal: AbortSignal; taskId: number },
  ): Promise<{ content: string; isError?: boolean }>
}
export type DurableBatch = {
  conversations?: DurableConversationRow[]
  entries?: DurableEntryRow[]
  tasks?: DurableTaskRow[]
  submissions?: DurableSubmissionRow[]
  documents?: { key: string; value: JsonValue }[]
}
export type DurableStorage = {
  mintId(): number
  commit(batch: DurableBatch): void
  readConversation(id: number): DurableConversationRow | undefined
  readEntries(conversationId: number): DurableEntryRow[]
  readTask(id: number): DurableTaskRow | undefined
  readTasks(): DurableTaskRow[]
  readSubmission(id: number): DurableSubmissionRow | undefined
  readSubmissionByRequest(conversationId: number, requestId: string): DurableSubmissionRow | undefined
  readDocument(key: string): JsonValue | undefined
  close(): void
}
export function openMemoryStorage(): DurableStorage
export function openSqliteStorage(path: string): Promise<DurableStorage>
export function openDurable(storage: DurableStorage, options: {
  model: DurableModel
  tools?: readonly DurableTool[]
  modelId: string
  systemPrompt?: string
  now?: () => number
  restartLimit?: number
}): Promise<DurableRuntime>
export type DurableRuntime = {
  resume(): Promise<void>
  root(): Promise<DurableConversation>
  submission(id: number): DurableSubmission
  close(): Promise<void>
  abandon(): void
  retryTask(taskId: number): Promise<void>
  readonly closed: boolean
}
export type DurableConversation = {
  readonly id: number
  submit(input: { content: string; requestId?: string }): Promise<DurableSubmission>
}
export type DurableSubmission = {
  readonly id: number
  readonly requestId?: string
  wait(signal?: AbortSignal): Promise<
    | { status: 'done'; text: string }
    | { status: 'unanswered'; reason: string }
  >
}
export class DurableBusy extends Error { readonly code = 'busy' as const }
export class DurableClosed extends Error { readonly code = 'closed' as const }
export class DurableFault extends Error { readonly code = 'fault' as const }
```

`assertStrictJson`은 `src/json.ts` 안에만 둔다. 배럴에서 빼지 않는다.

행:

- Conversation `{ id: number }`. 루트 id는 1이고 첫 `root()`가 만든다. `mintId`를 쓰지 않는다.
- Entry `{ id, conversationId, kind: "system"|"user"|"assistant"|"tool", message }`. 추가만 한다.
- Task `{ id, name: "generation"|"tool", conversationId, parentTaskId?: number, status: "pending"|"running"|"waiting"|"terminal", checkpoint?: JsonObject, restarts: number, parked: boolean, outcome?: "completed"|"failed"|"faulted"|"aborted" }`. terminal은 outcome이 있고 checkpoint가 없다.
- Submission `{ id, conversationId, requestId?: string, status: "queued"|"done"|"unanswered", entryId?: number, answer?: string, reason?: string }`.
- 문서 키는 `agent` `{ modelId: string; systemPrompt?: string }`와 `live` `{ run?: { submissionId: number; generationTaskId: number }; tools?: { taskId: number; status: "running"|"done"; entryId?: number }[] }`뿐이다. 값 전체를 교체한다.

`mintId()`의 첫 값은 2다. 1은 루트 conversation이다. id는 재사용하지 않는다. 실패한 콜백이 이미 발급한 id의 빈칸은 허용한다.

저장:

- `commit`은 원자적이다. 콜백이 던지면 아무것도 쓰지 않는다. `commit`이나 `mintId`가 `DurableFault`가 아닌 예외를 던지면 런타임은 닫히고, 이후 공개 호출은 `DurableClosed`다. 첫 실패의 메시지가 `DurableClosed`의 메시지다.
- strict JSON이 아니면 `DurableFault`이고 쓰기는 없다. 런타임은 열린 채로 남는다. `undefined` 값, 함수, 심볼, `NaN`, `Infinity`, bigint, 순환, 배열이 아닌 특수 객체를 거부한다. `JSON.stringify`가 `undefined`를 지우는 것은 수용이 아니다.
- 읽기는 복사본이다. 호출자가 반환값을 고쳐도 다음 읽기는 그대로다.
- SQLite는 `bun:sqlite`다. `commit` 하나가 SQL 트랜잭션 하나다. 메타 `schema` = `ravenclaw-durable`, `version` = `1`. 다른 버전이면 open이 거절한다. 경로는 호출자가 고르고 `state.db`가 아니다. 비-strict 배치는 트랜잭션 전에 거절되고 파일은 그대로다.

런타임:

- `openDurable`은 phase를 돌리지 않는다. `running`만 `pending`으로 바꾸고 `restarts`를 1 올린다. 올린 값이 `restartLimit` 이상이면 `parked: true`이고 phase를 호출하지 않는다. 그 open 안에서, `live.run`이 가리키는 제출이 `queued`이면 `{ status: "unanswered", reason: "task_parked" }`로 정산하고 `live.run`을 지운다.
- `close()`는 진행 중 효과를 중단하고, `running`을 `pending`으로 쓰되 `restarts`는 그대로 둔 뒤 닫는다. 늦은 결과 커밋은 쓰지 않는다.
- `abandon()`은 프로세스 사망의 대역이다. `running`을 되돌리지 않고, 이후 이 런타임의 결과 커밋은 쓰지 않으며, `wait`은 `DurableClosed`로 거절된다. `closed`는 true다. 다음 `openDurable`이 컷오프로 센다.
- `resume()`은 스케줄러를 켜고, 당장 돌릴 phase가 없을 때 resolve된다. `submit`도 스케줄러를 켠다. `resume`은 멱등하다.
- 뮤테이션은 한 줄이다. `complete`와 `execute`는 그 줄 밖에서 돈다.
- 진행 중인 `live.run`이 있으면 새 `submit`은 `DurableBusy`이고 행을 쓰지 않는다. 같은 `requestId`는 busy보다 먼저 보아 기존 제출을 돌려준다.
- `wait(signal)`의 abort는 그 wait만 거절한다.
- `submission(id)`는 다시 연 런타임에서 같은 제출을 기다린다. 없으면 `DurableFault`.
- `retryTask`는 `parked`를 지우고 `restarts`를 0으로 한 뒤 스케줄한다. 제출 행은 바꾸지 않는다. 없는 id는 `DurableFault`.

턴:

- 새 제출은 사용자 엔트리, `queued` 제출, checkpoint `{ phase: "prepare" }`인 generation, `live.run`을 한 커밋에 쓴다. `submit`은 그 커밋이 끝나면 resolve된다. 런이 끝날 때까지 기다리지 않는다.
- generation phase는 `prepare`, `request`, `tools`뿐이다.
- `prepare`는 `systemPrompt`가 비어 있지 않고 system 엔트리가 아직 없을 때만 system 엔트리를 추가한다. 그 다음 checkpoint는 `{ phase: "request", modelId, cutoff }`이고 cutoff는 그때의 마지막 엔트리 id다.
- `request`는 그 checkpoint를 `running`으로 쓴 다음에만 `model.complete`를 호출한다. `modelId`는 checkpoint에 고정된 값이다. 메시지는 id가 cutoff 이하인 엔트리에, 누락을 메운 tool 엔트리를 더한 것이다. 그 목록에서 첫 system 메시지는 맨 앞으로 옮긴다. `stopReason`이 `aborted` 또는 `error`인 assistant는 빼다. 남은 assistant의 tool call에 없는 tool 메시지도 뺀다. 남은 tool call에 tool 엔트리가 없으면 본문이 정확히 `incomplete: tool did not finish`인 에러 tool 엔트리를 먼저 쓴다. v1은 스트림 partial을 저장하지 않는다. assistant 엔트리 전에 죽으면 같은 메시지와 같은 `modelId`로 다시 보낸다.
- `stop`이면 assistant를 쓰고 `live.run`과 `live.tools`를 지우고 제출을 `{ status: "done", text }`로 정산한다. text는 assistant content다.
- `error`, 빈 `toolUse`, 또는 `complete`가 던지면 assistant `stopReason: "error"`를 쓰고 content는 에러 메시지다. 제출은 `{ status: "unanswered", reason: "model_error" }`다.
- tool call이 있으면 assistant `toolUse` 하나와, 호출마다 parent가 그 generation인 tool 태스크를 한 커밋에 쓴다. 태스크 checkpoint는 `{ phase: "call", callId, name, arguments }`다. id가 없으면 `call_<taskId>`다. arguments가 JSON 객체가 아니면 `invalid: true`만 둔다. generation은 `waiting`, checkpoint `{ phase: "tools" }`다. 이 커밋 뒤에 런타임이 `abandon`되면 `execute`는 호출되지 않는다. 잘린 요청의 `complete`는 다시 호출되지 않는다. 툴 결과가 저장된 뒤의 다음 generation은 `complete`를 호출할 수 있다.
- tool `call`: 이름이 없으면 본문 `tool_unavailable`, `isError`, terminal `failed`, `execute` 없음. arguments가 객체가 아니면 본문 `invalid_arguments`, 같다. 그 외에는 `{ phase: "execute", callId, name, arguments, replay }`를 쓰고 replay는 툴의 `replay` 또는 `"unsafe"`다. 그 다음 `execute`는 커밋 밖이다.
- `execute`가 resolve되고 `content`가 문자열이면 tool 엔트리를 쓰고 terminal `completed`다. `isError` 기본값은 false다. `isError: true`여도 outcome은 `completed`다.
- `execute`가 던지면 본문은 정확히 `tool_error: `에 에러 메시지를 붙인다. `isError`, terminal `failed`.
- `content`가 문자열이 아니면 tool 엔트리를 쓰지 않고 terminal `faulted`다. 런타임은 닫지 않는다. 다음 request가 `incomplete: tool did not finish`를 넣는다.
- 복구의 `execute` phase는 `call`을 다시 돌리지 않는다. 저장 replay와 현재 선언이 둘 다 `"safe"`일 때만 저장 arguments로 `execute`를 다시 호출한다. 아니면 `execute` 없이 본문 `interrupted`.
- 형제 tool이 모두 terminal이면 `tools` phase가 그 generation을 terminal로 두고 checkpoint `{ phase: "prepare" }`인 다음 generation에 run을 넘긴다.

SQLite와 메모리는 같은 `DurableStorage`다.

## 테스트하는 경계

워크트리에서 `bun test ./packages/durable/src/...`. 경로는 `./`로 시작한다.

- 패키지 이름 `@ravenclaw/durable`, 버전 `0.1.33`, private, NOTICE에 `earendil-works/pi`와 `clean-room`. 소스가 `@ravenclaw/core`와 `@ravenclaw/providers`를 import하지 않는다.
- strict JSON은 `{ a: 1 }`을 받고 `NaN`, 함수, `undefined` 값을 거절한다.
- 메모리: 첫 `mintId`는 2, 한 커밋의 두 엔트리는 함께 보이고, 거절된 배치는 이전 행을 남긴다. 반환값 수정은 저장을 바꾸지 않는다.
- SQLite: 닫았다 열면 행이 남는다. 비-strict 배치와 트랜잭션 실패는 파일을 바꾸지 않는다. version이 1이 아니면 open이 거절한다.
- 뮤테이션 줄: 콜백 예외는 무쓰기. 저장 예외의 다음 호출은 `DurableClosed`. 겹친 `run`은 앞 커밋을 본 뒤 뒤를 실행한다.
- `running`과 `restarts: 4`, limit 5 → 다음 open은 `restarts: 5`, `parked: true`, phase 없음. 같은 checkpoint는 `restarts`를 유지한다. 바뀐 checkpoint는 0이다.
- `close()` 뒤 태스크는 `pending`이고 `restarts`는 그대로다. 그 다음 open도 `restarts`를 올리지 않는다.
- unsafe: `execute`가 한 번 돈 뒤 `abandon`. 다시 열면 `execute`는 그대로 1이고 tool 본문은 `interrupted`다.
- safe: 다시 열면 `execute`가 2이고 arguments가 같다.
- 결과가 이미 커밋된 툴은 다시 열어도 `execute`가 1이다.
- assistant 엔트리 전에 저장이 실패하면 `complete`가 두 번 호출되고 메시지와 `modelId`가 같다.
- `toolUse` 커밋 직후 `abandon`되면, `execute`가 호출될 때까지 `complete`는 1이다. `execute`는 한 번이다.
- 같은 `requestId`는 제출 id가 같고 사용자 엔트리는 하나다.
- run이 살아있는 동안의 다른 제출은 `DurableBusy`다.
- safe 툴이 `execute`마다 `abandon`되면 `execute`는 5번이고, 그 다음 open의 제출 reason은 `task_parked`이며 그 open은 `execute`를 호출하지 않는다.
- `content`가 숫자가 되면 다음 `complete`의 tool 본문은 `incomplete: tool did not finish`다.

## 건드릴 파일

- 추가: `packages/durable/**` (패키지, NOTICE, 소스, 테스트).
- 수정: `scripts/ci-unit.sh` 마지막에 `bun test packages/durable`.
- 수정: `packages/cli/src/ci-unit.test.ts`의 명령 배열 마지막에 같은 줄, CONTRIBUTING 단언에 `packages/durable`.
- 수정: `CONTRIBUTING.md` 표에 `packages/durable` 행. CI 문장의 패키지 목록에 `durable`.
- 수정: `ARCHITECTURE.md` 패키지 표에 한 행. "No host-local query loop" 뒤에, 이 패키지는 형제 런타임이고 호스트 루프가 아니라는 문장.
- 수정: `ARCHITECTURE.ko.md` 패키지 표에 한 행.

루트 `package.json`의 `test` 스크립트, `ci.yml`, `packages/core` 소스는 건드리지 않는다.

## 검증

워크트리에서:

```bash
bun test ./packages/durable/src/package.test.ts ./packages/durable/src/json.test.ts ./packages/durable/src/storage/memory.test.ts ./packages/durable/src/storage/sqlite.test.ts ./packages/durable/src/runtime/commit.test.ts ./packages/durable/src/runtime/scheduler.test.ts ./packages/durable/src/runtime/turn.test.ts ./packages/durable/src/exports.test.ts ./packages/cli/src/ci-unit.test.ts
```

`bash scripts/ci-unit.sh`와 인자 없는 `bun test`는 돌리지 않는다.

## 결정

- 형제 패키지로 두고 `queryLoop`와 `state.db`는 그대로 둔다.
- pi 소스는 복사하지 않고 재개 계약만 구현한다.
- 문서 저장은 JSON 통째 교체다. Chord, JSONL, IndexedDB, Cloudflare는 넣지 않는다.
- 툴 재실행은 저장 replay와 현재 선언이 둘 다 `safe`일 때만 한다.
- `restartLimit` 기본 5. 컷오프는 `restarts >= limit`이면 주차한다. pi 스케줄러와 같다.
- 사망 대역은 `abandon()`이다. `close()`는 컷오프로 세지 않는다.
- `requestId` 일치는 `DurableBusy`보다 먼저다.
- 비문자열 툴 `content`는 tool 엔트리 없이 그 태스크만 `faulted`로 두고, 다음 요청이 `incomplete: tool did not finish`를 쓴다.
- v1 저장 백엔드는 메모리와 `bun:sqlite`다.
- 호스트 연결, compaction, fork, 스트림 partial, 사용량, inbox는 이 문에 없다.
