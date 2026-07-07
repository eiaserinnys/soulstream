# @soulstream/soul-server-ts

Soulstream TypeScript execution worker. Orchestrator WebSocket에 등록하고, Claude/Codex/OpenAI Agents 백엔드 실행과 PostgreSQL 영속화를 담당한다.

## 역할

- `node_register`/health/check command 등 upstream wire 처리
- task lifecycle, session/event persistence, intervention delivery
- Fastify `GET /health`와 Streamable HTTP MCP surface
- schema application helper: `scripts/apply-schema.mjs`

## 운영

Haniel `haniel.yaml`의 `services.soul-server-ts` 항목으로 자동 시작·재시작.
운영 cwd는 `./services/soulstream`이고, Haniel repo checkout 기준 모노레포 루트는 `src/soulstream/`이다.

### Haniel 통합 적용

운영 `haniel.yaml`(`/home/eias/haniel-root/haniel.yaml`)에 적용할 yaml 조각의 *정본*은
**`install/haniel-soul-server-ts.example.yaml`** 에 보관된다. 운영자는 본 파일의
`services.soul-server-ts` + `install.configs.soul-server-ts-env` 두 항목을 운영 `haniel.yaml`에
추가하고 `haniel reload`(또는 service restart)하면 된다.

### 환경 변수

`.env.soul-server-ts`가 정본이다. Haniel cwd가 모노레포 루트이므로 파일도 repo root에 둔다.

| 키 | 필수 | 설명 |
|---|---|---|
| `SOULSTREAM_NODE_ID` | ✅ | 노드 식별자 (예: `eias-shopping-ts`) |
| `BOARD_YJS_HOST_NODE_ID` | ✅ | 보드 Y.Doc을 실제 호스팅하는 단일 TS 노드 ID |
| `SOULSTREAM_UPSTREAM_URL` | ✅ | orch WS URL (예: `ws://eiaserinnys.me:5200/ws/node`) |
| `DATABASE_URL` | ✅ | PostgreSQL connection URL |
| `AUTH_BEARER_TOKEN` | ✅(production) | orch 인증 토큰 |
| `HOST` | ❌ (default 127.0.0.1) | fastify HTTP bind |
| `PORT` | ❌ (code default 4205; standalone `.env.soul-server-ts.example` sets 3105) | fastify HTTP 포트 |
| `ENVIRONMENT` | ❌ (default development) | `production` 시 AUTH_BEARER_TOKEN 강제 |
| `LOG_LEVEL` | ❌ (default info) | pino 레벨 |
| `DASH_USER_NAME` | ❌ | 노드 광고용 user.name |
| `DASH_USER_PORTRAIT` | ❌ | 노드 광고용 user portrait 이미지 경로 |
| `SUPERVISOR_ENABLED` | ❌ (default false) | supervisor 세션 부팅, wake, watchdog 활성화. true면 event ingest도 함께 켜짐 |
| `SUPERVISOR_EVENT_INGEST_ENABLED` | ❌ (default false) | supervisor 세션은 켜지 않고 durable event ingest만 별도로 켤 때 사용 |

### 개발

```bash
pnpm --filter @soulstream/soul-server-ts build
pnpm --filter @soulstream/soul-server-ts test
pnpm --filter @soulstream/soul-server-ts dev   # tsx로 즉시 실행
```

root의 `.env.soul-server-ts.example`에 로컬 실행 예시가 있다.

## 디자인 참조

- wire 정본: `packages/wire-schema/generated/typescript/index.ts`
- schema 정본: `packages/db-schema/sql/schema.sql`
