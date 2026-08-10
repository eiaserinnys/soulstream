# 세션 러너 컷오버 준비

이 문서는 설정 값을 직접 바꾸는 실행 런북이 아니라, 컷오버 런북이 사용할 플래그·순서·노드 준비물의 코드 정본이다. 기본값은 모두 기존 in-process 거동을 보존한다.

## 플래그와 의존 관계

| 프로세스 | 환경 변수 | 기본값 | 역할 | 의존·제약 |
|---|---|---:|---|---|
| soul-server | `SOUL_RUNNER_PROCESS_ENABLED` | `false` | 새 세션을 session-per-process 러너에서 실행 | ON이면 state/artifact/releases 세 경로 필수. MCP가 켜져 있으면 stateless도 ON이어야 함 |
| soul-server | `MCP_ENABLED` | `false` | Streamable HTTP MCP route 활성화 | stateless를 켜려면 먼저 ON. production에서는 `MCP_REQUIRE_AUTH=true`와 bearer token 필수 |
| soul-server | `MCP_STATELESS_TRANSPORT_ENABLED` | `false` | LLM용 MCP 요청에서 process-local session map 제거 | `MCP_ENABLED=true` 필수. runner+MCP 컷오버에서는 ON 필수 |
| orch-server | `SOUL_RUNNER_PROCESS_ENABLED` | `false` | node disconnect 즉시 kill 대신 lease-aware reconciliation 사용 | soul-server보다 먼저 ON 가능. soul-server만 먼저 ON이면 등록 거부 |
| 양쪽 | `SOUL_RUNNER_LEASE_TIMEOUT_MS` | `1800000` | 러너 진행 lease와 orch disconnect 유예 창 | 양쪽 runner ON일 때 값이 정확히 같아야 등록됨 |
| soul-server | `SOUL_RUNNER_REAPER_INTERVAL_MS` | `15000` | node-local runner scan/reap 주기 | lease timeout보다 짧게 유지 |

스냅샷 풀에는 별도 flag가 없다. `SOUL_RUNNER_PROCESS_ENABLED=true`가 release materialization·GC·spawn을 함께 여는 단일 게이트다.

## 컷오버 순서

1. 전체 노드에 동일 코드를 먼저 배포한다. 모든 flag는 OFF이므로 기존 거동이 유지된다.
2. soul-server 빌드 산출물에 `dist/runner/package.json`, `dist/runner/runner_entry.js`가 있고 release isolation 검증이 통과했는지 확인한다.
3. 모든 프로세스에서 같은 `SOUL_RUNNER_LEASE_TIMEOUT_MS`를 설정한다.
4. orch에서 `SOUL_RUNNER_PROCESS_ENABLED=true`를 설정하고 orch를 재시작한다. 아직 runner OFF인 노드는 경고만 남기며 연결된다.
5. MCP를 쓰는 soul-server는 `MCP_ENABLED=true`, `MCP_STATELESS_TRANSPORT_ENABLED=true`, production auth 설정을 먼저 적용한다.
6. soul-server별 state/artifact/releases 경로와 권한을 준비한 뒤 `SOUL_RUNNER_PROCESS_ENABLED=true`로 재시작한다. 기동 중 현재 release materialization이 실패하면 서버가 명시적으로 실패한다.
7. node registration에서 `runner_process_v1=true`와 orch와 동일한 `runner_lease_timeout_ms`가 승인되는지 확인한다.

역순인 soul-server runner ON → orch lease OFF는 금지된다. orch는 해당 node registration을 `RUNNER_REQUIRES_LEASE_RECONCILIATION`으로 거부한다. 양쪽 TTL이 다르면 `RUNNER_LEASE_TIMEOUT_MISMATCH`로 거부한다.

## 노드 환경 준비물

| 준비물 | 요구사항 |
|---|---|
| Node.js | soul-server 패키지 계약 `>=22.5`; `node:sqlite` 포함 버전 |
| `SOUL_RUNNER_STATE_DIR` | 서비스 계정 전용 read/write/execute. 세션별 SQLite·pid·lock·config·Unix socket을 보관. Windows는 named pipe를 사용 |
| `SOUL_RUNNER_ARTIFACT_DIR` | 현재 배포의 self-contained runner build 산출물 디렉토리. 서비스 계정 read 권한 |
| `SOUL_RUNNER_RELEASES_DIR` | 서비스 계정 read/write/execute. live checkout 밖의 불변 content-hash release 풀 |
| `EVENT_OUTBOX_DIR` | 기존 node-global JSONL outbox 경로. Phase 7에서도 유지 |
| CLI 실행 파일 | Claude/Codex CLI는 snapshot 밖 host dependency. 기존 절대경로·OAuth 설정 유지 |
| 인증 | orch↔node bearer token, production MCP bearer/auth 설정 |
| 디스크 | state와 release 풀의 WAL·snapshot 여유 공간. 생성 실패는 live checkout fallback 없이 loud fail |

운영 `.env`와 Haniel 배선은 리포 밖 노드 설정 정본이다. 이 문서는 필요한 키와 순서만 정의하며 값을 쓰거나 서비스를 재시작하지 않는다.

## 사전 검증

- 설정 조합: `soul-server-ts/tests/config.test.ts`
- 스냅샷 startup prewarm: `soul-server-ts/tests/runtime/runner_process_composition.test.ts`
- node capability 광고: `soul-server-ts/tests/registration.test.ts`
- orch 등록 조합: `orch-server-ts/tests/node-ws-frame-controller.test.ts`
- all-on 전구간 스모크: `soul-server-ts/tests/runner/runner_cutover_integration.e2e.test.ts`
- self-contained release: `soul-server-ts/scripts/verify_runner_release_isolation.mjs`
