# 세션 러너 컷오버 준비

이 문서는 설정 값을 직접 바꾸는 실행 런북이 아니라, 컷오버 런북이 사용할 플래그·순서·노드 준비물의 코드 정본이다. 기본값은 모두 기존 in-process 거동을 보존한다.

## 플래그와 의존 관계

| 프로세스 | 환경 변수 | 기본값 | 역할 | 의존·제약 |
|---|---|---:|---|---|
| soul-server | `SOUL_RUNNER_PROCESS_ENABLED` | `false` | 새 세션을 session-per-process 러너에서 실행 | ON이면 state/artifact/releases 세 경로 필수. MCP가 켜져 있으면 stateless도 ON이어야 함 |
| soul-server | `MCP_ENABLED` | `false` | Streamable HTTP MCP route 활성화 | stateless를 켜려면 먼저 ON. production에서는 `MCP_REQUIRE_AUTH=true`와 bearer token 필수 |
| soul-server | `MCP_INTERNAL_PORT` | `PORT+1` | 내부 Claude SDK 전용 loopback 리스너 | 배포 전 노드별 포트 점유를 실측하고 충돌 시 free 포트를 env에 선반영. `127.0.0.1`에만 bind하며 nginx·외부 프록시에 절대 노출하지 않음 |
| soul-server | `MCP_STATELESS_TRANSPORT_ENABLED` | `false` | LLM 전용 `/mcp`에서 process-local session map 제거 | `MCP_ENABLED=true` 필수. runner+MCP 컷오버에서는 ON 필수. 내부 Claude SDK의 별도 `/mcp/internal`은 이 값과 무관하게 항상 stateless |
| orch-server | `SOUL_RUNNER_PROCESS_ENABLED` | `false` | node disconnect 즉시 kill 대신 lease-aware reconciliation 사용 | soul-server보다 먼저 ON 가능. soul-server만 먼저 ON이면 등록 거부 |
| 양쪽 | `SOUL_RUNNER_LEASE_TIMEOUT_MS` | `1800000` | 러너 진행 lease와 orch disconnect 유예 창 | 양쪽 runner ON일 때 값이 정확히 같아야 등록됨 |
| soul-server | `SOUL_RUNNER_REAPER_INTERVAL_MS` | `15000` | node-local runner scan/reap 주기 | lease timeout보다 짧게 유지 |

스냅샷 풀에는 별도 flag가 없다. `SOUL_RUNNER_PROCESS_ENABLED=true`가 release materialization·GC·spawn을 함께 여는 단일 게이트다.

## 컷오버 순서

1. 각 노드에서 `PORT+1`의 점유 여부를 먼저 실측한다. 이미 쓰는 서비스가 있으면 해당 노드의 free 포트를 골라 `MCP_INTERNAL_PORT` env에 선반영하되 nginx upstream에는 추가하지 않는다. 그 뒤 전체 노드에 동일 코드를 배포한다. 모든 flag는 OFF이므로 기존 거동이 유지된다.
2. soul-server 빌드 산출물에 `dist/runner/package.json`, `dist/runner/runner_entry.js`가 있고 release isolation 검증이 통과했는지 확인한다.
3. 모든 프로세스에서 같은 `SOUL_RUNNER_LEASE_TIMEOUT_MS`를 설정한다.
4. orch에서 `SOUL_RUNNER_PROCESS_ENABLED=true`를 설정하고 orch를 재시작한다. 아직 runner OFF인 노드는 경고만 남기며 연결된다.
5. MCP를 쓰는 soul-server는 `MCP_ENABLED=true`, `MCP_STATELESS_TRANSPORT_ENABLED=true`, production auth 설정을 먼저 적용한다. `MCP_INTERNAL_PORT`는 명시하거나 `PORT+1` 파생값을 사용하되, nginx 설정에 이 포트를 추가하지 않았는지 확인한다. LLM 클라이언트는 public listener의 stateless `/mcp`, 러너의 Claude SDK를 포함한 내부 소비자는 별도 loopback listener의 stateless `/mcp/internal`로 분리된다. 내부 route는 host 재시작 뒤 stale `Mcp-Session-Id`가 와도 request-scoped transport로 처리한다.
6. soul-server별 state/artifact/releases 경로와 권한을 준비한 뒤 `SOUL_RUNNER_PROCESS_ENABLED=true`로 재시작한다. 기동 중 현재 release materialization이 실패하면 서버가 명시적으로 실패한다.
7. node registration에서 `runner_process_v1=true`와 orch와 동일한 `runner_lease_timeout_ms`가 승인되는지 확인한다.

