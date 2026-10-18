# OrcaRouter를 프로바이더 옵션으로 추가

Status: **draft**. 동작은 이 워크트리 `feat/orcarouter`에 구현되어 있다. 머지 전이므로 Shipped sha는 없다. 베이스 `3d58525`. 스키마 범프 없음. 버전 범프 없음. CHANGELOG는 쓰지 않는다.

출처: [OrcaRouter로 만든 도구](https://www.orcarouter.ai/ko/built-with), [OpenAI SDK 호환](https://docs.orcarouter.ai/compatibility/openai-sdk), [Quickstart](https://docs.orcarouter.ai/getting-started/quickstart), [Sign in with OrcaRouter](https://docs.orcarouter.ai/getting-started/sign-in-with-orcarouter). OpenCode·OpenClaw가 트래픽을 콘솔에 남기는 헤더는 `HTTP-Referer`와 `X-Title`이다.

## 이 문서가 하는 일

OrcaRouter Open Source Program은 기존 프로바이더를 치우는 이전이 아니다. 도구에 OrcaRouter를 **하나 더** 넣으면, 사용자가 그 옵션을 쓰는 동안 지출의 일부가 제작자에게 돌아간다. 독점 계약이 아니고, 사용자를 묶지 않는다. 고르지 않으면 RavenClaw는 지금과 같다.

이 문은 `provider: orcarouter` 한 가지다. 기본 프로바이더는 `anthropic`으로 남는다. Anthropic, OpenAI 호환, Ollama, vLLM, included gateway는 그대로다.

## 트리에서 확인한 사실

- `ProviderKind`는 `packages/core/src/config.ts`의 `'anthropic' | 'openai_compat' | 'ollama' | 'vllm'`다. `loadConfig`는 플래그, `config.yaml`, env 추론 순이다. 추론 순서는 `ANTHROPIC_API_KEY`, `OLLAMA_HOST`/`OLLAMA_API_KEY`, `VLLM_BASE_URL`/`VLLM_API_KEY`, `OPENAI_API_KEY`/`OPENAI_BASE_URL`다.
- `createProvider`(`packages/providers/src/registry.ts`)는 Ollama와 vLLM을 `OpenAICompatProvider`에 다른 `id`와 기본 base URL로 얹는다. 세션 호출은 `packages/cli/src/engine.ts`와 `packages/sdk/src/index.ts`의 `byokProviderFromConfig`다. 둘은 복제되어 있다. aux는 `packages/cli/src/aux.ts`의 `providerKindFromModelId`가 모델 접두사로 프로바이더를 고른다.
- `--provider` 허용 목록은 `packages/cli/src/args.ts`, 도움말은 `help.ts`, 완성은 `completions.ts`다. 첫 실행은 `first-run.ts`가 `.env`만 쓴다. `doctor`의 env 체크는 키가 하나라도 있으면 통과다. `formatPublicConfig`는 시크릿 길이만 찍는다.
- 모델 id는 그대로 전달한다. 카탈로그에 없는 id는 `conservativeProfile`(32k, $0, thinking 없음)이다. `orcarouter/auto`를 가격 표에 넣지 않는다. 라우터가 고른 실제 모델의 단가를 이 클라이언트가 알지 못한다.
- SQLite 스키마는 v11이다. 이 문은 스키마를 건드리지 않는다.

## OrcaRouter에서 가져온 계약

- OpenAI 호환 base URL은 `https://api.orcarouter.ai/v1`이다. 키는 `Authorization: Bearer`다. 호스티드 키는 `sk-orca-`로 시작한다. RavenClaw는 접두사를 검사하지 않는다. 사용자가 붙인 문자열을 그대로 보낸다.
- 모델 id는 프로바이더 접두사다. 예: `openai/gpt-4o-mini`, `anthropic/claude-sonnet-4.6`, `orcarouter/auto`. `orcarouter/auto`가 문서의 기본 선택이다. RavenClaw는 이 문자열을 다시 쓰지 않는다.
- 제작자 표기는 공식 호스트로 나가는 요청의 `HTTP-Referer: https://github.com/YeonwooSung/RavenClaw`와 `X-Title: RavenClaw`다. 이 값이 콘솔의 앱 트래픽으로 남는다.
- `app_id`와 `ref`는 PKCE 동의 화면용이다. 발급된 app id가 없고, 디바이스 플로우는 검증 배지를 보여 주지 않는다. 로그인 플로우는 이 문에 없다. 사용자는 지금처럼 키를 `.env`에 둔다.

## 비목표

- Anthropic, OpenAI, Ollama, vLLM, included gateway를 제거하거나 기본값을 OrcaRouter로 바꾸기.
- `ORCAROUTER_API_KEY`가 있어도 `ANTHROPIC_API_KEY`, Ollama, vLLM, `OPENAI_API_KEY`/`OPENAI_BASE_URL`보다 추론에서 앞서기.
- PKCE, 디바이스 코드, `app_id`, `ref`, 브라우저 로그인.
- `/v1/models`를 받아 모델 목록을 채우기. `extra_body` 폴백, 웹 검색, 세션 어피니티 헤더.
- `orcarouter/auto`의 가격 행. 스키마 범프. 패키지 버전 범프. CHANGELOG.
- `openai/`·`anthropic/` 접두사를 OrcaRouter로 다시 해석하기. aux는 지금처럼 접두사를 따른다.
- 공식 호스트가 아닌 base URL에 `HTTP-Referer`를 붙이기.

## 동작

`provider: orcarouter`는 `config.yaml`과 `--provider orcarouter`에서 받아들인다.

키가 `ORCAROUTER_API_KEY`뿐이다. 플래그와 yaml이 없으면 프로바이더는 `orcarouter`이고, 모델은 `orcarouter/auto`다. 같은 환경에 `ANTHROPIC_API_KEY`가 있으면 추론은 `anthropic`이다. `OPENAI_API_KEY` 또는 `OPENAI_BASE_URL`이 있으면 `openai_compat`이다. Ollama·vLLM 신호도 지금 순서를 유지한다. yaml이나 플래그가 `orcarouter`이면 그 키가 다른 키와 함께 있어도 `orcarouter`다.

호출은 `OpenAICompatProvider`, `id`는 `orcarouter`다. base URL 기본값은 `https://api.orcarouter.ai/v1`이다. `ORCAROUTER_BASE_URL`이 있으면 `normalizeOpenAiBaseUrl`을 거친 값을 쓴다. `OPENAI_BASE_URL`은 쓰지 않는다. `ORCAROUTER_BASE_URL`만 있고 키가 없으면 프로바이더를 추론하지 않는다.

요청 모델이 비어 있으면 바디의 `model`은 `orcarouter/auto`다. 사용자가 `anthropic/claude-sonnet-4.6`처럼 지정하면 그 문자열이 바디에 들어간다.

호스트가 `api.orcarouter.ai`일 때만 다음 헤더를 붙인다.

- `HTTP-Referer`: `https://github.com/YeonwooSung/RavenClaw`
- `X-Title`: `RavenClaw`

다른 호스트에는 이 두 헤더가 없다. `openai_compat` 요청에도 없다.

키가 없으면 CLI와 SDK는 `Set ORCAROUTER_API_KEY in $RAVENCLAW_HOME/.env or the environment.`를 던진다. `OPENAI_API_KEY`로 대체하지 않는다.

첫 실행 선택지는 `[5] OrcaRouter`다. `5` 또는 `orcarouter`는 `ORCAROUTER_API_KEY`를 `.env`에 쓴다. 빈 키는 취소다. 다른 프로바이더 선택지는 그대로다.

`raven doctor`는 `.env`에 `ORCAROUTER_API_KEY`만 있어도 env 체크가 통과한다. 값은 길이와 함께 보고하고 비밀은 찍지 않는다. 로컬 프로브는 하지 않는다.

`formatPublicConfig`는 그 키가 유일한 신호일 때 `provider: orcarouter`를 찍고, `ORCAROUTER_API_KEY: set (N chars)`만 보여 준다. 생략된 `model:` 줄의 기존 표시는 바꾸지 않는다.

aux 모델 접두사 `orcarouter`는 이 프로바이더와 `ORCAROUTER_API_KEY`를 쓴다. `openai/`와 `anthropic/`은 세션 프로바이더가 `orcarouter`여도 각각의 직접 프로바이더다.

셸 완성 단어 목록에 `orcarouter`를 넣는다.

## 테스트하는 경계

테스트는 공개 함수만 본다. 헤더 문자열은 이 스펙의 리터럴이다.

| 경계 | 잡아내는 것 | 잡지 못하는 것 |
|---|---|---|
| `loadConfig` | 종류 허용, 단독 키 추론, 기존 키가 우선, yaml/플래그 우선, 커스텀 base는 추론하지 않음 | HTTP |
| `createProvider(...).stream` | id, 공식 URL, 기본 모델, 모델 전달, 표기 헤더, 다른 호스트에는 헤더 없음 | 콘솔에 매출이 잡히는지 |
| `providerFromConfig` | CLI가 Orca 키를 쓰고 OpenAI 키로 대체하지 않음 | SDK 복제본 |
| `createRavenSession().provider` | SDK가 같은 키와 호스트를 씀 | 턴 루프 전체 |
| `parseArgv`, `runFirstRun`, `runDoctor`, `formatPublicConfig`, `providerKindFromModelId` | 사용자가 고르는 표면 | 실제 네트워크 |

## 건드릴 파일

- `packages/core/src/config.ts`, `config.test.ts`, `packages/core/src/index.ts` (상수 export)
- `packages/providers/src/registry.ts`, `registry.test.ts`, `openai-compat.ts`
- `packages/cli/src/engine.ts`, `engine-included.test.ts`
- `packages/cli/src/aux.ts`, `aux.test.ts`
- `packages/sdk/src/index.ts`, `index.test.ts`
- `packages/cli/src/args.ts`, `first-run.ts`, `first-run.test.ts`, `doctor.ts`, `doctor.test.ts`
- `packages/cli/src/config-print.ts`, `config-print.test.ts`
- `packages/cli/src/help.ts`, `completions.ts`, `completions.test.ts`
- `README.md`, `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`

## 검증

워크트리에서만, 경로를 `./`로 시작한다. 저장소 전체 `bun test`는 돌리지 않는다.

```bash
bun test ./packages/core/src/config.test.ts ./packages/providers/src/registry.test.ts ./packages/providers/src/openai-compat.test.ts ./packages/cli/src/engine-included.test.ts ./packages/cli/src/aux.test.ts ./packages/sdk/src/index.test.ts ./packages/cli/src/args.test.ts ./packages/cli/src/first-run.test.ts ./packages/cli/src/doctor.test.ts ./packages/cli/src/config-print.test.ts ./packages/cli/src/completions.test.ts
```
