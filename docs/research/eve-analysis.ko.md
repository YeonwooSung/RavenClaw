# eve — RavenClaw를 위한 선행 분석

eve(Vercel, Apache-2.0, 베타)는 **파일시스템 우선의 내구성 있는 백엔드 에이전트 프레임워크**다. `instructions.md`, `tools/`, `skills/`, `channels/`, `schedules/` 같은 관례적 경로에 에이전트를 적고, eve가 컴파일한 뒤 실행한다. 코딩 REPL이 아니라 **런타임 + 작성 문법**이다.

이 노트는 구조와 훔칠 계약만 적는다. 소스, 프롬프트, Workflow/Nitro 호스트는 복사하지 않는다.

분석 대상: `/Users/yeonwoosung/Desktop/eve` (읽기 전용). 이름은 소문자 `eve`.

RavenClaw는 반대 모양이다. `queryLoop` 하나, persist-before-execute, leftover-ask, 로컬 BYOK 코딩 에이전트. eve는 **내구성 세션 / HITL / 샌드박스 분리 / HTTP 세션 API** 참고로 쓴다. 루프를 바꾸지 않는다.

호스티드 제품 셸(Task + Next.js + Kata)은 `~/Desktop/y0`다. y0는 제품, eve는 그런 제품이 앉을 프레임워크다. 둘을 RavenClaw에 합치지 않는다.

영문 원본: [eve-analysis.md](eve-analysis.md).

---

## 1. eve가 하는 일 / 하지 않는 일

| eve | 아님 |
|---|---|
| 컴파일 후 실행하는 에이전트 **프레임워크** | 저장소에 켜 두는 코딩 TUI |
| 디렉터리 슬롯이 작성 UI | 숨은 툴 레지스트리 |
| Workflow로 며칠을 주차하는 세션 | 모든 툴에 persist-before-execute |
| 런타임(비밀, 툴) vs 샌드박스(bash/파일) | leftover-ask / `dontAsk` 권한 모드 |
| HTTP 세션 계약 하나 + 채널 어댑터 다수 | 호스트가 호출하는 루프 하나 |

핵심 패키지는 `packages/eve`다. 카탈로그, self-modification, 템플릿, e2e가 옆에 있다.

`AGENTS.md` 불변식: `execution/`·`harness/`는 얇게 둔다. 새 능력은 파일 슬롯, 훅, 확장이다. 이름은 경로에서 온다. `name` 필드를 짓지 않는다.

---

## 2. 파일시스템 문법

```text
my-agent/
└── agent/
    ├── agent.ts
    ├── instructions.md       # 필수 시스템 프롬프트
    ├── tools/
    ├── skills/
    ├── channels/
    ├── connections/          # MCP + OpenAPI
    ├── schedules/
    ├── subagents/<id>/
    ├── hooks/
    ├── memory.ts | memory/
    └── sandbox.ts + sandbox/workspace/**
```

탐색은 사용자 코드를 import하지 않고 걷는다. 매니페스트(v15)를 쓴 뒤, 컴파일이 선택된 모듈만 불러 경로 기반 이름을 찍고 `.eve/compile/`에 아티팩트를 쓴다.

`tools/billing/refund.ts` → 툴 이름 `billing-refund`. 훅·스케줄은 `/`를 유지한다. 스킬은 디렉터리/파일 슬러그. 작성한 `name`은 타입 에러다.

기본 툴도 같은 슬롯에 산다. `tools/bash.ts`를 직접 쓰면 기본값을 덮는다. `disableTool()`은 아래층이 남을 때만 지운다.

스킬은 **본문이지 실행 면이 아니다**. `load_skill`이 마크다운을 넣는다. `SKILL.md`는 agentskills.io의 **부분집합**이다. `name`, `allowed-tools`는 무시한다.

RavenClaw는 이미 `discoverSkills`와 `.ravenclaw/`가 있다. `agent/tools/*.ts` 컴파일러는 필요 없다. 프레임워크가 되지 않는다.

---

## 3. 세션 / 턴 / 스텝

