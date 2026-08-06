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
활성화한다. 중앙 클러스터 manifest는 `environment_service=soulstream-orch-server`를
고정한다. 따라서 공유 PostgreSQL migration은 오케스트레이터 Haniel 배포에서 advisory
lock 아래 정확히 한 번 적용되고, worker-only Haniel은 apply 단계가 없는
`deploy/release-manifest-worker.json`을 고정해 완료된 ledger만 검증한다. post-start
success는 HTTP/MCP/DB뿐 아니라 인증된
`/api/nodes`에서 `SOULSTREAM_NODE_ID`가 connected인 경우에만 성립한다.

### Haniel 통합 적용

worker-only 노드 참조 정본은 **`install/haniel-soul-server-ts.example.yaml`** 이다. 이
조각은 apply 단계가 없는 worker manifest를 고정한다. 기존 클러스터의 one-time transition은
중앙 오케스트레이터 Haniel migration-aware 배포가 처리한다. worker는 그 배포가 성공한
뒤에만 새 코드로 재기동한다. 별도 DB를 소유하는 standalone 설치는
`deploy/release-manifest-standalone.json`을 자기 단일 권위로 사용한다.

### 환경 변수

`.env.soul-server-ts`가 정본이다. Haniel cwd가 모노레포 루트이므로 파일도 repo root에 둔다.

| 키 | 필수 | 설명 |
|---|---|---|
| `SOULSTREAM_NODE_ID` | ✅ | 노드 식별자 (예: `eias-shopping-ts`) |
| `SOULSTREAM_UPSTREAM_URL` | ✅ | orch WS URL (예: `ws://eiaserinnys.me:5200/ws/node`) |
| `DATABASE_URL` | ✅ | PostgreSQL connection URL |
| `EVENT_OUTBOX_DIR` | ✅ | semantic event 재시도용 노드 로컬 JSONL outbox. 코드 fallback 없음 |
| `AUTH_BEARER_TOKEN` | ✅(production) | orch 인증 토큰 |
| `HOST` | ❌ (default 127.0.0.1) | fastify HTTP bind |
| `PORT` | ❌ (code default 4205; standalone `.env.soul-server-ts.example` sets 3105) | fastify HTTP 포트 |
| `ENVIRONMENT` | ❌ (default development) | `production` 시 AUTH_BEARER_TOKEN 강제 |
| `LOG_LEVEL` | ❌ (default info) | pino 레벨 |
| `DASH_USER_NAME` | ❌ | 노드 광고용 user.name |
| `DASH_USER_PORTRAIT` | ❌ | 노드 광고용 user portrait 이미지 경로 |
| `CLAUDE_SESSION_RUNTIME_V2_ENABLED` | ❌ (default true) | persistent Query·delivery ledger·notification v2. 긴급 롤백 시 명시적으로 `false`를 설정해 legacy 경로 사용 |
| `CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS` | ❌ (default 300000) | runtime v2에서 foreground 종료 후 idle Query 회수 유예 |
| `CLAUDE_SESSION_RUNTIME_MAX_ENTRIES` | ❌ (default 16) | runtime v2 worker별 persistent Query 상한 |
| `CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS` | ❌ (default 1800000) | runtime v2 foreground 턴 상한. legacy `SESSION_TIMEOUT_SECONDS=1800` 경계를 보존 |
### Claude session runtime v2 기본 활성화와 kill-switch

`CLAUDE_SESSION_RUNTIME_V2_ENABLED`는 미설정 시 `true`다. 전 노드는 같은 코드를 배포하면
persistent Query·delivery ledger·notification v2를 사용한다. 배포 전에는 versioned migration
045·046·047을 공유 PostgreSQL에 먼저 적용해야 한다. 긴급 롤백은 각 노드의
`.env.soul-server-ts`에 `CLAUDE_SESSION_RUNTIME_V2_ENABLED=false`를 명시하고 재기동한다.
legacy 경로는 이 kill-switch를 위해 계속 검증한다.

Persistent Query에는 SDK `maxTurns`를 전달하지 않는다. SDK 0.3.218에서 이 값은 턴이
아니라 Query 전체 상한이므로, 전달하면 장기 세션의 후속 턴을 예기치 않게 막는다. 대신
runtime v2는 legacy worker 설정의 30분 foreground 상한을
`CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS`로 유지하고, 초과 시 그 턴만 interrupt한다.
kill-switch legacy 경로는 기존 `agents.yaml.max_turns` 전달을 그대로 유지한다.

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
