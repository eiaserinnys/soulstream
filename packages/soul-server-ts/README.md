# @soulstream/soul-server-ts

옵션 D 비대칭 모델 단계 1 — Codex 전담 노드 MVP. Python `soul-server`(Claude 전담)의 자매 노드로서 같은 orch에 등록된다.

## B-1 (본 패키지의 현 단계)

골격만 — 다음을 구현:
- WS reverse adapter (orch에 등록 + 재연결)
- `node_register` 발행 (`supported_backends: ["codex"]`)
- `health_check` 명령 수신·응답
- 그 외 명령은 `error: "Not implemented in soul-server-ts B-1"` fallback
- fastify `GET /health` 엔드포인트

세션 실행 능력, Codex 어댑터, DB 영속은 **본 패키지의 후속 단계(B-2/B-3)**에서 추가.

## 운영

Haniel `haniel.yaml`의 `services.soul-server-ts` 항목으로 자동 시작·재시작.
cwd는 `./services/soulstream` (모노레포 루트 기준 `src/soulstream/packages/soul-server-ts/`).

### Haniel 통합 적용

운영 `haniel.yaml`(`/home/eias/haniel-root/haniel.yaml`)에 적용할 yaml 조각의 *정본*은
**`install/haniel-soul-server-ts.example.yaml`** 에 보관된다. 본 PR 머지 후 운영자는 본 파일의
`services.soul-server-ts` + `install.configs.soul-server-ts-env` 두 항목을 운영 `haniel.yaml`에
추가하고 `haniel reload`(또는 service restart)하면 된다.

### 환경 변수

`.env.soul-server-ts` (Python `soul-server`의 `.env`와 *분리* — 같은 키 `SOULSTREAM_NODE_ID` 다른 값 충돌 회피).

| 키 | 필수 | 설명 |
|---|---|---|
| `SOULSTREAM_NODE_ID` | ✅ | 노드 식별자 (예: `eias-shopping-ts`) |
| `SOULSTREAM_UPSTREAM_URL` | ✅ | orch WS URL (예: `ws://eiaserinnys.me:5200/ws/node`) |
| `AUTH_BEARER_TOKEN` | ✅(production) | orch 인증 토큰 |
| `HOST` | ❌ (default 127.0.0.1) | fastify HTTP bind |
| `PORT` | ❌ (default 4205) | fastify HTTP 포트 |
| `ENVIRONMENT` | ❌ (default development) | `production` 시 AUTH_BEARER_TOKEN 강제 |
| `LOG_LEVEL` | ❌ (default info) | pino 레벨 |
| `DASH_USER_NAME` | ❌ | 노드 광고용 user.name |

### 개발

```bash
pnpm --filter @soulstream/soul-server-ts build
pnpm --filter @soulstream/soul-server-ts test
pnpm --filter @soulstream/soul-server-ts dev   # tsx로 즉시 실행
```

## 디자인 참조

- Python 정본: `soul-server/src/soul_server/upstream/{adapter,reconnect,command_handler,protocol}.py`
- wire 정본: `packages/wire-schema/generated/typescript/index.ts` (NodeRegister, HealthCheck, HealthStatus, ErrorMessage)
- 분석 캐시: `roselin/.local/artifacts/analysis/20260517-0030-phase-b1-soul-server-ts-skeleton.md`