```
session   내구성 대화 (기본 30일)
  └─ turn    사용자 배달 하나 + 그 뒤의 모든 모델/툴
       └─ step    Workflow 체크포인트. 기본은 모델 1회 + 인라인 툴
                  (실험적 workflow.modelCallsPerStep 는 스텝당 N회)
```

기본 하네스(`harness/tool-loop.ts`)는 AI SDK `ToolLoopAgent`를 **모델 스텝 1회**로 고정한다. 마지막이 툴 결과면 바깥 Workflow가 다시 부른다.

완료된 `"use step"`은 다시 돌지 않는다. 스텝 **중간** 크래시는 모델+툴 사이클 전체를 다시 돈다. RavenClaw persist-before-execute의 반대다. HITL / OAuth / 워크플로 툴 대기는 pending 배치를 남기고 컴퓨트 없이 주차한다.

배달 명령의 `turnPolicy` (기본 `steer`):

- `steer` — 교체를 버퍼하고 협조적 취소. 새 `turnId`. 이미 일어난 부수효과는 롤백하지 않음
- `queue` — 턴이 끝날 때까지 대기. 같은 인증의 인접 메시지는 합칠 수 있음
- `inputResponses` — 조향하지 않음. 열린 HITL로만 감

임의 사용자 메시지의 FIFO 메일박스는 없다. 세션 커맨드 인박스만 있다. RavenClaw는 이미 durable mailbox와 `/queue`가 있다. 훔칠 것은 **정책이 배달에 붙어 취소 의도와 어긋나지 않는 것**이다.

---

## 4. 스트림 계약

모든 표면이 `/eve/v1` 세션 패밀리(`POST /session`, `POST /session/:id`, `GET …/stream`, cancel/clear/compact/reset)를 말한다. 스트림은 NDJSON. `meta.id`는 durable write 때 한 번 찍는 ULID. 계약 버전은 현재 25다.

공개 이벤트 이름(호스트 구현용): `session.started|waiting|completed|failed`, `turn.started|completed|failed|cancelled`, `message.received|appended|completed`, `reasoning.appended|completed`, `result.completed`, `step.started|completed|failed`, `actions.requested`, `action.input.appended|partial|result`, `input.requested|resolved`, `authorization.required|completed`, `compaction.requested|completed`, `subagent.called|completed`, `context.cleared`. `turn.cancelled`는 실패가 아니다. 항상 `session.waiting`이 따른다.

클라이언트 상태는 `{ sessionId, streamIndex }`다. HTTP 쿼리는 `?startIndex=`다. 앱의 `chatId`와 런타임 `sessionId`는 다르다. 채널 continuation 토큰은 채널 경계 안에만 있다. HTTP 바디의 `continuationToken`은 거절한다. 자세한 표는 영문 [eve-analysis.md](eve-analysis.md) §4.

RavenClaw `StreamEvent`는 TUI용이다. `raven serve`와 이후 웹 클라이언트의 **호스트 계약**으로 이 카탈로그를 가져온다.

---

## 5. 툴, HITL, 샌드박스

기본 툴: `bash`, `read_file`, `write_file`(앱 런타임이 샌드박스로 프록시), `web_fetch`(SSRF 가드), `web_search`(프로바이더가 지원할 때만), `todo`, `ask_question`(주차), 루트의 `agent`/`task_cancel`, 스킬이 있으면 `load_skill`, 커넥션이 있으면 끌 수 없는 `connection_search`. `glob`/`grep`/`sleep`은 옵트인.

`approval`을 안 쓰면 `never()` — **바로 실행**. `once()`는 세션에서 한 번 승인 후 허용. `always()`는 매번, 그리고 재실행 안전한 결제용.

HITL 저장 형태는 `PendingInputBatch`(요청 + 보류한 assistant + 좌표)다. 재개는 `requestId`로 맞춘다. 질문 하나 + 새 사용자 메시지 = dismiss-and-continue(`ignored` 툴 결과). 승인은 task 모드에서 메시지로 닫히지 않는다.

RavenClaw 대응: `once()` ≈ `allow_always`, `always()` ≈ leftover-ask, `ask_question` ≈ `AskUser`. leftover-ask는 이제 `'ignored'` 결과가 있다 ([`2026-09-21-ignored-dismiss.md`](../superpowers/specs/2026-09-21-ignored-dismiss.md)). dismiss-on-message는 아직 parked. **이름 있는 정책 + durable pending 배치**를 가져온다. 기본 자동 실행은 가져오지 않는다.

