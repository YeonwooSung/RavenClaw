# 슬래시 `/branch`로 현재 경로와 다른 잎을 고른다

Status: **implemented**. 베이스 `4caf820`. 스키마 v12. 패키지 버전은 올리지 않는다. CHANGELOG는 쓰지 않는다. Shipped sha: `25f5af7` on `main`.

Implementation plan: [2026-10-23-session-branch-ui.md](../plans/2026-10-23-session-branch-ui.md)

앞 문서 [`2026-10-23-session-branch.md`](2026-10-23-session-branch.md)가 저장소와 `SessionEngine.branchAt`을 둔다. 이 문서는 그 메서드를 부르는 슬래시 하나다. `branchAt`의 의미는 바꾸지 않는다. 사용자 메시지를 고르면 한 칸 앞의 id를 넘기는 선택은 이 슬래시가 한다.

## 이 문서가 하는 일

대화형 TUI에서 `/branch`는 지금 잎 경로를 번호로 보여주고, `/branch <n>`은 그 번호의 메시지로 잎을 옮긴다. 현재 경로 밖의 다른 잎도 이어서 보여 주고, 그 번호는 그 잎 id로 `branchAt`을 부른다. 다음 사용자 입력은 옮긴 잎의 자식이다. 옛 줄은 `active = 1`로 남는다.

Ink는 성공한 경로로 트랜스크립트를 갈아끼운다. OpenTUI는 같은 경로를 스크롤 아래에 다시 찍는다. 파일, git, todo, 컴팩트 세대, 권한 모드는 그대로다.

## 트리에서 확인한 사실

- `SessionEngine.branchAt(messageId)`는 그 메시지 자신을 잎으로 둔다. 성공하면 `{ ok: true, messages }`다. `maybeFinishRewindReset`이 이미 돌았으면 잎을 옮기지 않고 `{ ok: true, notice }`다. 거절 notice는 `pending permission ask`, `a turn is in progress`, `message is not on this session`, `branch persist failed`, rewind reset의 `nothing to rewind`와 `rewind reset failed`다. 파일 이력과 git은 부르지 않는다.
- `Message`에는 부모 필드가 없다. `loadMessages`는 잎에서 뿌리로 활성 줄만 걷고 저장하지 않는다. `loadSession`은 그 다음 `repairRoleAlternation`을 돌리고 합성 툴 줄을 저장할 수 있다.
- 활성 줄 전체의 `parent_id`를 읽는 스토어 메서드는 없다. `listActiveMessageIds`는 id만 돌려준다. 현재 경로만 목록으로 쓰면, 잎을 조상으로 옮긴 뒤 갈라 둔 끝은 번호로 다시 고를 수 없다.
- Pi의 `navigateTree`는 고른 엔트리가 사용자 메시지이거나 `custom_message`이면 잎을 그 `parentId`로 두고 본문을 에디터에 넣는다. 뿌리이면 잎은 null이다. 그 밖의 엔트리는 고른 id가 잎이다. 요약 여부를 물은 뒤 채팅을 지우고 다시 그린다. Pi의 `/fork`는 그 경로를 새 세션 파일로 복사한다. 둘 다 이 저장소의 `branchAt`이 아니다.
- `SLASH_COMMANDS`에 `branch`는 없다. `handleSlashCommand`는 등록되지 않은 이름도 커맨드로 돌리고, `dispatchSharedSlash`의 기본 분기는 `unknown command: /branch`다.
- `HOST_ONLY`는 `quit`, `stop`, `clear`, `resume`, `diff`, `retry`, `queue`, `loop`, `bash`다. `/rewind`는 shared이고 notice만 낸다. Ink의 `rows`는 엔진 배열의 투영이 아니다. `/resume`만 `rowsFromMessages`로 갈아끼운다. `/rewind`는 `setRows`를 부르지 않는다.
- OpenTUI의 `view.reset()`은 이후 flush용 버퍼만 비운다. 이미 터미널에 찍힌 줄은 지우지 않는다. `/clear`가 그렇게 쓴다.
- `dispatchSharedSlash`를 부르는 호스트는 Ink(`app.tsx`)와 OpenTUI(`opentui-app.ts`)뿐이다. `raven serve`, Slack, Discord, ACP는 이 디스패치를 타지 않는다.
- `commands.test.ts`는 `SLASH_COMMANDS` 이름 배열 전체를 `toEqual`로 고정한다. 순서는 `rewind` 다음이 `diff`다.
- 스키마는 12다. 이 문에 마이그레이션은 없다.

## 비목표

