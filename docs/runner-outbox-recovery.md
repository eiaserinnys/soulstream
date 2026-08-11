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

### `compacted_acknowledged_prefix`

ACK 이하 삭제 구간만 있는 정상 compaction이다. 상태 디렉터리를 격리하거나 DB를 고치지 않는다. 이 검증 오류를 수정한 빌드에서 같은 세션을 다시 실행하면 기존 stream과 cursor로 재개된다.

### `quarantine_required`

미ACK 구간, bootstrap, stream/session, payload hash 가운데 하나가 손상됐다. 자동 완화하지 않는다.

1. 복사본과 원본 상태 디렉터리를 보존한다.
2. DB의 `backend_session_id`와 중앙 세션 저장소의 backend session ID가 일치하는지 확인한다. 둘 중 하나라도 없거나 다르면 재생하지 않고 세션을 명시적 error로 종결한다.
3. 러너 PID가 죽어 있음을 다시 확인한 뒤 상태 디렉터리 전체를 runner-state 밖의 격리 디렉터리로 원자 이동한다. 미ACK 이벤트 손실 수용은 운영자가 명시적으로 기록한다.
4. 같은 agent session에 intervention/resume을 보낸다. 중앙 세션 저장소의 backend session ID가 execute command의 `resumeSessionId`가 되고, 러너는 새 상태 디렉터리·새 SQLite stream을 만든다.
5. 새 stream이 terminal ACK에 도달할 때까지 격리본을 삭제하지 않는다. orch receipt와 클라이언트 이벤트를 대조해 중복·누락을 별도 기록한다.

DB 행을 수기로 삽입하거나 `sqlite_sequence`를 낮추는 복구는 금지한다. 누락 payload를 복원할 정본이 없고, 기존 orch receipt 계보와 충돌하기 때문이다.
