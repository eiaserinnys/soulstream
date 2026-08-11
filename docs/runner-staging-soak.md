# 러너 스테이징 소크 하니스

실제 orch·soul production entry, detached runner, Claude OAuth, internal MCP를 쓰되 라이브 포트·DB·상태 경로와 분리된 단일 노드 하니스다. 기본 설정은 `soul-server-ts/scripts/staging-soak/config.example.json`이다.

## 준비물

- Node 22와 현재 워크스페이스 의존성
- 빌드된 `orch-server-ts/dist`, `soul-server-ts/dist`, `soul-server-ts/dist/runner`
- `postgres` 또는 `template1`을 가리키는 PostgreSQL 관리자 URL
- 기존 Claude OAuth credential JSON 경로와 Codex home 경로. prepare가 Claude credential과 Codex `auth.json`을 staging root로 0600 복사하므로 원본은 런타임에서 쓰지 않는다.
- 임의 생성한 staging 전용 bearer token

비밀값은 다음 env 이름으로만 전달한다. 명령 출력과 capture manifest에는 값이 기록되지 않는다.

```bash
export SOUL_RUNNER_SOAK_DATABASE_ADMIN_URL='postgresql://.../postgres'
export SOUL_RUNNER_SOAK_CLAUDE_AUTH_TOKEN_PATH='...'
export SOUL_RUNNER_SOAK_CODEX_HOME_PATH='...'
export SOUL_RUNNER_SOAK_AUTH_BEARER_TOKEN='...'
```

`ANTHROPIC_API_KEY`는 사용하지 않으며 staging child env에서도 제거된다.

## 실행

설정 예시를 untracked staging root로 복사해 필요한 포트·시간만 조정한다. live 포트 3105·5200·4205, staging/soak가 없는 DB명, `.local/runner-staging-soak` 밖 상태 경로는 코드가 거절한다. 러너 상태의 실제 바이트는 staging root 아래에 두고, Linux UDS 108-byte 한계를 피하기 위해 `/tmp/soul-runner-soak-<root-hash>` 검증된 짧은 심링크를 주소로 쓴다. 기존 경로가 다른 대상을 가리키면 prepare가 덮지 않고 실패한다.

```bash
pnpm --dir soul-server-ts soak:runner doctor --config soul-server-ts/scripts/staging-soak/config.example.json
pnpm --dir soul-server-ts soak:runner prepare --config soul-server-ts/scripts/staging-soak/config.example.json --confirm-staging-only
pnpm --dir soul-server-ts soak:runner start --config soul-server-ts/scripts/staging-soak/config.example.json --confirm-staging-only
pnpm --dir soul-server-ts soak:runner run --config soul-server-ts/scripts/staging-soak/config.example.json --backend claude --confirm-staging-only
pnpm --dir soul-server-ts soak:runner run --config soul-server-ts/scripts/staging-soak/config.example.json --backend codex --confirm-staging-only
pnpm --dir soul-server-ts soak:runner stop --config soul-server-ts/scripts/staging-soak/config.example.json
```

prepare는 전용 DB가 없을 때 생성하고 공식 `packages/db-schema/scripts/migrate.mjs fresh-install`을 실행한다. 이미 있으면 공식 verify만 실행한다. start는 실제 production entrypoint를 별도 cwd·env·포트로 띄운다. run은 backend별 35분 기본 소크에서 background 임계보다 짧은 8초 셸 호출 20개를 순차 실행하고, 2분 지점에 soul host만 재시작하며 runner PID·실제 생존·socket 보존을 검증한다. 이후 5분마다 intervention을 보낸다. Codex는 라이브와 같은 `app-server` adapter를 쓰되, 복제된 전용 `CODEX_HOME`에 rollout과 로그를 격리한다. stop은 staging pidfile과 `/proc` identity가 모두 맞는 프로세스만 종료한다.

## 수확물

`.local/runner-staging-soak/captures/<run-id>/`에 권한 0600으로 남는다.

- `orch-session-sse.jsonl`: 저장 이력과 live observation frame 전량
- `runner-events.jsonl`: per-session SQLite event ledger
- `runner-ipc-journal.jsonl`: payload 없는 IPC 순서·ACK 증거
- `fixture-candidates.jsonl`: secret·동적 ID·시각을 치환한 중복 제거 후보
- `soak-result.json`: runner 생존, MCP 왕복, 이벤트 타입 수, drop 요약

원본 capture에는 실제 프롬프트·도구 결과가 포함될 수 있으므로 커밋하거나 외부로 전송하지 않는다. fixture 후보도 테스트 편입 전에 사람이 한 번 검수한다.