샌드박스 분리:

```
앱 런타임(신뢰)                 샌드박스(비신뢰 컴퓨트)
  process.env, 툴, MCP            /workspace, bash, 파일
  모델 호출, Workflow             비밀 없음, 런타임으로 못 돌아옴
```

백엔드: Vercel Sandbox → Docker → microsandbox(Apple Silicon 또는 Linux KVM) → just-bash. 기본 네트워크는 `allow-all`. 크리덴셜 브로커(방화벽 헤더 주입)는 **Vercel Sandbox와 microsandbox만**. Docker는 allow-all / deny-all이다.

RavenClaw는 Bash만 `terminal.backend: docker`다. Read/Write/Edit는 호스트다. 훔칠 것: **샌드박스가 켜지면 파일 툴도 같은 포트**. `write_file`의 read-before-write + stale hash는 싸게 가져올 수 있다. Closer: Grep/Glob는 Bash docker 포트를 공유한다 (`docs/superpowers/specs/2026-09-21-grep-glob-docker-exec.md`). Read/Write/Edit는 호스트 WorkspaceFs jail. WorkspaceFs docker-exec는 아직 parked.

---

## 6. 채널과 호스트

호스트는 Nitro 하나다. 앞면은 TUI, ACP, Next/Nuxt/SvelteKit 프록시, `useEveAgent`.

작성 채널은 first-class `eve` + Slack/Discord/GitHub/Linear/Telegram/Teams/Twilio/MCP/Photon/Linq/Chat SDK + custom이다. Photon·Linq·Chat SDK는 셋이다. 기본 루트는 `home`(GET `/`)도 넣는다. **어댑터 동물원은 복사하지 않는다.** RavenClaw는 이미 Slack, Discord, ACP, `raven serve`가 있다.

훔칠 것: `sessionId` vs continuation 토큰, serve 인증 실패 폐쇄, raw body HMAC, 바디 `principalId` 불신.

ACP는 프로세스 로컬 UUID를 첫 prompt에서 eve `ClientSession`에 붙인다. 두 번째 루프가 아니다.

---

## 7. 메모리, 자식, 스케줄, 평가

메모리는 슬롯+프로바이더다. 회수 기록은 **id가 있는 user 역할 메시지**이지 시스템 프롬프트가 아니다. 수명: `turn.started` recall → `compaction.requested` capture(던지면 compact 중단) → `compaction.completed` 재회수 → `turn.completed` capture(실패는 로그만). `session.clear()`는 회수된 메시지만 지운다. 프로바이더 저장소는 남는다. 스코프는 신뢰된 인증에서만 온다. 파일 메모리는 `<slot>__save_memory` / `<slot>__remove_memory`다.

RavenClaw `MEMORY.md`는 기본 문서로 남긴다. 훔칠 것은 **compact 샌드위치**다.

자식: 핸들(`agentId`, 주차된 자식 세션) ≠ 태스크(`taskId`, 일 하나). 선언된 `subagents/<id>/`는 스킬/툴/샌드박스를 따로 갖는다. 겹친 백그라운드 성공은 cohort로 한 번에 부모를 깨운다. 자식 leftover-ask를 부모 호스트로 올리는 계약을 가져온다.

스케줄: 경로가 id. 마크다운 모드는 주차할 수 없는 task 세션(좀비 HITL 방지). `eve dev`는 cron을 안 쏜다.

평가: `evals/<path>.eval.ts`가 케이스 하나. 경로는 신원. **gate**(CI 실패) vs **soft/scored**(저지는 `--strict` 전까지 통과). 가짜 루프가 아니라 진짜 HTTP 세션을 몬다. 우리가 없는 가장 큰 품질 아이디어다.

---

## 8. Compact

기본 임계 90%. compact 프롬프트 봉투를 넣어서 방금 줄인 세션이 바로 다시 안 걸린다.

순서: 오래된 툴 결과 상한 → 그래도 넘치면 LLM 요약 → read-before-write 리셋 → todo 재주입 → 메모리는 요약에서 제외 후 재회수.

