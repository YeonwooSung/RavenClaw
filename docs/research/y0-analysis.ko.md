# y0 — RavenClaw를 위한 선행 분석

y0(트리 안에서는 Shadow로도 불림)는 **호스티드, GitHub 중심의 백그라운드 코딩 잡 러너**다. 제품의 허리는 **Task**다. 레포를 클론하고 섀도 브랜치를 자르고, 에이전트 한 줄을 스트림하고, 자동 커밋하고, 선택적으로 드래프트 PR을 열고, 레포 스코프 위키를 유지한다. **제품 셸**이지 루프가 아니다.

이 노트는 훔칠 만한 **제품 계약**만 뽑는다. 의미만 훔친다. y0 소스, 프롬프트, Prisma, Socket.IO 룸, Next.js BFF는 복사하지 않는다.

분석 대상: `/Users/yeonwoosung/Desktop/y0` (읽기 전용). 이름은 `y0`, 소문자.

RavenClaw는 반대 모양이다. `queryLoop` 하나, persist-before-execute, leftover-ask, 로컬 BYOK 코딩 에이전트. y0는 **세션-을-잡으로 / 섀도 브랜치 / 턴 끝 배달** 레퍼런스로만 쓴다. 허리를 바꾸지 않고, 웹 제품으로 합치지도 않는다.

관련 런타임(파일시스템 우선 내구성 에이전트): `~/Desktop/eve`. eve는 y0 모양 앱이 앉을 프레임워크다. 둘을 RavenClaw에 합치지 않는다.

---

## 1. y0가 하는 일 / 하지 않는 일

| y0는 | y0는 아니다 |
|---|---|
| `owner/repo` + `baseBranch`에 대한 호스티드 Task | 로컬 인터랙티브 코딩 TUI |
| 격리 워크스페이스(호스트 디렉터리 또는 Kata VM + sidecar) | persist-before-execute / leftover-ask |
| 섀도 브랜치 + 선택적 드래프트 PR | 호스트가 호출해야 하는 `queryLoop` 하나 |
| Socket.IO + Prisma + Next.js BFF | 샌드박스 권한 시스템 |

**불변식:** RavenClaw 호스트는 `submitMessage`(그리고 `applyAskAnswer`)만 호출한다. Task 테이블이나 Socket.IO 룸은 두 번째 루프다. 거부한다.

---

## 2. Task-as-job 계약

Task는 `{ title, repoFullName, baseBranch, shadowBranch, baseCommitSha, status, initStatus, pullRequestNumber? }`다.

상태 축은 둘이다. `TaskStatus`(잡 생존)와 `InitStatus`(워크스페이스 준비). 합치지 않는다. `ARCHIVED`는 터미널이다.

**git의 주인**은 잡이다. 성공한 턴만 커밋한다. 중단/에러는 자동 커밋하지 않는다. 커밋 실패는 턴을 실패시키지 않는다.

**PR**은 선택적 배달물이다. dirty면 건너뛴다. 실패는 턴을 실패시키지 않는다.

**위키**는 레포 키 캐시, 첫 턴 시스템 블록. 없으면 조용히 넘어간다.

**큐**는 라이브 스트림당 슬롯 하나. 덮어쓴다. 에러면 버린다.

**메시지 편집**은 가장 가까운 체크포인트(`{ commitSha, todoSnapshot }`, 없으면 `base`)로 되돌린 뒤 그 프롬프트를 다시 넣는다.

**Stacked PR**은 부모 루프가 아니라 **새 Task**다. 자식 `base = 부모 shadow`.

**명령 정책**은 격리 신뢰다. leftover-ask가 아니다. RavenClaw는 이것을 들이지 않는다.

---

## 3. 훔친다 / 건너뛴다

**훔친다 (계약만).** 섀도 브랜치를 잡 신원으로. 턴 끝 커밋은 호스트 에필로그. 체크포인트 + 리와인드. 보이는 큐 슬롯 하나. PR은 끄는 게 기본인 선택 배달. 자식 base = 부모 shadow. `base...HEAD` ∪ dirty 디프.

**건너뛴다.** Next/Prisma/Socket.IO, Kata/sidecar, 매 잡마다 클론, 봇 코오서 커밋, 기본 켜진 자동 PR, 위키/Pinecone을 필수 호라이즌으로, leftover-ask를 대체하는 격리 신뢰, PR 닫힘 웹훅 수명주기.

**주차.** 옵트인 아키텍처 위키, GitHub App, stacked-PR UI.

---

## 4. 허리에 붙이는 법

허리는 그대로다. 호스트 → `submitMessage` → `queryLoop` 하나. y0 계약은 **세션/잡 아티팩트와 호스트 에필로그**로만 붙는다. 자기 채팅 루프, Task 행, Socket.IO 룸이 필요하면 y0 제품이다. 두지 않는다.

세션-을-잡 로드맵 (구현됨): `docs/superpowers/specs/2026-09-16-session-as-job-roadmap.md`. Job-host state (구현됨, `6e56764`): `docs/superpowers/specs/2026-09-17-job-host-state-roadmap.md`. 다음: `docs/superpowers/specs/2026-09-18-rewind-persist-and-todo-projection.md`.
