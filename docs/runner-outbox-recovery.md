# Runner outbox 격리·재생 절차

`runner.sqlite` 복구가 fail-closed한 세션만 대상으로 한다. 도구는 원본 DB를 수정하지 않는다.

## 1. 증거 고정

1. 정상 cancel/reaper 경로로 해당 세션의 러너를 종료한다.
2. `runner.pid`의 PID가 더 이상 살아 있지 않은지 확인한다.
3. 세션 상태 디렉터리 전체를 별도 임시 디렉터리에 복사한다. WAL 모드이므로 `runner.sqlite`, `runner.sqlite-wal`, `runner.sqlite-shm`이 있으면 반드시 함께 복사한다.
4. 복사 전후 원본 파일 크기와 수정시각이 같음을 확인한다. 원본 DB에 SQLite 클라이언트로 접속하지 않는다.

복사본 진단:

```bash
pnpm --dir=soul-server-ts runner-outbox:inspect -- \
  --database /tmp/runner-copy/runner.sqlite \
  --confirm-readonly-copy
```

도구는 payload를 출력하지 않는다. `sessionId`, `streamId`, ACK cursor, 보존 seq 범위와 판정만 출력한다.

## 2. 판정별 처리

### `legacy_unprotected_checkpoint`

schema v5 이하에서 생성된 DB라 ACK cursor에 checkpoint hash가 아직 없다. 복사본 검사기는 cursor를 신뢰하거나 고치지 않는다. 정상 서비스의 writable open만 다음 순서로 v6 마이그레이션한다.

1. 기존 bootstrap·보존 event·미ACK suffix의 구조와 payload hash를 검증한다.
2. 현재 `stream_id`, `session_id`, `acked_through`를 최초 1회 신뢰해 `ack_checkpoint_hash`를 계산한다.
3. 컬럼 추가·hash 기록을 같은 SQLite 트랜잭션에서 commit한 뒤 schema version을 6으로 올린다.

구 schema에는 cursor의 과거 오염 여부를 증명할 별도 정본이 없으므로 이 최초 seed 이전의 무결성은 소급 보장하지 않는다. v6로 승격한 뒤에는 모든 cursor read가 hash를 검증하고, ACK 갱신은 cursor/hash를 한 UPDATE와 같은 트랜잭션의 재검증으로 결박한다. 마이그레이션 전 복사본은 보존한다.

### `compacted_acknowledged_prefix`

ACK 이하 삭제 구간만 있는 정상 compaction이다. 상태 디렉터리를 격리하거나 DB를 고치지 않는다. 이 검증 오류를 수정한 빌드에서 같은 세션을 다시 실행하면 기존 stream과 cursor로 재개된다.

### `quarantine_required`

미ACK 구간, bootstrap, stream/session, payload hash, ACK checkpoint hash 가운데 하나가 손상됐다. 자동 완화하지 않는다.

1. 복사본과 원본 상태 디렉터리를 보존한다.
2. DB의 `backend_session_id`와 중앙 세션 저장소의 backend session ID가 일치하는지 확인한다. 둘 중 하나라도 없거나 다르면 재생하지 않고 세션을 명시적 error로 종결한다.
3. 러너 PID가 죽어 있음을 다시 확인한 뒤 상태 디렉터리 전체를 runner-state 밖의 격리 디렉터리로 원자 이동한다. 미ACK 이벤트 손실 수용은 운영자가 명시적으로 기록한다.
4. 같은 agent session에 intervention/resume을 보낸다. 중앙 세션 저장소의 backend session ID가 execute command의 `resumeSessionId`가 되고, 러너는 새 상태 디렉터리·새 SQLite stream을 만든다.
5. 새 stream이 terminal ACK에 도달할 때까지 격리본을 삭제하지 않는다. orch receipt와 클라이언트 이벤트를 대조해 중복·누락을 별도 기록한다.

DB 행을 수기로 삽입하거나 `sqlite_sequence`를 낮추는 복구는 금지한다. 누락 payload를 복원할 정본이 없고, 기존 orch receipt 계보와 충돌하기 때문이다.

## 3. `ambiguous_intervention` 해소

개입을 backend에 전달한 뒤 성공 여부를 확정하기 전에 실행이 실패하면 러너는 개입을 `ambiguous`로 정지시킨다. 자동 재실행은 사용자 입력과 tool side effect를 중복 적용할 수 있으므로 금지한다. 로그의 `ambiguous_intervention` 오류와 보존한 상태 디렉터리를 근거로 운영자가 다음 둘 중 하나를 명시적으로 선택한다.

- `applied`: backend transcript나 이벤트에서 개입 적용을 확인했다. inbox 행을 삭제하고 재생하지 않는다.
- `not_applied`: backend에 개입이 적용되지 않았음을 확인했다. claim을 지우고 pending으로 한 번 재큐잉한다.

먼저 정상 cancel/reaper 경로로 해당 러너를 멈추고, `runner.pid`와 DB lifecycle에 기록된 모든 PID가 죽었는지 확인한다. 상태 디렉터리 전체를 WAL 파일과 함께 복사해 증거를 고정한 뒤 원본 DB에 아래 관리 명령을 실행한다. 명령은 배타적 `runner.lock`을 선점해 해소 도중 새 러너가 시작되지 못하게 하고, 기록된 PID가 하나라도 살아 있으면 변경을 거부한다.

적용 확인 후 삭제:

```bash
pnpm --dir=soul-server-ts runner-intervention:resolve -- \
  --database /path/to/session/runner.sqlite \
  --intervention-id <intervention-id> \
  --resolution applied \
  --confirm-runner-stopped
```

미적용 확인 후 재큐잉:

```bash
pnpm --dir=soul-server-ts runner-intervention:resolve -- \
  --database /path/to/session/runner.sqlite \
  --intervention-id <intervention-id> \
  --resolution not_applied \
  --confirm-runner-stopped
```

출력에는 payload가 없고 DB 경로, intervention ID, 선택한 판정만 남는다. `not_applied`를 선택한 경우에만 같은 세션을 resume/intervene하여 pending 개입을 소비시킨다. 새 실행이 terminal ACK에 도달하기 전에는 증거 복사본을 삭제하지 않는다. 판정 근거를 확보하지 못했으면 `ambiguous` 상태를 유지하고 자동 재실행하지 않는다.