- `/tree` 별칭, 방향키 피커, 접기, 라벨, 가지 요약, 요약 프롬프트.
- 고른 사용자 본문을 composer나 드래프트에 넣는 일. 그것은 `/retry`다.
- 뿌리 사용자 메시지에서 잎을 `NULL`로 두거나 새 세션을 만드는 일.
- 다른 잎을 고를 때 한 칸 물러서는 일. 그 번호는 그 끝을 그대로 연다. 그 끝에서 다시 사용자 메시지를 고르면 그때 한 칸 물러선다.
- `/rewind`의 파일 취소, 잡 `git reset`, todo 복원, `compactGeneration` 변경.
- 컴팩트를 경로 전용으로 만드는 일. 공유 앞부분을 끄면 다른 가지에서도 빠지는 한계는 앞 문서 그대로다.
- `Message`에 `parentId`를 넣는 일. `queryLoop`, `assembleRequest`, `decidePermission`, `branchAt`의 거절 순서.
- HTTP 경로, ACP, Slack, Discord. 듀러블 fork. `raven durable`.
- OpenTUI 화면을 ANSI로 지우는 일. 기능 플래그. 패키지 버전. CHANGELOG. `ARCHITECTURE.md`의 구현 목록에 이 draft를 넣는 일.

## 동작

### 슬래시

`SLASH_COMMANDS`에서 `rewind` 다음과 `diff` 앞에 한 줄을 넣는다. 별칭은 없다.

- `name`: `branch`
- `usage`: `/branch [n]`
- `summary`: `list this path, or branch at a numbered message`

`HOST_ONLY`에 넣지 않는다. 선택 규칙은 `dispatchSharedSlash`의 `branch` 한 곳에만 둔다. `app.tsx`와 `opentui-app.ts`는 그 규칙을 다시 구현하지 않는다.

인자 파싱과 줄 포맷은 `packages/cli/src/branch-cmd.ts`에 둔다.

`parseBranchArg(raw: string | undefined)`:

- `undefined`, 빈 문자열, 공백만이면 `{ action: 'list' }`.
- trim 한 값이 `/^\d+$/`이고 `Number`가 1 이상이면 `{ action: 'select', n }`이다. `n`은 그 정수다. `01`은 1이다.
- 그 밖은 `{ action: 'error' }`다. notice는 `usage: /branch [n]`이다.

### 목록에 쓰는 읽기

스토어에 읽기 전용 메서드를 더한다.

```ts
listBranchNodes(sessionId: string): Promise<SessionBranchNode[]>

interface SessionBranchNode {
  message: Message
  parentId: string | null
}
```

세션이 없으면 지금의 `session not found: <id>`다. `active = 1`만 포함한다. 저장하지 않고 잎을 고치지 않는다. 순서는 `createdAt` 오름차순이고, 같으면 `message.id` 오름차순이다. sqlite와 메모리 스토어가 이 순서를 같이 쓴다. `Message`에는 부모를 복사하지 않는다.

슬래시는 `loadSession`을 부르지 않는다. `runtime.store.loadMessages`로 현재 경로를 읽고, 이어서 `listBranchNodes`를 읽는다. 둘 중 하나라도 없으면 notice `branch unavailable`이고 `branchAt`을 부르지 않는다. 예외면 `error.message`를 notice로 내고 멈춘다. `Error`가 아니면 `String(error)`다.

다른 잎은 `listBranchNodes` 중에서, 현재 경로의 id 집합에 없고, 어떤 활성 노드의 `parentId`도 그 id가 아닌 노드다. 경로는 `loadMessages`의 순서를 쓴다. 노드 목록에 경로 id가 빠져 있어도 경로 표시는 `loadMessages`를 따른다.

### 보이는 줄

미리보기 `preview(message)`:

- `blocks` 안의 `type: 'text'`를 순서대로 하나의 공백으로 잇는다.
- `\r`와 `\n`이 하나 이상인 구간은 공백 하나로 바꾼다.
- 연속 공백은 하나로 줄이고 trim 한다.
- trim 결과가 빈 문자열이면 `(no text)`다.
- 길이가 60을 넘으면 앞 59자와 `…`(U+2026) 하나다. 60이면 그대로다.

한 줄은 역할과 미리보기를 두 칸으로 잇는다. 역할은 `message.role` 그대로다. `user`, `assistant`, `tool`뿐이다.

현재 경로의 마지막 줄만 `* `로 시작한다. 나머지 경로 줄은 공백 두 칸으로 시작한다. 번호는 1부터다.

```
  1 user  hello
* 2 assistant  world
```

