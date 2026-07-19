# @soulstream/soul-server-ts

Soulstream TypeScript execution worker. Orchestrator WebSocket에 등록하고, Claude/Codex/OpenAI Agents 백엔드 실행과 PostgreSQL 영속화를 담당한다.

## 역할

- `node_register`/health/check command 등 upstream wire 처리
- task lifecycle, session/event persistence, intervention delivery
- Fastify `GET /health`와 Streamable HTTP MCP surface
- fail-closed migration verifier: `scripts/verify-migrations.mjs`

## 운영

Haniel `haniel.yaml`의 `services.soul-server-ts` 항목으로 자동 시작·재시작.
운영 cwd는 `./services/soulstream`이고, Haniel repo checkout 기준 모노레포 루트는 `src/soulstream/`이다.
정상 시작은 migration 상태를 검증만 한다. fresh install은 installer가 versioned migrator의
`initialize` 모드를 한 번 호출하며, 이후 릴리스는 `deploy/release-manifest.json`을 통해 적용된다.

기존 운영 설정이 `soul-server-ts/scripts/apply-schema.mjs`를 `pre_start`로 호출해도 안전하다.
이 호환 entrypoint는 빈 DB에서만 canonical `schema.sql`을 실행하고, 이미 current인 DB에서는
ledger만 멱등 bootstrap한다. destructive pending은 검증된 backup gate 없이는 실패한다.

Haniel migration-aware 배포가 먼저 적용된 뒤의 최초 승인/재시작 pull은 저장소의
`deploy/release-manifest.json`을 자동 발견해 기존 `repos.soulstream` 설정에 원자적으로
활성화한다. 운영자가 `haniel.yaml`을 손으로 수정할 필요가 없다. manifest는 특정 환경의
service key를 고정하지 않으며, Haniel이 repo에 연결된 실제 서비스
(`soulstream-orch-server`, `soulstream-soul-server-ts` 등)를 사용한다. post-start success는
HTTP/MCP/DB뿐 아니라 인증된 `/api/nodes`에서 `SOULSTREAM_NODE_ID`가 connected인 경우에만
성립한다.

### Haniel 통합 적용

신규 standalone 설치용 정본은 **`install/haniel-soul-server-ts.example.yaml`** 이다.
기존 클러스터의 one-time transition은 Haniel migration-aware 배포가 처리한다. 현재 config의
repo/service key·cwd·ready·pre_start는 유지하고 `repos.soulstream.release_manifest` 한 필드만
checksum CAS와 backup을 거쳐 자동 활성화한다. 별도 config 편집이나 reload를 요구하지 않는다.

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