역순인 soul-server runner ON → orch lease OFF는 금지된다. orch는 해당 node registration을 `RUNNER_REQUIRES_LEASE_RECONCILIATION`으로 거부한다. 양쪽 TTL이 다르면 `RUNNER_LEASE_TIMEOUT_MISMATCH`로 거부한다.

## 노드 환경 준비물

| 준비물 | 요구사항 |
|---|---|
| Node.js | 러너 ON이면 기동 시 `node:sqlite` 실제 import probe 통과 필수. 22.5.0–22.12.x와 23.0.0–23.3.x는 `--experimental-sqlite` 필요; 무플래그 운영은 22.13+ 또는 23.4+ 사용. 러너 OFF면 probe하지 않음 |
| `SOUL_RUNNER_STATE_DIR` | 서비스 계정 전용 read/write/execute. 세션별 SQLite·pid·lock·config·Unix socket을 보관. Windows는 named pipe를 사용 |
| `SOUL_RUNNER_ARTIFACT_DIR` | 현재 배포의 self-contained runner build 산출물 디렉토리. 서비스 계정 read 권한 |
| `SOUL_RUNNER_RELEASES_DIR` | 서비스 계정 read/write/execute. live checkout 밖의 불변 content-hash release 풀 |
| `EVENT_OUTBOX_DIR` | 기존 node-global JSONL outbox 경로. Phase 7에서도 유지 |
| CLI 실행 파일 | Claude/Codex CLI는 snapshot 밖 host dependency. 기존 절대경로·OAuth 설정 유지 |
| 내부 MCP 포트 | 노드마다 `PORT+1` 점유 여부를 실측. 충돌하면 free 포트를 `MCP_INTERNAL_PORT`에 배포 전 선반영. bind 실패 메시지의 포트·env 안내를 따라 보정 |
| 인증·경계 | orch↔node bearer token, production MCP bearer/auth 설정. `MCP_INTERNAL_PORT`는 `127.0.0.1` 전용이며 nginx upstream 대상에서 제외 |
| 디스크 | state와 release 풀의 WAL·snapshot 여유 공간. 생성 실패는 live checkout fallback 없이 loud fail |

운영 `.env`와 Haniel 배선은 리포 밖 노드 설정 정본이다. 이 문서는 필요한 키와 순서만 정의하며 값을 쓰거나 서비스를 재시작하지 않는다.

## 사전 검증

- 설정 조합: `soul-server-ts/tests/config.test.ts`
- 스냅샷 startup prewarm: `soul-server-ts/tests/runtime/runner_process_composition.test.ts`
- node capability 광고: `soul-server-ts/tests/registration.test.ts`
- orch 등록 조합: `orch-server-ts/tests/node-ws-frame-controller.test.ts`
- all-on 전구간 스모크: `soul-server-ts/tests/runner/runner_cutover_integration.e2e.test.ts`
- public LLM + node-local internal stateless 동시 계약: `soul-server-ts/tests/mcp/stateless_restart_recovery.test.ts`
- release GC fail-closed: `soul-server-ts/tests/runner/runner_release_gc.test.ts`
- release ready fast-path + stale-lock 회수: `soul-server-ts/tests/runner/runner_release_pool.test.ts`
- self-contained release: `soul-server-ts/scripts/verify_runner_release_isolation.mjs`