다른 잎이 있으면 빈 줄, `other` 한 줄, 이어서 번호를 경로 길이 다음부터 붙인다. 다른 잎 줄도 공백 두 칸으로 시작한다. 별은 없다. 순서는 `listBranchNodes`의 순서를 유지한 채 다른 잎만 고른 순이다.

```
  1 user  hello
* 2 assistant  world

other
  3 user  earlier tip
```

경로가 비고 다른 잎만 있으면 `other` 헤더 없이 1번부터 그 잎들만 찍는다. 경로도 다른 잎도 없으면 목록 대신 `nothing to branch`다.

`/branch`에 번호가 없으면 이 목록을 notice로 내고 `branchAt`을 부르지 않는다. `onBranched`도 부르지 않는다.

### 번호를 고르면

`n`이 목록 길이보다 크면 notice `no message <n>`이다. `branchAt`을 부르지 않는다.

경로 안의 번호:

- 그 줄의 역할이 `user`이고 번호가 1이면 notice `already at the start`다. 잎은 그대로다. 잎을 `NULL`로 만들지 않는다.
- 역할이 `user`이고 번호가 2 이상이면 대상은 바로 앞 경로 줄의 id다. 숨은 비활성 부모가 아니라, `loadMessages`가 돌려준 배열의 이전 원소다.
- 역할이 `assistant` 또는 `tool`이면 대상은 그 줄의 id다.

다른 잎 번호의 대상은 그 노드의 `message.id`다. 한 칸 물러서지 않는다.

대상 id가 현재 경로의 마지막 id와 같으면 notice `already at this point`다. `branchAt`을 부르지 않는다.

그 밖에는 `runtime.engine.branchAt(targetId)`를 한 번 부른다.

- `{ ok: false, notice }`이면 그 notice를 그대로 낸다.
- `{ ok: true, notice }`이면 그 notice를 그대로 낸다. 잎은 엔진이 이미 그대로 둔 상태다.
- `{ ok: true, messages }`이면 notice는 `branched at <k> <role>`이다. `k`는 `messages.length`이고 `role`은 마지막 메시지의 `role`이다.

성공해서 `messages`를 받은 때에만 `host.onBranched?.(messages)`를 부른다. 그 외에는 부르지 않는다. 콜백이 없어도 잎 이동과 notice는 같다.

### 화면

`SlashHost`에 선택 필드를 더한다.

```ts
onBranched?(messages: Message[]): void
```

Ink는 이 콜백에서 `setRows(rowsFromMessages(messages))`를 하고 `selectedIndex`를 지우고 `expandedIds`를 빈 집합으로 둔다. 드래프트, todo, 태스크, 모델, 권한 모드, diff 선택은 바꾸지 않는다.

OpenTUI는 콜백에서 `formatBranchList(messages)`를 한 번 더 `write`한다. 이건 이동한 뒤의 현재 경로만이다. `other` 절은 넣지 않는다. `view.reset()`을 부르지 않고, 이미 찍힌 스크롤을 지우지 않는다.

다음 사용자 제출은 기존 `submitMessage`다. 이 슬래시는 `runTurn`을 부르지 않는다.

## 테스트하는 경계

워크트리에서 아래 명령만 돌린다. 라이브 모델은 없다.

- `parseBranchArg(undefined)`, `''`, `'   '`는 list다. `'2'`와 `'02'`는 select 2다. `'0'`, `'foo'`, `'2 extra'`는 error다.
- 미리보기는 줄바꿈을 공백으로 접고, 60자를 넘으면 59자 뒤에 `…`를 붙인다. 텍스트가 없으면 `(no text)`다.
- 현재 경로 두 줄과 다른 잎 한 줄의 목록은 별이 두 번째 줄에만 있고, 빈 줄과 `other` 다음에 3번이 온다.
- 경로가 비고 다른 잎만 있으면 `other` 헤더가 없고 1번부터다.
- 이름 배열에서 `branch`는 `rewind` 다음, `diff` 앞이다. 별칭은 없다. `/help` 줄 수는 `SLASH_COMMANDS` 길이와 같다.
- 번호 없는 `/branch`는 목록 notice만 내고 `branchAt`과 `onBranched`를 부르지 않는다.
- 경로의 세 번째가 사용자 메시지면 `/branch 3`은 `branchAt`에 두 번째 id를 넘긴다. 성공 notice는 `branched at 2 <그 역할>`이고 `onBranched`는 엔진이 돌려준 배열을 받는다.
- `/branch 1`이 사용자 메시지면 `already at the start`이고 `branchAt`을 부르지 않는다.
- 경로의 assistant를 골랐고 그 id가 이미 잎이면 `already at this point`이고 `branchAt`을 부르지 않는다.
- 다른 잎 번호는 그 잎 id로 `branchAt`을 부르고, 그 부모 id로는 부르지 않는다.
- 범위를 넘으면 `no message <n>`이다. 정수가 아니면 `usage: /branch [n]`이다.
- 경로와 다른 잎이 둘 다 없으면 `nothing to branch`다.
- 엔진이 `pending permission ask` 또는 `a turn is in progress`를 돌려주면 그 문자열이 notice이고 `onBranched`는 없다.
- `loadMessages`가 던지면 그 메시지가 notice이고 `branchAt`은 없다.
- OpenTUI에서 성공한 `/branch <n>`은 notice와 이동 뒤 경로 줄을 쓰고, `view.reset`에 해당하는 화면 지우기는 없다. 드래프트는 비어 있다.
- `listBranchNodes`는 없는 세션에서 `session not found: <id>`다. 가지를 만든 뒤 활성 네 줄의 `parentId`가 삽입 부모와 같고, 비활성 줄은 없다. 메모리 스토어와 sqlite 스토어가 같은 순서를 돌려준다.
- 기존 rewind 테스트 파일은 이 문에서 수정하지 않는다. `/rewind`는 `branchAt`을 부르지 않는다.