수동 compact/clear는 세션 명령이다. 턴이 돌면 **큐**한다. 라이브 프롬프트에 끼워 넣지 않는다.

---

## 9. 한눈에

| | eve | RavenClaw |
|---|---|---|
| 제품 | 내구성 에이전트 프레임워크 | 로컬 BYOK 코딩 에이전트 |
| 루프 | Workflow 스텝 = 모델 + 인라인 툴 | persist-before-execute `queryLoop` |
| Bash 중 크래시 | 스텝 재실행 | 재실행 없음 |
| 샌드박스 | 기본. 파일+bash 프록시 | Bash만 선택적 Docker |
| 호스트 | Nitro + first-class 어댑터 + custom | Ink, OpenTUI, exec, ACP, serve, Slack, Discord |
| HITL | 며칠 주차 | `tool_use`는 persist. **결정은** RAM. resume는 `incomplete`로 닫음 |
| 평가 | `eve eval` | `bun test` + smoke |

---

## 10. 가져갈 것 / 버릴 것

**계약만 가져간다**

1. 런타임 vs 샌드박스. 비밀·MCP는 신뢰 쪽. 파일+bash는 한 포트.
2. Durable HITL 배치. `requestId`, leftover 재큐, 질문 하나 dismiss-and-continue.
3. 배달의 `turnPolicy`.
4. ID 주소 세션 + NDJSON. cancel ≠ fail.
5. 채널 인증. raw body HMAC, 바디 신원 불신. serve 실패 폐쇄.
6. Compact 위생. 툴 결과 먼저, 파일 읽기 캐시 리셋, todo 재주입, 메모리 제외.
7. Write의 read-before-write + stale hash.
8. 자식 leftover-ask 프록시. 핸들 vs 태스크.
9. `raven eval` 모양.
10. 새 스킬/스케줄의 경로 이름.

**버린다** — Workflow를 루프로, 인라인 execute-then-persist, 채널 동물원, self-mod, `agent/tools` 컴파일러, 기본 `never()`, OpenAPI 코어 툴, Nitro/Vercel 종속, `execute_code`.

웹/풀스택을 나중에 붙이면 **eve 세션 API가 허리**다. y0의 Socket.IO+Prisma Task가 아니다. 루프는 하나, leftover-ask는 디스크에, 스트림은 `sessionId` NDJSON, 멀티테넌트면 파일+bash는 샌드박스.

그 eve 호라이즌은 구현됐다. 세션-을-잡은 구현됐다 (`docs/superpowers/specs/2026-09-16-session-as-job-roadmap.md`). Job-host state는 구현됐다 (`docs/superpowers/specs/2026-09-17-job-host-state-roadmap.md`, `6e56764`). Rewind persist-before-reset는 구현됐다 (`docs/superpowers/specs/2026-09-18-rewind-persist-and-todo-projection.md`, `048deff`). Cancel abort-pair / reset-on-resume / follow-up persist는 구현됐다 (`docs/superpowers/specs/2026-09-18-cancel-reset-followup.md`, `5eefdde`). No-job todo revert는 구현됐다 (`docs/superpowers/specs/2026-09-18-no-job-todo-revert.md`, `be5a4a7`). Stream version / `continuationToken`은 구현됐다 (`docs/superpowers/specs/2026-09-18-stream-version-token.md`, `c9c4871`). Keep-id `/clear`는 구현됐다 (`docs/superpowers/specs/2026-09-18-keep-id-clear.md`, `edeb611`). Parent tree-stop은 구현됐다 (`docs/superpowers/specs/2026-09-18-parent-tree-stop.md`, `9901d0e`). Leftover-ask abort-pair completeness + cancel 202/200은 구현됐다 (`docs/superpowers/specs/2026-09-20-leftover-ask-abort-pair.md`). Grep/Glob docker-exec는 구현됐다 (`docs/superpowers/specs/2026-09-21-grep-glob-docker-exec.md`). Ignored dismiss-and-continue는 구현됐다 (`docs/superpowers/specs/2026-09-21-ignored-dismiss.md`); dismiss-on-message는 아직 parked.
