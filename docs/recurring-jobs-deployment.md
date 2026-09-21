# 반복 작업 배포와 음악 추천 전환

이 문서는 반복 작업 기능을 릴리스한 뒤, 기존 음악 추천 cron 두 건만 안전하게 옮기는 운영 절차다. 배포와 cron 변경은 릴리스 책임자만 수행한다. 이 PR의 테스트와 검증에서는 음악 추천의 외부 게시를 실행하지 않는다.

## 영향 범위와 정본

| 항목 | 정본 | 영향 |
| --- | --- | --- |
| 영속 설정·회차 이력 | `recurring_jobs`, `recurring_job_runs` | migration `094_recurring_jobs.sql`이 추가하는 테이블·인덱스 |
| 중앙 실행 | `orch-server-ts` | DB 예약 뒤 지정 노드로 고정 session ID의 `create_session`을 한 번만 보냄 |
| MCP | `soul-server-ts` | 신뢰된 caller-session만 host API를 통해 같은 orchestrator 서비스 사용 |
| 웹 | `unified-dashboard` | 설정의 반복 작업 탭 |
| 앱 | `soul-app` 별도 리포 | phone stack 및 wide settings panel |

Migration 094는 additive다. 이전 코드가 새 테이블을 읽지 않아도 기존 세션과 cron은 계속 동작한다. 롤백 때 테이블이나 이력을 지우지 않는다.

## 배포 순서

1. 두 PR을 머지하고 각 CI 결과를 확인한다.
2. 중앙 writer 노드에서 Haniel의 `deploy/release-manifest.json` 릴리스를 한 번 실행한다. 이 릴리스가 writer quiescence, advisory lock, checksum ledger를 소유하며 migration 094를 적용한다. `094_recurring_jobs.sql`을 psql로 직접 실행하지 않는다.
3. 같은 중앙 릴리스가 `soulstream-orch-server`를 먼저, 의존하는 `soulstream-soul-server-ts`를 그 다음 기동하도록 둔다. orchestrator가 새 public·host route와 scheduler를 준비한 뒤 MCP worker가 이를 호출한다.
4. 중앙 release의 migration ledger와 cluster health가 통과한 뒤 dashboard를 배포한다. soul-app은 별도 리포 릴리스이므로 서버와 독립적으로 올릴 수 있지만, 새 앱보다 서버를 먼저 올린다.
5. 필요한 원격 worker는 중앙 서비스가 정상인 뒤 `deploy/release-manifest-worker.json`으로 한 대씩 갱신한다. worker manifest는 DB migration을 수행하지 않는다.

## 배포 후 확인

- migration ledger에 `094_recurring_jobs.sql`과 manifest checksum이 일치한다.
- 인증된 웹과 soul-app에서 비활성 반복 작업을 생성하고 다음 5회 미리보기를 확인한다.
- 신뢰된 Soulstream caller-session의 MCP로 목록 조회와 비활성 작업 생성을 확인한다. public/external/LLM MCP는 계속 거부돼야 한다.
- pause/archive는 queued·waiting 자동 회차를 취소하고, 이미 running인 session을 끝내지 않는지 확인한다.
- `awaiting_session`과 삭제된 session은 기존 고정 session ID와 원인을 보이며 새 session을 자동 생성하지 않는지 확인한다.
- 이 확인에서 음악 추천 job의 수동 실행을 누르지 않는다. 해당 프롬프트는 외부 게시를 수행한다.

## 음악 추천의 staged 등록값

운영 crontab에서 확인한 두 줄의 node, profile, prompt, 결과 폴더를 그대로 옮긴다. `enabled=false`로 먼저 생성하므로 등록 자체는 예약·전송을 만들지 않는다.

| 필드 | 값 |
| --- | --- |
| 이름 | 음악 추천 |
| 작업 내용 | `music-rec 스킬을 사용해줘. gather.py를 실행하고, selected.json을 읽어 소개문을 작성한 뒤, send.py를 실행해줘.` |
| 시간대 | `Asia/Seoul` |
| 반복 cron 배열 | `["0 9 * * 1-5", "0 12 * * 1-5"]` |
| 노드 | `eiaserinnys` |
| 에이전트 | `seosoyoung` |
| 모델 | `null` — 에이전트 기본값 |
| 결과 폴더·컨테이너 | `folder` / `6485fbf1-21e0-406b-83c6-ced8594b0973` |
| 오프라인 지연 허용 | `1800`초 |
| 초기 상태 | `enabled=false` |

이 설정은 평일 09:00·12:00 KST 두 회차를 각각의 cron entry로 계산한다. 다음 5회 미리보기에서 두 시각이 모두 표시되는지 먼저 확인한다.

## 중복 없는 전환

1. 다음 회차와 충분히 떨어진 시점에 위 값을 **비활성** 상태로 생성한다. 생성 응답의 job ID, version, next-run 미리보기, 결과 folder ID를 기록한다.
2. 기존 09:00 또는 12:00 음악 추천 회차가 끝난 직후를 전환 창으로 잡는다. 다음 회차 전까지 기존 cron 두 줄을 그대로 둔다.
3. 진행 중인 기존 음악 추천 session이 끝난 것을 확인한 뒤, crontab에서 음악 추천 오전·오후 두 줄만 함께 비활성화한다. 다른 cron은 변경하지 않는다.
4. 즉시 생성해 둔 job을 `enabled=true`로 CAS version과 함께 갱신한다. 다음 실행이 다음 미래 회차인지, 30분 실행 자격 창을 지난 과거 회차가 아닌지 확인한다.
5. 첫 자동 회차는 수동 실행으로 대체하지 않는다. 이력의 고정 session ID를 열어 결과가 기존 폴더에 생기는지 사용자가 확인한다.

한 회차가 이미 전송된 뒤에는 응답 유실이어도 같은 session ID만 재확인한다. 새 session을 만들거나 같은 cron을 재실행해 복구하지 않는다.

## 롤백

첫 새 자동 회차가 문제를 보이면 다음 회차 전에 아래 순서로 되돌린다.

1. 반복 작업을 `enabled=false`로 일시정지한다. queued·waiting 자동 회차는 취소되지만 이미 running인 session은 종료하지 않는다.
2. 이미 전송된 session은 완료·오류 상태를 기록할 때까지 기다린다. 그 회차를 cron으로 재실행하지 않는다.
3. 다음 미래 회차 전에 기존 crontab의 음악 추천 오전·오후 두 줄을 원문 그대로 복원한다.
4. 반복 job은 보관하지 않고 비활성 상태와 이력을 남긴다. 원인과 session ID를 기록한 뒤 사용자가 다음 전환을 지시할 때만 재개한다.

나머지 cron 이전은 음악 추천 동작을 사용자가 확인한 뒤 별도 지시가 있을 때만 수행한다.