## 건드릴 파일

- 추가: `packages/cli/src/branch-cmd.ts`, `packages/cli/src/branch-cmd.test.ts`.
- 수정: `packages/cli/src/commands.ts`의 `SLASH_COMMANDS`. `packages/cli/src/commands.test.ts`의 이름 배열.
- 수정: `packages/cli/src/slash/dispatch.ts`의 `SlashHost`와 `branch` 분기. `packages/cli/src/slash/dispatch.test.ts`.
- 수정: `packages/cli/src/app.tsx`의 `onBranched`. `packages/cli/src/opentui-app.ts`의 `onBranched`. `packages/cli/src/opentui-app.test.ts`의 `fakeEngine`에 `branchAt`을 두고 성공 경로 한 건을 더한다.
- 수정: `packages/core/src/types.ts`의 `SessionStore`. `packages/core/src/types.test.ts`에서 `satisfies SessionStore`인 객체.
- 수정: `packages/core/src/session/sqlite-store.ts`, `packages/core/src/session/memory-store.ts`, `packages/core/src/session/branch-store-tests.ts`.
- 수정: `README.md`의 슬래시 표에 `/rewind` 다음 한 행. `SLASH_COMMANDS.md`와 `SLASH_COMMANDS.ko.md`에 shared 표 한 행과 `/rewind` 다음 절. 한국어 머메이드와 `HOST_ONLY` 아홉 개 목록은 그대로다.

`packages/core/src/loop/session-engine.ts`, `packages/core/src/session/rewind.ts`, `packages/core/src/loop/phases.ts`, `packages/core/src/loop/query-loop.ts`, 스키마 SQL, `packages/durable`, `packages/sdk`, `serve.ts`, CHANGELOG, `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`는 수정하지 않는다.

## 검증

```bash
bun test ./packages/cli/src/branch-cmd.test.ts ./packages/cli/src/commands.test.ts ./packages/cli/src/slash/dispatch.test.ts ./packages/cli/src/opentui-app.test.ts ./packages/core/src/session/sqlite-store.test.ts ./packages/core/src/session/memory-store.test.ts ./packages/core/src/types.test.ts
```

인자 없는 `bun test`와 `bash scripts/ci-unit.sh`는 돌리지 않는다.

## 결정

- 입구는 `/branch [n]` 하나다. `/tree`는 두지 않는다. 규칙은 shared 디스패치에만 있다.
- 번호는 현재 잎 경로를 먼저 세고, 다른 잎을 `other` 아래에 이어 센다. 다른 가지는 끝 번호로만 돌아온다.
- 현재 경로의 사용자 메시지는 한 칸 앞 줄이 대상이다. 1번 사용자는 거절한다. assistant와 tool은 그 줄이 대상이다.
- 다른 잎 번호는 그 id가 대상이다. 부모로 물러서지 않는다.
- `branchAt`은 앞 문서 그대로다. 이 슬래시는 넘길 id만 고른다.
- 성공한 Ink 트랜스크립트는 돌아온 경로로 바뀐다. OpenTUI는 그 경로를 아래에 다시 찍고 스크롤은 지우지 않는다.
- 고른 본문은 composer에 넣지 않는다. 파일, git, todo는 되돌리지 않는다.
- 듀러블 fork와 HTTP 분기는 이 문서 밖에 있다.
