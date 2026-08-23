# 실행 턴 1급 상태기계 재설계

기준 커밋: `e5d66742` (2026-08-23, PR #819 포함)

상태: 설계 3차. 2차 독립 검증 P0 7건과 3차 재검증 P0 4건을 반영했다. 제품 코드, DB 마이그레이션, 배포는 이 문서의 범위가 아니다.

## 판정 기준

이 설계의 성공 조건은 하나다.

> 사용자와 실행 중인 에이전트는 서버 재시작을 알 수 없어야 한다. 대시보드가 내려가는 것과 전달이 보장된 지연만 허용한다. 오류, 503, 재시도 요구, 턴 중단, 응답 누락, 중복, 컨텍스트 유실은 모두 실패다.

따라서 “실패를 정직하게 알렸다”, “큐에 넣었다고 알려 줬다”, “다시 보내면 된다”는 수용되지 않는다. 정상 경로와 재기동 경로가 같은 입력 승인 계약, 같은 출력 스트림, 같은 최종 결과를 사용해야 한다.

## 설계 결정 요약

현재 결함의 뿌리는 러너가 아니라 **실행 중인 한 턴을 나타내는 1급 개념의 부재**다. 다음 여덟 결정을 함께 적용한다.

1. `Task`의 실행 관련 optional 필드 12개를 항상 존재하는 `execution: TaskExecutionController` 한 필드로 바꾼다.
2. 실행은 `idle`, `reserved`, `provisional`, `activating`, `active`, `awaiting_external_input`, `recovering`, `terminating`, `terminal`의 판별 유니온이다. provisional spawn은 활성화 전이라도 이미 실행이고, 사람 입력을 기다리는 상태도 살아 있는 실행이다.
3. 획득은 `begin()`에서, 해제는 `terminate()`에서만 일어난다. 필드 삭제는 상태 전이가 아니다.
4. dispatcher의 접속 수명과 실행 수명을 분리한다. `detachHost()`는 접속만 반납하며 실행을 종료하거나 스트림을 실패시키지 않는다.
5. 중앙 DB의 열린 실행 inventory를 주기 스캔의 출발점으로 삼는다. 등록 디렉터리는 증거이지 inventory가 아니다.
6. 모든 사용자 입력은 먼저 durable delivery로 승인한 뒤 정확한 `executionId`에 할당한다. 호출자에게는 정상·복구 여부와 무관하게 같은 `accepted` 응답만 반환한다.
7. user-visible 실행은 `in_process`로 폴백하지 않는다. durable admission 뒤 semantics v2 독립 runner가 준비될 때까지 기다리며, 기다림을 오류나 503으로 바꾸지 않는다.
8. host의 종료 의도와 runner의 durable terminal 증명을 분리한다. 출력과 terminal witness가 먼저 durable해지고 그 receipt를 확인한 뒤에만 중앙 visible terminal을 commit한다.

## 확인된 사실과 설계에 미친 영향

### 코드와 사고 표본

- `Task`의 실행 상태는 현재 12개 optional 필드에 흩어져 있다 (`soul-server-ts/src/task/task_models.ts:382`).
- 실행 획득의 사실상 정본은 `startOwnedExecutionLocked()`이지만 예약, spawn, proof, activation을 로컬 변수와 Task 필드에 나눠 기록한다 (`soul-server-ts/src/task/task_executor.ts:417`).
- `attachRunner()`는 러너와 dispatcher를 원자적으로 붙이지만 대응하는 단일 detach 경계가 없다 (`soul-server-ts/src/task/task_executor.ts:1666`).
- dispatcher는 `closed: boolean`, `activeExecuteCommandId`, `activeStream`을 별개로 가진다 (`soul-server-ts/src/runner/runner_process_dispatcher.ts:159`). 종료 진입점은 `close`, `detachHost`, rollback, reconnect exhaustion, `execution_ended`로 갈라져 있다 (`runner_process_dispatcher.ts:313`, `:370`, `:942`, `:1045`).
- `ProcessFrameStream.finish()`와 `fail()`은 서로를 배제하지 않아 늦은 실패가 첫 실패를 덮을 수 있다 (`soul-server-ts/src/runner/runner_process_frame_stream.ts:28`).
- 복구 스캔은 등록 디렉터리 스캔으로 시작한다 (`soul-server-ts/src/runner/runner_recovery_coordinator.ts:161`). 반면 열린 실행의 중앙 정본은 `session_execution_ownerships`에 있다 (`packages/db-schema/sql/schema.sql:2470`).
- delivery attempt는 이미 별도 테이블이지만 실행 identity를 저장하지 않는다 (`packages/db-schema/sql/schema.sql:3264`).
- 재기동 중 개입의 외부 경계는 지금 node WebSocket 단절과 timeout을 503으로 노출한다 (`orch-server/src/soulstream_server/api/sessions.py:370`, `:408`).
- `TaskExecutor.startExecution()`은 execution ownership을 지원하지 않는 경로에서 독립 runner factory가 없으면 `createInProcessTaskRunnerRuntime()`로 폴백한다 (`soul-server-ts/src/task/task_executor.ts:277`). 과거 실제 사용자 실행 5건이 이 경로를 탔으므로 “현재 0건”은 제거 근거가 아니다.
- 외부 입력 대기는 이미 실행 상태다. Agents는 `awaiting_approval`을 반환하고 durable approval request를 만든다 (`task_turn_loop_transition.ts:12`, `agents_adapter.ts:215`, `task_tool_approval_recovery.ts:73`). Claude `AskUserQuestion`도 같은 수명 문제를 가진다. 이 둘은 progress도 tool lease도 아니므로 별도 phase가 없으면 정상적인 사람 대기를 stalled execution으로 오판한다.
- 외부 입력은 하나로 제한되지 않는다. Claude는 request별 `Map`을 유지하고 (`claude_adapter.ts:517`), Agents도 실행 중 복수 approval을 등록할 수 있다 (`agents_adapter.ts:215`). Claude `AskUserQuestion`의 기본 만료는 300,000ms이고, 만료 뒤 같은 request의 늦은 응답은 `expired`다 (`claude_sdk_client.ts:42`, `claude_adapter.test.ts:655`).
- ownership proof 뒤에도 실행은 아직 active가 아니다. `task_executor.ts:495`의 proof commit 다음에는 `prepareSession`과 activation ACK가 남으므로, 그 사이 crash를 durable `activating`으로 복원해야 한다.
- 현행 runner-origin terminal 순서는 lifecycle terminal commit 뒤 `execution_ended` control frame을 보내고 host가 pending outbox를 replay한 뒤 stream을 닫는다 (`runner_child_runtime.ts:292`, `runner_process_dispatcher.ts:694`). `execution_ended` 자체는 outbox frame이 아니므로 중앙 terminal보다 앞선 출력 durability/receipt 계약이 별도로 필요하다.
- owner-null backfill은 stable identity면 `adopted_runner`, 아니면 session을 `interrupted`로 바꾼다 (`packages/db-schema/sql/schema.sql:3134`, `:3229`). 후자는 투명성 판정 기준에 정면으로 어긋난다.
- 260823 사고 표본에서는 runner lifecycle이 `failed`였고 등록이 사라졌는데도 중앙 ownership과 host 실행 대기가 남았다. runner를 죽인 뒤에도 새 reserve가 없으므로 회수가 시작되지 않았다. 두 intervention은 옛 command에 `claimed`로 남았고, attempt 소진 delivery는 `uncertain`에서 다시 스캔되지 않았다.

### 읽은 입력 정본

| 입력 | 이 문서에서 사용한 계약 |
| --- | --- |
| `.local/artifacts/260822-runner-subsystem-review.md` | 일곱 부분 표현, optional 12개, 해제 9곳, P0 5건, 재설계 2-1·2-2·2-3 |
| `origin/test/runner-execution-invariants:docs/runner-execution-invariants.md` | 실행 불변식 16개, runner-death·activation rollback 영구 RED |
| `744ea525:docs/delivery-execution-invariants.md` | delivery 불변식 10개, `result_unknown`과 retry cadence 소진의 분리 |
| 업무 항목 `02fe8079`, `7bdd378c`, `d38daa1d`, `d211daf4` | 실행 규율, 260823 실사고, P0 5건, reserve에 편재한 회수 트리거 |
| 260823 사고 표본 | host DB ownership, runner lifecycle·journal, delivery snapshot, 시간순 로그의 상호 불일치 |
| #818 독립 검수 | 2-1 fixture 파급, 2-2·2-3 저항도, terminal·supersession·closed 분기의 테스트 공백 |

### #818 구조 전환 실측

| 전환 | 기존 green 중 RED | 설계 판단 |
| --- | ---: | --- |
| 2-1 `TaskExecution` 판별 유니온 | 1 | adoption shared fixture를 새 factory로 바꾸면 8개 계약이 유지된다. 옛 필드 형태 자체를 기대하는 1개는 구조 화석이라 제거한다. |
| 2-2 단일 terminal state | 0 | 즉시 적용 가능한 저저항 경계다. 첫 terminal 신호 보존 RED도 구조 전환만으로 green이 됐다. |
| 2-3 `DispositionPolicy` 결정표 | 0 | 37개가 모두 통과했다. “기존 disposition 테스트가 결정표를 막는다”는 가설은 실측으로 폐기한다. |

adoption 10개 중 9개가 shared fixture를 통해 `runner` 또는 `executionPromise`에 의존하고, 그중 8개는 fixture 변환만으로 계약을 보존한다. cleanup 4개는 Task 필드에 의존하지 않는다. fixture 경계는 `createTaskExecutionFixture(state)` 하나로 통합하며 제품 factory와 같은 controller 생성기를 사용한다.

추가로 다음 테스트 공백을 구조로 닫는다.

- `runner_adoption_failure_recovery.ts:300`의 supersession은 promise 존재 비교가 아니라 `executionId`와 generation 비교가 된다.
- `runner_recovery_disposition.ts:118`의 refreshed `closed` 분기는 결정표가 action을 반드시 반환하고, action executor가 결과 receipt를 반드시 기록하게 한다. silent return 타입은 없다.
- 등록 소멸 뒤 bounded waiter timeout은 중앙 열린 실행 inventory가 항상 reconcile 대상이 되므로 발생하지 않는다.
- `fail → fail`을 포함한 모든 terminal 조합은 first-signal CAS 하나가 처리한다.
- disposition 목록 배열 대신 `Record<RunnerRecoveryDisposition, DispositionPolicy>`를 사용하여 새 variant 누락을 컴파일 오류로 만든다.

기존 관련 테스트 62개는 명세 28, 현재 동작 기록 32, 구조 화석 2로 분류한다. 명세 28은 유지하고 구조 화석 2는 제거한다. 현재 동작 기록 32 중 아래 정책값과 맞닿은 것은 의도적으로 재기준화한다. 이 RED는 회귀가 아니다.

| 바뀌는 정책값 | 기존 | 새 정책 |
| --- | --- | --- |
| reconnect budget 소진 | active stream 실패 후 필드 정리 | `recovering` 전이와 자력 reconcile 요청. 외부 stream은 실패하지 않는다. |
| host detach | 실행 close와 같은 `closed=true` | attachment만 반납. 실행은 계속 active/recovering이다. |
| supersession | runner/promise 존재와 객체 동일성 | `executionId + ownershipGeneration`의 단일 비교다. |
| refreshed disposition 변화 | 분기별 silent return 가능 | 새 disposition의 결정표 action을 즉시 실행하거나 durable wake를 예약한다. |
| terminal 경합 | 마지막 `fail()`이 보일 수 있음 | durable first terminal signal만 보인다. |
| attempt budget 소진 | `uncertain` 또는 `dead_letter` | `retry_paused`; 책임은 계속 남는다. |
| queued CAS miss | 예외가 503으로 투영될 수 있음 | canonical delivery를 재조회하여 accepted 상태면 성공을 반환한다. |
| 등록 디렉터리 없음 | 스캔 대상 없음 | 열린 execution의 `registration_missing` 증거다. |

### #818 재현 기준

재현 anchor는 PR #818 head `f4c29e26605c8da1833c2ee8519e6a8cf74a7314`다. 구조 probe는 검수 세션에서 임시 삽입 후 원복했으므로 제품 commit으로 오인하지 않는다. 다음 명령이 공통 기준선이며, probe별로 아래 한 가지 구조 변화만 적용한 뒤 같은 명령을 다시 실행한다.

```bash
flock /tmp/soulstream-heavy-verify.lock -c \
'timeout 300s pnpm --dir soul-server-ts exec vitest run \
tests/runner/runner_adoption_failure_recovery.test.ts \
tests/runner/runner_recovery_disposition.test.ts \
tests/runner/runner_process_frame_stream.test.ts \
tests/runner/runner_host_resource_cleanup.test.ts \
--minWorkers=1 --maxWorkers=2'
```

| probe | 고정할 변화 | 실행 범위 | 재현 결과 |
| --- | --- | --- | --- |
| 2-1 | `runner_recovery_disposition.ts`의 `runnerTerminalFact` write 한 줄만 제거한다. adoption fixture 변환은 이 probe와 섞지 않는다. | `runner_recovery_disposition.test.ts` | `1 failed / 36 passed / 2 skipped`; 옛 field를 기대하는 green 1건 실증 |
| 2-2 | `ProcessFrameStream`의 `ended/error`를 `{ phase: "open" } \| { phase: "terminal"; signal }`로 교체하고 첫 terminal만 CAS한다. | `runner_process_frame_stream.test.ts` | 기존 green 파단 0, `7 passed / 2 skipped`; first-terminal RED 활성화 시 `8 passed / 1 skipped` |
| 2-3 | `satisfies Record<RunnerRecoveryDisposition, DispositionPolicy>`를 넣고 helper·재검증 action을 표에서 구동한다. | `runner_recovery_disposition.test.ts` | 기존 green 파단 0, `37 passed / 2 skipped` |

adoption fixture 파급은 같은 anchor에서 다음 정적 명령으로 재현한다.

```bash
rg -n 'runner|executionPromise' soul-server-ts/tests/runner/runner_adoption_failure_recovery.test.ts
rg -n 'runner|executionPromise' soul-server-ts/tests/runner/runner_host_resource_cleanup.test.ts
```

adoption 10건 중 9건이 shared fixture를 경유하고 8건은 새 union factory로 계약을 유지할 수 있으며, stopped recovery 1건만 옛 field 존속 자체를 기대한다. cleanup 4건은 Task field 의존이 없다.

공통 원복 기준선은 `57 passed / 5 skipped (62)`다. 이 결과와 임시 probe의 전문은 검수 세션 `a61882fe-2d5a-4a79-a6f0-75816efbb2ca`에 남아 있다. 영구 재현 테스트를 작성하는 다음 단계에서는 임시 patch가 아니라 2-1 fixture factory, 2-2 terminal union, 2-3 decision table을 각각 test-only harness로 고정한다.

### 정상·재시작 랩 실측

랩 기준은 `test/lab-steady-restart-invariants`의 `a115a29a267e8abcd440ebc7ae567d9d4852ac9f`다. GREEN은 설계의 근거가 아니라 현재 동작의 부수 결과이고, RED는 이 설계가 없애야 할 외부 관측이다.

| 관측 행 | ① steady-state | ② restart-adopt | ③ restart-intervention-window |
| --- | --- | --- | --- |
| 시작 조건 | 일반·개입 모두 실제 90초 tool 실행 | 실제 tool 실행 중 host만 재시작 | `PgSleep`으로 복구 창을 확인한 뒤 개입 1회 |
| 실행 identity | 정상 runner command | runner PID `2586721`, manifest·환경·code SHA 유지 | 중앙 delivery는 생성됐지만 host bind가 끝나지 않음 |
| host 변화 | 없음 | ownership만 `runner_process → adopted_runner` | adoption 전 node command 경로 진입 |
| caller 결과 | 일반 입력 정상, 개입 `accepted/queued_for_next_turn` | 정상 경로와 차이 `[]` | `rejected/HTTP 503 NODE_COMMAND_REJECTED` |
| 의미 event 순서 | 일반: 입력→tool→응답. 개입: `user_message → tool_start → intervention_sent → tool_result → 개입이 반영된 단일 assistant_message` | ① 일반 경로와 차이 `[]` | 기준선의 `intervention_demand`와 `context_reply`가 모두 0회 |
| delivery 정산 | 개입 `consumed`, receipt와 caller turn이 같은 event에 연결 | 누락·중복 없음 | 180초 뒤에도 `queued/pending`, receipt·caller turn 없음 |
| 최종 판정 | GREEN, 계약 차이 `[]` | GREEN, 계약·구조 차이 `[]` | RED, 503 + 개입 유실 + 후속 응답 없음 |

별도 `runner-death-live-host`도 runner 종료 뒤 후속 요청에 HTTP 503 `runner registration identity incomplete`를 노출해 RED다. 즉 재시작 자체의 기본 adopt 경로는 이미 투명하고, 재설계의 직접 공략 표면은 **복구 완료 전 입력 창, runner 소실 회수, terminal/output durability 경계**다.

### 새 구조의 예상 행 단위 trace

위 표는 PR #819가 고정한 **현재 구현의 실측**이다. 다음 표는 v2 구조가 세 시나리오 모두에서 만들어야 하는 **동일한 외부 계약**이다. 내부 host phase만 다르고 caller ACK와 semantic event 열은 같아야 한다.

| 순서 | 관측 경계 | ① steady-state | ② restart-adopt | ③ restart-intervention-window |
| ---: | --- | --- | --- | --- |
| 1 | caller identity | 첫 send 전에 action UUID를 생성하고 payload hash와 고정 | 같은 action UUID를 생성 | 같은 action UUID를 생성 |
| 2 | durable admission | `session_accept_input_v2`가 delivery와 idempotency receipt commit | 동일 | host 복구 전이라도 동일하게 commit |
| 3 | caller ACK | `{ status: "accepted", deliveryId }` | 동일 | 동일. 503·retry 요구 없음 |
| 4 | execution bind | session head를 현재 `executionId/executionCommandId`에 bind | adopt가 보존한 같은 execution/command에 bind | recovering 중 queued; attach 또는 active-v1 승격 receipt 직후 **같은 열린 command**에 bind |
| 5 | runner input | `runnerInputSequence=N` inbox receipt 뒤 consume | 동일 | 복구 대기만 늘고 동일 receipt |
| 6 | semantic event | `user_message → tool_start → intervention_sent → tool_result → 개입이 반영된 단일 assistant_message` | 동일 순서·event id dedupe | 동일 순서·event id dedupe. `intervention_demand/context_reply` 소실 없음 |
| 7 | delivery 정산 | `consumed`, attempt와 input receipt가 동일 execution을 가리킴 | 동일 | 동일. `queued/pending` 영구 잔류 없음 |
| 8 | caller 재조회·재전송 | 같은 delivery receipt를 반환 | 동일 | admission 응답 전에 orch가 죽어도 같은 stable ID로 동일 receipt 반환 |

③의 내부 trace는 `accepted → queued(recovering) → host capability 확인 → attachment/adoption 또는 active-v1 in-place promotion → bind → consumed`다. 이 내부 phase와 대기 시간은 ACK·session status·agent stream에 투영하지 않는다. 이 표의 행 3·6·7이 PR #819 transparency oracle의 비교 대상이고, 세 열의 값이 다르면 v2 cutover를 열지 않는다.

### 2차 검증 지적 폐쇄표

| 지적 | 확정 설계 | 구조적 fence |
| --- | --- | --- |
| P0-1 in-process fallback | v2 user-visible 실행은 durable admission 뒤 독립 runner placement를 기다림 | `executor_kind` CHECK + runner capability + v2 input type |
| P0-2 external input phase 누락 | approval·AskUserQuestion request 집합을 `awaiting_external_input`으로 durable 표현 | union variant + non-empty request phase CHECK + progress suspension |
| P0-3 caller delivery ID 부재 | caller 8계열의 생성·보존·전달 계약을 v2 선행 단위로 배치 | required `delivery_id` + payload hash receipt + ingress capability |
| P0-4 terminal durability 순서 | host intent와 runner outcome 분리, outbox/witness→receipt→visible terminal | runner witness CAS + receipt FK + 중앙 first-signal CAS |
| P0-5 owner-null interrupt | `recovering(identity_unresolved)`가 adopt 또는 atomic replacement로 수렴 | DB phase/subject CHECK + reconcile job + replacement procedure |
| P0-6 rolling 정본 충돌 | row semantics version별 writer와 routing을 분리 | v1→v2 DB write 거부 + capability lease + legacy read projection |
| P0-7 깨지는 중간 배포 | executor·attachment·delivery를 inactive gate 뒤에서 완성 후 ACK를 한 번에 전환 | cutover epoch CAS; attachment가 ingress보다 선행 |
| P1 event·lease·scenario·invariant | backend semantic adapter, 30분 두 lease, 3종 행 trace, DB 제약 승격 | exhaustive adapter/Record + DB CHECK/FK/head pointer |
| P2 identity 단위 혼동 | execution=multi-turn command 수명, input sequence=각 개입·응답 | branded identity + attempt/receipt FK |

### 3차 재검증 지적 폐쇄표

| 지적 | 확정 설계 | 구조적 fence |
| --- | --- | --- |
| P0-1 external input 수명 | request id별 non-empty 집합, 응답·만료·취소 receipt, terminating activity 보존 | branded collection + JSON key CHECK + request resolution CAS + cleanup receipt |
| P0-2 memory/durable phase 불일치 | v2 non-idle phase 이름을 동형화하고 `identity_proven`은 v1 projection으로만 유지 | phase별 child/proof/activation/request DB CHECK |
| P0-3 active v1 cutover | exact runner를 같은 execution/command로 in-place 승격하고 head delivery를 compatibility bind | 단일 promotion procedure + attachment/write epoch fence + deterministic input UUID |
| P0-4 live migration 불가 | nullable additive → v1 writer fence → 6,319행 backfill → open job backfill → CHECK validate → NOT NULL | compatibility procedure + validation query + FK/job count |
| P1 expected trace·settle bound·deadline | 현재 실측과 별도 v2 예상 trace, 5초 scan/15초 grace/60초 capacity, Claude 300초 유지 | transparency oracle + durable wake + deadline receipt CAS |

## 시스템 그림

### A. 진입 경로 매트릭스

| # | 진입 | 현재 조립 위치 | 새 구조의 첫 호출 | 실행 identity |
| ---: | --- | --- | --- | --- |
| 1 | 최초 턴 | `task_executor.ts:374` | `task.execution.begin({ entryPath: "initial" })` | begin 전에 생성한 `executionId` |
| 2 | 자동 재개 | `task_auto_resume_transition.ts:67` | durable input 승인 후 `begin({ entryPath: "auto_resume" })` | 새 `executionId`, delivery는 activation 뒤 할당 |
| 3 | live runner adopt | `task_executor.ts:723` | `beginRecovery({ method: "adopt" })` | 중앙 open execution의 기존 `executionId` |
| 4 | offline terminal replay | `task_executor.ts:788` | `beginRecovery({ method: "offline_replay" })` | runner witness와 중앙 row가 가리키는 기존 `executionId` |
| 5 | replacement | `task_executor.ts:1030` | terminal 확정 뒤 새 `begin({ entryPath: "replacement" })` | 앞 실행과 다른 새 `executionId` |
| 6 | 주기 회수 | `runner_recovery_coordinator.ts:161` | `reconcile(openExecution)` | 중앙 inventory row의 `executionId` |
| 7 | 개입·응답·interrupt | `task_intervention_route.ts:136`, `sessions.py:370` | `delivery.accept()` | 승인 시 unassigned, active transition 뒤 exact execution에 bind |

### B. 전달 경로

```text
사용자·에이전트 입력
  → caller stable delivery id + silent transport retry
  → orch durable admission + idempotency receipt
  → session FIFO delivery ledger (아직 unassigned 가능)
  → 중앙 open execution inventory
  → TaskExecutionController 활성화
  → delivery attempt를 executionId + commandId에 bind
  → runner durable input inbox
  → engine turn
  → runner event/host-call journal
  → event ingress의 dedupe receipt
  → dashboard·호출자 replay
```

정상 경로도 반드시 이 흐름을 탄다. “runner가 붙어 있으면 바로 보내고, 없으면 큐”라는 이중 경로를 두지 않는다. 차이는 bind와 소비까지 걸린 시간뿐이며, 외부 ACK는 항상 durable admission receipt다.

### C. 사용자 관측 위치

| 관측 위치 | 정상·재기동 공통 계약 | 숨겨야 할 내부 상태 |
| --- | --- | --- |
| 개입 API·MCP·cross-node ACK | `{ status: "accepted", deliveryId }` | queued, recovering, node disconnected, retry count |
| 채팅 출력 | event id 순서의 정확히 한 번 replay | dispatcher reconnect, adopt, offline replay |
| 실행 중 에이전트의 host call | 같은 correlation id의 최종 응답 | host attachment 교체, 소켓 단절 |
| AskQuestion·tool result 응답 | durable input receipt 뒤 동일 ACK | 복구 전 대기, 실행 bind 지연 |
| 세션 최종 상태 | 첫 terminal outcome 한 번 | 중복 terminal 신호, cleanup 실패 재시도 |

### D. 동시 갱신 점검표

| 변경 | 동시에 갱신할 정본 |
| --- | --- |
| 실행 phase 추가 | `TaskExecution` union, transition table, durable row constraint, recovery `Record`, exhaustive transition tests |
| 실행 identity 필드 추가 | 중앙 execution row, runner bootstrap witness, frame semantic validator, delivery attempt ref, test fixture factory |
| terminal outcome 추가 | `ExecutionTerminalSignal`, DB constraint, `ProcessFrameStream`, Task/session projection, delivery reconciliation |
| 새 입력 종류 추가 | orch admission, delivery payload schema, FIFO binder, runner inbox, consumption receipt |
| 새 progress 종류 추가 | semantic progress classifier 한 곳, runner lifecycle witness, 중앙 progress projection, lease tests |

## 1급 타입 정의

다음은 구현 목표 시그니처다. 타입 이름과 필드 의미는 계약이며 실제 구현 단계에서 임의로 optional로 약화하지 않는다.

```ts
type ExecutionId = string & { readonly __brand: "ExecutionId" };
type DeliveryId = string & { readonly __brand: "DeliveryId" };
type ExecutionCommandId = string & { readonly __brand: "ExecutionCommandId" };
type ExternalRequestId = string & { readonly __brand: "ExternalRequestId" };
type IsoDateTime = string & { readonly __brand: "IsoDateTime" };

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface SerializedCommandSlot<T> {
  readonly state: "idle" | "running" | "settled";
  run(command: () => Promise<T>): Promise<T>;
  settle(reason: ExecutionTerminalSignal): void;
}

interface ExecutionKey {
  sessionId: string;
  executionId: ExecutionId;
  ownershipGeneration: number;
  entryPath: "initial" | "auto_resume" | "adopt" | "replacement";
  createdAt: IsoDateTime;
}

interface ExecutionReservation {
  key: ExecutionKey;
  semanticsVersion: 2;
  executor: {
    kind: "independent_runner";
    requiredCapability: "execution_semantics_v2";
    placement: "waiting" | "assigned";
  };
  manifestId: string;
  runtimeEnvIdentity: string;
  reservationExpiresAt: IsoDateTime;
  terminalProjectionFence:
    | { kind: "none" }
    | { kind: "expected_terminal_event"; eventId: number };
}

interface SpawnedChildProof {
  registrationId: string;
  pid: number;
  startIdentity: string;
  executionCommandId: ExecutionCommandId;
}

interface ExecutionOwnership extends ExecutionReservation, SpawnedChildProof {
  activatedAt: IsoDateTime;
}

type ExecutionProgressKind =
  | "assistant_message"
  | "thinking"
  | "tool_result";

type LastSemanticProgress =
  | { state: "not_observed"; leaseStartedAt: IsoDateTime }
  | {
      state: "observed";
      sequence: number;
      kind: ExecutionProgressKind;
      progressedAt: IsoDateTime;
    };

interface ExecutionProgress {
  lastSemantic: LastSemanticProgress;
  progressLeaseExpiresAt: IsoDateTime;
  inFlightTools: ReadonlyArray<{
    toolUseId: string;
    startedAt: IsoDateTime;
    absoluteLeaseExpiresAt: IsoDateTime;
  }>;
}

type ExternalRequestDeadline =
  | { kind: "none" }
  | { kind: "at"; expiresAt: IsoDateTime; policy: "claude_ask_user_300s" };

type PendingExternalInput =
  | {
      kind: "tool_approval";
      requestId: ExternalRequestId;
      approvalId: string;
      toolName: string;
      requestedAt: IsoDateTime;
      deadline: { kind: "none" };
    }
  | {
      kind: "ask_user_question";
      requestId: ExternalRequestId;
      inputRequestId: string;
      requestedAt: IsoDateTime;
      deadline: Extract<ExternalRequestDeadline, { kind: "at" }>;
    };

declare const nonEmptyExternalRequestSet: unique symbol;

interface PendingExternalRequestSet {
  readonly [nonEmptyExternalRequestSet]: true;
  readonly size: number;
  get(requestId: ExternalRequestId): PendingExternalInput | undefined;
  entries(): ReadonlyArray<readonly [ExternalRequestId, PendingExternalInput]>;
}

type ExternalRequestResolution =
  | { kind: "responded"; deliveryId: DeliveryId; resolvedAt: IsoDateTime }
  | { kind: "expired"; expiredAt: IsoDateTime }
  | { kind: "cancelled"; cancelledAt: IsoDateTime; reason: "request_owner" | "user" }
  | { kind: "execution_terminated"; terminatedAt: IsoDateTime; terminalSignalId: string };

declare const externalRequestResolutionReceipt: unique symbol;

interface ExternalRequestResolutionReceipt {
  readonly [externalRequestResolutionReceipt]: true;
  executionId: ExecutionId;
  requestId: ExternalRequestId;
  resolution: ExternalRequestResolution;
  proof:
    | { kind: "runner_journal"; sequence: number }
    | { kind: "termination_cleanup"; cleanupReceiptId: string };
  committedAt: IsoDateTime;
}

type ExternalRequestInventory =
  | { state: "empty" }
  | { state: "open"; requests: PendingExternalRequestSet };

type ExecutionActivity =
  | {
      kind: "foreground";
      progress: ExecutionProgress;
      externalRequests: { state: "empty" };
    }
  | {
      kind: "awaiting_external_input";
      progress: ExecutionProgress;
      externalRequests: Extract<ExternalRequestInventory, { state: "open" }>;
      progressReaping: "suspended";
    };

interface ExecutionWaiters {
  activation: Deferred<void>;
  terminal: Deferred<ExecutionTerminalRecord>;
  interrupt: SerializedCommandSlot<boolean>;
}

interface ExecutionInputSet {
  assignedDeliveryIds: ReadonlySet<DeliveryId>;
  nextExpectedEnqueueSequence: bigint;
}

interface RunnerHostResourceLedger {
  readonly executionId: ExecutionId;
  readonly attachmentEpoch: number;
  readonly requestLifetimes: ReadonlyMap<string, AbortController>;
  readonly frameHandlers: ReadonlySet<Promise<void>>;
  readonly pumpRegistration: EventOutboxPumpRegistration;
  readonly runnerObservation: RunnerOperationObservation;
  readonly parentOutbox: RunnerParentOutbox;
  releaseAttachment(): Promise<ExecutionCleanupStep[]>;
}

interface LiveRunnerAttachment {
  kind: "live_runner";
  runner: TaskRunnerRuntime;
  dispatcher: RunnerProcessDispatcher;
  eventStream: ProcessFrameStream;
  hostResources: RunnerHostResourceLedger;
}

interface OfflineReplayAttachment {
  kind: "offline_replay";
  runner: TaskRunnerRuntime;
  dispatcher: RunnerProcessDispatcher;
  eventStream: ProcessFrameStream;
  hostResources: RunnerHostResourceLedger;
}

type ExecutionRecoveryHandle =
  | {
      kind: "detached";
      detachedAt: IsoDateTime;
      previousDispatcherId: string;
    }
  | { kind: "adopting"; attachment: LiveRunnerAttachment }
  | { kind: "offline_replay"; attachment: OfflineReplayAttachment }
  | {
      kind: "identity_unresolved";
      firstObservedAt: IsoDateTime;
      observations: number;
    }
  | {
      kind: "replacement_prepared";
      successorExecutionId: ExecutionId;
      continuityReceiptId: string;
    };

type ExecutionRecoveryEvidence =
  | {
      kind: "matched";
      central: DurableExecutionRecord;
      registration: RunnerRegistration;
      runnerLifecycle: RunnerLifecycleRecord;
    }
  | {
      kind: "registration_missing";
      central: DurableExecutionRecord;
    }
  | {
      kind: "identity_unresolved";
      central: DurableExecutionRecord;
      observation:
        | { kind: "registration_absent" }
        | { kind: "registration_incomplete"; registration: RunnerRegistration };
      reason: "legacy_owner_null" | "incomplete_registration_identity";
    }
  | {
      kind: "terminal_witness";
      central: DurableExecutionRecord;
      runnerLifecycle: RunnerLifecycleRecord;
    };

type ExecutionRecoverySubject =
  | { kind: "identified"; ownership: ExecutionOwnership }
  | {
      kind: "identity_unresolved";
      key: ExecutionKey;
      manifestId: string;
      runtimeEnvIdentity: string;
    };

type ExecutionTerminalOutcome =
  | { kind: "completed"; terminalEventId: number }
  | { kind: "failed"; code: string; message: string }
  | { kind: "interrupted"; reason: "user" | "policy" }
  | { kind: "reaped"; reason: "runner_exited" | "lease_expired" | "orphaned_spawn" };

interface ExecutionTerminalSignal {
  signalId: string;
  executionId: ExecutionId;
  source: "runner" | "dispatcher" | "reconciler" | "user_interrupt";
  observedAt: IsoDateTime;
  outcome: ExecutionTerminalOutcome;
  proof: ExecutionTerminalProof;
}

interface HostTerminationIntent {
  intentId: string;
  executionId: ExecutionId;
  requestedAt: IsoDateTime;
  reason: "user_interrupt" | "policy" | "stalled" | "shutdown_forbidden";
}

interface RunnerTerminalWitness {
  witnessId: string;
  executionId: ExecutionId;
  executionCommandId: ExecutionCommandId;
  lifecycleSequence: number;
  outboxHighWatermark: number;
  outcome: ExecutionTerminalOutcome;
  durableAt: IsoDateTime;
}

interface TerminalIngressReceipt {
  terminalProofId: string;
  executionId: ExecutionId;
  receivedThroughOutboxSequence: number;
  committedAt: IsoDateTime;
}

type ExecutionTerminalProof =
  | {
      kind: "runner_witness_received";
      witness: RunnerTerminalWitness;
      receipt: TerminalIngressReceipt;
    }
  | { kind: "reservation_cancelled"; cleanupReceiptId: string }
  | {
      kind: "provisional_child_cleanup";
      child: SpawnedChildProof;
      cleanupReceiptId: string;
    }
  | {
      kind: "proven_process_absent";
      observationIds: readonly [string, string];
      stableOutboxHighWatermark: number;
      receipt: TerminalIngressReceipt;
    };

interface ExecutionTerminalRecord {
  key: ExecutionKey;
  firstSignal: ExecutionTerminalSignal;
  committedAt: IsoDateTime;
  deliveryResolution: "settled";
  cleanup: ExecutionCleanupReport;
}

interface ExecutionCleanupStep {
  name: string;
  status: "released" | "retained" | "retry_pending";
  attempts: number;
  detail: string | null;
}

interface ExecutionCleanupReport {
  executionId: ExecutionId;
  steps: ReadonlyArray<ExecutionCleanupStep>;
  completedAt: IsoDateTime;
}

type ExecutionRetention =
  | { kind: "none" }
  | {
      kind: "claude_background_runtime";
      attachment: LiveRunnerAttachment;
      retainedAt: IsoDateTime;
      backgroundTaskIds: ReadonlySet<string>;
    };

type TerminationSubject =
  | { kind: "reservation"; reservation: ExecutionReservation }
  | {
      kind: "provisional_child";
      reservation: ExecutionReservation;
      child: SpawnedChildProof;
      attachment: LiveRunnerAttachment;
    }
  | {
      kind: "attached_owner";
      ownership: ExecutionOwnership;
      attachment: LiveRunnerAttachment;
      activity: ExecutionActivity;
    }
  | {
      kind: "recovering_owner";
      subject: ExecutionRecoverySubject;
      recovery: ExecutionRecoveryHandle;
      activity: ExecutionActivity;
    };

type ExecutionTerminationProgress =
  | { phase: "intent_recorded"; intent: HostTerminationIntent }
  | { phase: "proof_observed"; signal: ExecutionTerminalSignal }
  | { phase: "visible_terminal_committed"; signal: ExecutionTerminalSignal };

type TaskExecution =
  | {
      phase: "idle";
      since: IsoDateTime;
      basis: "new_task" | "hydrated_without_open_execution";
    }
  | {
      phase: "reserved";
      reservation: ExecutionReservation;
      waiters: ExecutionWaiters;
      inputs: ExecutionInputSet;
    }
  | {
      phase: "provisional";
      reservation: ExecutionReservation;
      child: SpawnedChildProof;
      attachment: LiveRunnerAttachment;
      waiters: ExecutionWaiters;
      inputs: ExecutionInputSet;
    }
  | {
      phase: "activating";
      ownership: Omit<ExecutionOwnership, "activatedAt">;
      attachment: LiveRunnerAttachment;
      waiters: ExecutionWaiters;
      inputs: ExecutionInputSet;
    }
  | {
      phase: "active";
      ownership: ExecutionOwnership;
      attachment: LiveRunnerAttachment;
      activity: { kind: "foreground"; progress: ExecutionProgress };
      waiters: ExecutionWaiters;
      inputs: ExecutionInputSet;
    }
  | {
      phase: "awaiting_external_input";
      ownership: ExecutionOwnership;
      attachment: LiveRunnerAttachment;
      activity: Extract<ExecutionActivity, { kind: "awaiting_external_input" }>;
      waiters: ExecutionWaiters;
      inputs: ExecutionInputSet;
    }
  | {
      phase: "recovering";
      subject: ExecutionRecoverySubject;
      method: "host_reattach" | "adopt" | "offline_replay" | "identity_resolution";
      evidence: ExecutionRecoveryEvidence;
      handle: ExecutionRecoveryHandle;
      activity: ExecutionActivity;
      waiters: ExecutionWaiters;
      inputs: ExecutionInputSet;
    }
  | {
      phase: "terminating";
      subject: TerminationSubject;
      progress: ExecutionTerminationProgress;
      termination: Promise<ExecutionTerminalRecord>;
      waiters: ExecutionWaiters;
      inputs: ExecutionInputSet;
    }
  | {
      phase: "terminal";
      record: ExecutionTerminalRecord;
      retention: ExecutionRetention;
    };

interface BeginExecutionInput {
  key: ExecutionKey;
  semanticsVersion: 2;
  executorRequirement: "execution_semantics_v2";
  manifestId: string;
  runtimeEnvIdentity: string;
  reservationExpiresAt: IsoDateTime;
  terminalProjectionFence: ExecutionReservation["terminalProjectionFence"];
  initialInput:
    | { kind: "none" }
    | { kind: "delivery"; deliveryId: DeliveryId; enqueueSequence: bigint };
}

interface BeginExecutionRecoveryInput {
  execution: DurableExecutionRecord;
  method: "host_reattach" | "adopt" | "offline_replay" | "identity_resolution";
  evidence: ExecutionRecoveryEvidence;
  handle: ExecutionRecoveryHandle;
}

interface TaskExecutionController {
  readonly current: TaskExecution;
  begin(input: BeginExecutionInput): Promise<ExecutionReservation>;
  attachSpawn(
    executionId: ExecutionId,
    child: SpawnedChildProof,
    attachment: LiveRunnerAttachment,
  ): Promise<void>;
  activate(executionId: ExecutionId): Promise<ExecutionOwnership>;
  beginRecovery(input: BeginExecutionRecoveryInput): Promise<void>;
  recordProgress(executionId: ExecutionId, progress: ExecutionProgress): Promise<void>;
  awaitExternalInput(
    executionId: ExecutionId,
    request: PendingExternalInput,
  ): Promise<void>;
  resolveExternalInput(receipt: ExternalRequestResolutionReceipt): Promise<void>;
  assignDelivery(executionId: ExecutionId, deliveryId: DeliveryId): Promise<void>;
  requestInterrupt(executionId: ExecutionId): Promise<boolean>;
  terminate(
    executionId: ExecutionId,
    cause: HostTerminationIntent | RunnerTerminalWitness | ExecutionTerminalSignal,
  ): Promise<ExecutionTerminalRecord>;
  awaitTerminal(executionId: ExecutionId): Promise<ExecutionTerminalRecord>;
}

interface Task {
  // 기존 도메인 필드
  readonly execution: TaskExecutionController;
}
```

`reaped`는 predecessor execution의 내부 outcome이지 곧바로 session 실패가 아니다. 승인된 입력 책임이 남아 있으면 atomic replacement handoff가 session의 `running`과 외부 stream을 유지한다. `interrupted`는 같은 invocation ID의 명시적 사용자 interrupt가 runner witness로 확인된 경우에만 session으로 투영한다. host restart, owner-null, registration identity 불완전은 이 outcome을 만들 수 없다.

`Task.execution`은 required다. 자원이 없는 이유는 `undefined`가 아니라 phase가 말한다. 아직 시작하지 않았으면 `idle`, 독립 runner placement를 기다리면 `reserved`, 자식을 만들었지만 활성화 전이면 `provisional`, 사람의 approval·답변을 기다리면 `awaiting_external_input`, 회수 중이면 `recovering`, 자원을 정산했으면 terminal record를 가진 `terminal`이다. “없음”, “해당 없음”, “치웠음”이 같은 값이 되는 경로가 사라진다.

`PendingExternalRequestSet`은 controller module의 private `create/add/removePendingExternalRequestSet()`만 만들 수 있는 non-empty branded collection이다. 메모리에서는 request id별 map을 제공하고 durable row와 runner journal에는 같은 내용을 key-unique JSON object로 직렬화한다. `awaiting_external_input`은 이 집합이 비어 있으면 구성할 수 없고, `foreground`는 명시적인 `externalRequests.state="empty"`를 가진다. 따라서 단일 pending slot, controller 밖 lookup, expiry 때의 direct clear가 필요 없다.

기존 12개 필드의 정보는 다음처럼 정확히 한 union 안으로 이동한다.

| 기존 Task 필드 | 새 소유 위치 |
| --- | --- |
| `runner` | `provisional/activating/active/awaiting_external_input.attachment`, recovery handle 또는 `terminal.retention` |
| `runnerRetainedForClaudeBackground` | `terminal.retention.kind` |
| `runnerIsOfflineReplay` | `recovering.method`과 `handle.kind` |
| `runnerTerminalFact` | `terminating.progress`의 proven signal, `terminal.record.firstSignal` |
| `executionPromise` | `waiters.terminal.promise`과 `terminating.termination` |
| `executionActivationPromise` | `waiters.activation.promise` |
| `executionActivationHandoff` | `waiters.activation` |
| `executionOwnership` | `active/awaiting_external_input.ownership`, `recovering.subject` 또는 termination subject |
| `executionOwnershipReservation` | `reserved/provisional.reservation` |
| `recoveredExecutionOwnership` | `recovering.evidence` |
| `pendingExecutionExpectedTerminalEventId` | `reservation.terminalProjectionFence` |
| `interruptRequest` | `waiters.interrupt` |

### 실행 identity의 단위

`executionId`는 **모델의 한 turn이 아니라 현재 `execute` command가 감싸는 multi-turn loop 전체**의 identity다. 한 실행 안에서 최초 prompt, intervention, AskUserQuestion 응답, tool approval 응답이 차례로 여러 model turn을 만들 수 있다.

```text
session 1
  → executionId N                     실행 수명. adopt는 보존, replacement는 새 ID
    → executionCommandId 1            runner execute command. provisional spawn에서 확정
      → runnerInputSequence N         최초 입력·개입·응답마다 단조 증가
        → provider/model turn N       내부 구현 단위, execution identity가 아님
```

정상·pure adopt는 `executionId`와 `executionCommandId`를 모두 보존한다. runner crash 뒤 checkpoint-resume이 불가능해 replacement가 필요하면 앞 실행을 증명·정산한 다음 새 `executionId`와 새 command를 만든다. `deliveryId` 하나는 정확히 한 `runnerInputSequence` consumption receipt와 결합하며, provider model turn에는 직접 bind하지 않는다. 이 구분으로 구현자가 “intervention 한 번 = execution 하나” 또는 “model turn 하나 = 실행 수명”으로 축소하는 것을 막는다.

## 상태 전이표

| 현재 | 계기 | 다음 | 필수 durable 효과 | 금지 |
| --- | --- | --- | --- | --- |
| `idle` 또는 `terminal` | durable delivery head가 실행을 요구 | `reserved` | semantics v2 execution row, generation, reconcile job을 함께 commit | admission 전 실행, `in_process` 배치 |
| `reserved` | v2 독립 runner capacity 부재 | `reserved` | placement wake의 `next_wake_at` 갱신 | 실패·503·in-process fallback |
| `reserved` | 정확한 v2 child spawn 성공 | `provisional` | child proof를 execution row와 runner witness에 기록 | 활성화 전 실행 부재로 취급 |
| `reserved` | reserve 취소·만료 | `terminating` | `reservation_cancelled` proof 뒤 visible terminal CAS | reservation 필드만 삭제 |
| `provisional` | ownership proof 성공 | `activating` | proof CAS | sidecar 재독만으로 child identity 교체 |
| `provisional` | proof·parent init 실패 | `terminating` | exact spawned child cleanup receipt 뒤 visible terminal CAS | 현재 등록 PID 추측 종료 |
| `activating` | activation ACK | `active` | active CAS, activation waiter resolve | delivery 선할당 |
| `activating` | activation 실패 | `terminating` | exact child cleanup 또는 runner witness receipt | promise만 reject하고 child 방치 |
| `active` | 첫 durable tool approval·AskUserQuestion request | `awaiting_external_input` | non-empty request set과 request id를 execution row·runner journal에 함께 기록 | `tool_start`나 단순 progress로 대체 |
| `awaiting_external_input` | 다른 request 생성 | `awaiting_external_input` | key-unique request set에 추가하고 다음 expiry wake를 갱신 | 기존 pending request 덮어쓰기 |
| `awaiting_external_input` | 같은 request id의 응답 delivery consumed | 남은 request가 있으면 `awaiting_external_input`, 없으면 `active` | `responded` receipt, runner input sequence, 집합 remove를 한 transaction에 commit | 전체 집합 clear, foreground stall clock 소급 적용 |
| `awaiting_external_input` | request deadline 도달 | 남은 request가 있으면 `awaiting_external_input`, 없으면 `active` | exact request의 `expired` receipt와 runner `input_request_expired` journal을 commit | progress reaper가 execution 종료, 다른 request clear |
| `awaiting_external_input` | request owner·사용자 취소 | 남은 request가 있으면 `awaiting_external_input`, 없으면 `active` | exact request의 `cancelled` receipt를 commit | controller 밖 callback map만 삭제 |
| `active` 또는 `awaiting_external_input` | 이미 resolved된 request의 late response | 동일 phase | 기존 resolution receipt를 반환. Claude expiry면 semantic `expired` | runner에 재전달, 새 delivery bind |
| `awaiting_external_input` | host attachment 상실 | `recovering` | pending request를 보존한 recovery wake | stalled reap, request 유실 |
| `active` | host attachment 상실 | `recovering` | recovery wake 기록 | stream fail, execution terminal 처리 |
| `recovering(activity=awaiting_external_input)` | request expiry·취소 receipt 관측 | `recovering` | exact request만 정산하고 나머지 set 또는 foreground activity를 보존 | attach 전 direct clear, execution reap |
| `recovering(activity=awaiting_external_input)` | response delivery 도착 | `recovering` | delivery는 accepted/queued, pending request는 runner consumption까지 유지 | host 부재를 503으로 반환, 응답했다고 선반영 |
| `recovering` | 같은 identity reattach/adopt | `active` 또는 `awaiting_external_input` | attachment epoch 갱신, 보존한 activity로 복귀 | 새 execution 생성, pending request 삭제 |
| `recovering(identity_unresolved)` | identity 증명 성공 | `active` 또는 `awaiting_external_input` | 기존 execution/command identity backfill | session `interrupted` 투영 |
| `recovering(identity_unresolved)` | process 부재 확정·adopt 불가 | successor `reserved` | predecessor terminal proof + successor row + input/context handoff를 한 transaction에 commit | 중간 `idle`, session terminal/interrupted, 입력 유실 |
| `recovering` | durable terminal witness | `terminating` | witness high-watermark drain wake | receipt 전 first signal CAS, 늦은 host 오류로 덮기 |
| `active`, `awaiting_external_input`, `recovering` | host interrupt·reaper 의도 | `terminating(intent_recorded)` | durable intent, 전체 `ExecutionActivity`, runner control wake를 보존 | intent만으로 visible terminal commit, pending request 유실 |
| nonterminal | runner witness 또는 process-absence proof와 ingress receipt | `terminating(proof_observed)` | first visible terminal CAS | receipt 전 session terminal 투영 |
| `terminating` | visible terminal·delivery·cleanup 정산 완료 | `terminal` | terminal row, delivery resolution, cleanup report | waiters를 남긴 채 field clear |
| `terminal` | 다음 유효 입력 | 새 `reserved` | 새 `executionId`, retention attachment의 명시적 handoff | terminal record 재사용, retained runner를 current turn으로 간주 |

모든 mutation은 controller의 `transition(expectedExecutionId, expectedPhase, next)` CAS를 거친다. 이전 실행의 callback은 execution id가 다르면 관측만 기록하고 현재 실행의 자원에 접근할 수 없다.

### 외부 입력 수명 정책

Claude `AskUserQuestion`은 현행 UX인 **300,000ms**를 유지한다. request 생성 시 `expiresAt=requestedAt+300_000`을 runner journal과 중앙 ledger에 같이 쓴다. deadline worker는 exact runner expiry wake만 만들고 request를 직접 지우지 않는다. runner journal의 `input_request_expired`가 `{ kind: "runner_journal" }` proof로 resolution CAS를 이기며, exact process 부재·termination이면 cleanup proof가 대신 닫는다. 늦은 응답은 새 input으로 보지 않고 기존 `{ kind: "expired" }` receipt를 반환한다. 재기동 전후 모두 같은 결과이므로 이는 재시작 신호가 아니다.

Agents tool approval은 현행처럼 자동 만료가 없는 `{ kind: "none" }`이다. 명시적 request cancellation이나 execution terminal만 닫을 수 있다. 한 request가 응답·만료·취소돼도 나머지 request는 그대로 남고, 마지막 open request가 사라질 때만 `active`로 돌아가 새 30분 foreground progress lease를 시작한다. execution이 `terminating`으로 들어가면 `TerminationSubject.activity`가 전체 집합을 보존하고 cleanup은 각 request를 `execution_terminated` receipt로 정산한 뒤에만 terminal을 게시한다.

### 메모리 phase와 durable phase의 동형

v2는 `reserved → identity_proven → active`를 해석해서 9-phase 메모리 상태에 끼워 맞추지 않는다. `idle`만 “open execution row가 없음”이고, 나머지 phase 이름은 메모리와 중앙 DB가 같다. 구 `identity_proven` 문자열은 semantics v1 row의 compatibility projection일 뿐이며 v2 writer는 만들 수 없다.

| 메모리 phase | v2 durable phase | 필수 durable 증거 | crash 복원 결과 |
| --- | --- | --- | --- |
| `idle` | open row 없음 | session head에 미할당 delivery만 존재 가능 | 새 head가 있으면 `reserved` 생성 |
| `reserved` | `reserved` | reservation, executor placement; child·ownership proof·activation receipt 없음 | placement 재개 |
| `provisional` | `provisional` | exact child proof 있음, ownership proof·activation receipt 없음 | 같은 child의 proof 단계 재개 또는 exact cleanup |
| `activating` | `activating` | exact child proof와 `ownership_proof_id` 있음, `activation_receipt_id` 없음 | idempotent `prepareSession(executionId, commandId)` 재실행 후 activation CAS |
| `active` | `active` | ownership proof와 activation receipt 있음, external request set 비어 있음 | attach/adopt 뒤 foreground 재개 |
| `awaiting_external_input` | `awaiting_external_input` | activation receipt와 non-empty request set 있음 | request set과 deadline wake를 복원 |
| `recovering` | `recovering` | recovery subject·activity·reconcile job 있음 | activity를 보존해 adopt/replacement |
| `terminating` | `terminating` | termination subject와 activity, intent 또는 proof 있음 | terminal pipeline 재개 |
| `terminal` | `terminal` 또는 `failed` compatibility projection | first signal, ingress receipt/preactivation proof, cleanup report | immutable terminal 재조회 |

DB CHECK는 이를 직접 강제한다. v2 `reserved`는 child identity가 모두 null, `provisional`은 child identity가 모두 non-null이면서 `ownership_proof_id IS NULL`, `activating`은 proof가 non-null이면서 `activation_receipt_id IS NULL`, `active/awaiting_external_input`은 둘 다 non-null이어야 한다. `awaiting_external_input`은 `jsonb_object_length(pending_external_requests) > 0`, `active`는 빈 object다. `recovering/terminating`은 각각 subject JSON과 activity JSON이 없으면 거부한다. 따라서 `task_executor.ts:495`의 proof commit 뒤 `prepareSession` 또는 activation ACK 전에 죽어도 durable row가 `activating` 이외 상태로 복원될 수 없다.

## 획득과 해제의 대칭

### 획득 경계

`begin()`은 다음을 한 원자적 책임으로 묶는다.

1. session별 controller mutex를 획득한다.
2. 현재 phase가 `idle` 또는 `terminal`인지 확인한다.
3. `executionId`, generation, activation/terminal/interrupt waiter를 만든다.
4. 중앙 execution row를 `semantics_version=2`, `executor_kind=independent_runner`, `reserved`로 기록하고 durable reconcile/placement job을 함께 만든다.
5. 메모리 상태를 `reserved`로 게시한다.
6. mutex를 놓는다.

spawn은 v2 capability를 가진 독립 runner가 배정된 뒤에만 일어난다. capacity가 없으면 `reserved`와 이미 승인된 delivery가 durable하게 기다린다. 성공 즉시 `attachSpawn()`이 exact child proof와 attachment resource ledger를 함께 `provisional`에 넣는다. 그래서 activation 전 실패도 “실행이 없었다”가 아니라 terminalize해야 할 실행으로 남는다. `task_executor.ts:277`의 `createInProcessTaskRunnerRuntime()` 폴백은 v2 user-visible 진입에서 호출 불가능하고, DB의 `executor_kind` CHECK도 이를 거부한다.

### 해제 경계

`terminate(executionId, cause)`만 실행을 끝낸다. 같은 execution에 대한 모든 호출은 하나의 memoized termination promise를 돌려받는다. 여러 host intent는 합쳐지지만 terminal 결과가 아니다. outbox receipt를 갖춘 첫 유효 proof만 first visible signal CAS를 이기고, 이후 proof·오류는 late signal 진단으로 남는다.

해제 순서는 다음으로 고정한다.

1. 해당 execution으로의 새 delivery bind와 새 interrupt 시작을 닫는다. host-origin 종료면 `HostTerminationIntent`만 durable하게 기록한다. **의도는 visible terminal이 아니다.**
2. runner는 마지막 engine event와 pending outbox를 먼저 durable하게 쓴 뒤, 그 outbox high-watermark와 outcome을 가진 `RunnerTerminalWitness`를 같은 runner transaction에 commit한다.
3. runner는 비정본 `execution_ended` control frame으로 host를 깨운다. frame 유실은 maintenance poll로 대체되며 terminal 사실을 만들지 않는다.
4. host는 witness의 high-watermark까지 runner outbox·IPC journal을 event ingress로 replay하고 `TerminalIngressReceipt`를 durable하게 받는다.
5. controller는 witness identity와 receipt sequence가 일치함을 확인한 뒤에만 중앙 first visible terminal CAS를 수행한다. 이때 늦은 `finish/fail`은 진단으로만 남는다.
6. 할당된 delivery attempt를 consumed, unconsumed, reconcile_pending 중 하나로 정산한다.
7. `ProcessFrameStream.terminate(firstSignal)`로 내부 소비자에게 정확히 한 terminal을 보낸 뒤 activation, terminal, interrupt waiter를 모두 settle한다.
8. `TerminationSubject.activity`의 open external request를 request id별 `execution_terminated` receipt로 먼저 정산하고 deadline timer·adapter callback을 끊는다. 그 뒤 진행 관측, reconnect timer, in-flight frame handler를 정산한다. 집합이 비지 않으면 이 cleanup step은 완료될 수 없다.
9. pump mux 등록, IPC attachment, parent outbox, offline writer와 writer lock을 반납한다.
10. 정책이 요구할 때만 exact child proof로 child를 종료·retire한다. host restart와 live adoption handoff에서는 child를 보존하고, foreground 종료 뒤 Claude background task가 남으면 `terminal.retention`으로 명시 이전한다.
11. cleanup 실패 전체를 `ExecutionCleanupReport`에 기록하고, 독립 단계는 끝까지 시도한 뒤 `terminal`로 전이한다. 실패 단계는 maintenance lane이 재시도한다.

runner가 witness 전에 죽은 경우에도 host intent를 terminal로 승격하지 않는다. reconciler가 서로 다른 두 scan에서 exact process 부재, 변하지 않은 runner outbox high-watermark, 중앙 execution identity를 함께 증명하고, 남은 outbox를 ingress receipt까지 정산한 `proven_process_absent` proof를 만든 뒤 같은 5번 CAS를 탄다. 이 경로가 출력 유실과 terminal 영구 대기를 동시에 막는다.

runner lifecycle의 terminal witness slot도 `(execution_id, execution_command_id)`당 하나인 CAS다. `finish → fail`, `fail → finish`, `fail → fail`에서 첫 witness의 outcome과 high-watermark가 고정되고 late witness는 별도 diagnostic row로만 남는다. 중앙 first visible signal은 그 첫 witness를 receipt 뒤 투영하므로 첫 실패 대신 late failure가 노출될 수 없다.

5번의 visible terminal CAS는 durable outcome 정본을 뜻한다. session status broadcast, `TaskExecution.phase="terminal"`, terminal waiter resolution은 6~11번이 끝난 같은 memoized termination promise의 끝에서만 게시한다. 따라서 active stream 정산, request lifetime abort, host resource release, reason 기록 중 하나를 빼고 “종료 완료”를 관측시키는 경로가 없다.

host attachment 반납은 이 목록과 다른 연산이다.

```ts
interface DispatcherTerminal {
  firstSignal: ExecutionTerminalSignal;
  attachmentCleanup: ExecutionCleanupStep[];
}

interface RunnerProcessDispatcher {
  detachAttachment(reason: "host_shutdown" | "adoption_handoff"): Promise<void>;
  terminateExecution(signal: ExecutionTerminalSignal): Promise<DispatcherTerminal>;
}

type DispatcherState =
  | { phase: "provisional"; child: SpawnedChildProof }
  | { phase: "active"; executionId: ExecutionId; stream: ProcessFrameStream }
  | { phase: "detached"; executionId: ExecutionId; reason: "host_shutdown" | "adoption_handoff" }
  | { phase: "terminating"; firstSignal: ExecutionTerminalSignal; done: Promise<DispatcherTerminal> }
  | { phase: "terminal"; terminal: DispatcherTerminal };
```

`close`, rollback, reconnect exhaustion, `execution_ended`, offline replay terminal의 다섯 진입점은 직접 boolean이나 stream을 건드리지 않는다. rollback은 exact child cleanup proof, runner-origin 경로는 witness+ingress receipt를 controller `terminate()`에 전달한다. `execution_ended`는 witness 조회를 깨우기만 한다. reconnect exhaustion은 `recovering`과 `detachAttachment()`를 호출하며 child, execution row, output stream을 terminal로 바꾸지 않는다.

`ProcessFrameStream`도 `ended`와 `error` 두 필드 대신 다음 단일 상태를 가진다.

```ts
type ProcessFrameStreamState =
  | { phase: "open" }
  | { phase: "terminal"; signal: ExecutionTerminalSignal };

interface ProcessFrameStream {
  terminate(signal: ExecutionTerminalSignal): boolean; // first signal만 true
}
```

이 구조에서 `finish → fail`, `fail → finish`, `fail → fail`은 모두 첫 신호 뒤 no-op 진단이 된다. #818에서 first-terminal RED가 2-2 전환만으로 green이 된 이유를 정식 계약으로 고정한다.

## 자력 회수

### inventory 정본

주기 회수의 입력을 runner 등록 디렉터리에서 중앙 open execution으로 뒤집는다.

```ts
interface OpenExecutionInventory {
  listOpenByNode(nodeId: string): Promise<DurableExecutionRecord[]>;
}

interface ExecutionInventorySnapshot {
  durable: DurableExecutionRecord[];
  registrations: RunnerRegistration[];
  controllers: ReadonlyArray<{
    sessionId: string;
    executionId: ExecutionId;
    phase: TaskExecution["phase"];
  }>;
}

type InventoryRelation =
  | { kind: "matched"; execution: DurableExecutionRecord; registration: RunnerRegistration }
  | { kind: "registration_missing"; execution: DurableExecutionRecord }
  | { kind: "execution_missing"; registration: RunnerRegistration }
  | { kind: "memory_missing"; execution: DurableExecutionRecord; registration: RunnerRegistration }
  | { kind: "memory_orphan"; controller: TaskExecutionController };
```

매 maintenance tick은 다음 순서로 독립 스냅샷을 만든다.

1. semantics v2 row는 `reserved`, `provisional`, `activating`, `active`, `awaiting_external_input`, `recovering`, `terminating`을, rolling 중 v1 row는 `reserved`, `identity_proven`, `active`를 node별로 읽는다. 모든 open row는 같은 transaction에서 만들어지거나 migration에서 backfill된 `execution_reconcile_jobs` row와 non-null `reconcile_due_at`을 가진다.
2. runner 등록 디렉터리와 runner SQLite lifecycle witness를 읽는다.
3. 메모리 controller를 읽되 판단 근거가 아니라 불일치 탐지에만 쓴다.
4. `executionId`를 기준으로 full outer join한다.
5. 모든 row를 disposition으로 분류하고, 각 결과를 execution row와 reconcile job을 한 transaction에서 갱신하는 `completed` 또는 `scheduled(wakeAt)` receipt로 끝낸다.

따라서 등록 디렉터리가 0개여도 중앙의 열린 실행 4개와 durable reconcile job 4개가 나오면 네 실행을 모두 검사한다. 반대로 중앙 execution 없이 등록만 있으면 orphan child 회수 대상이다. `activeRunnerOperations`와 Task 필드 존재는 inventory가 아니라 controller phase의 순수 projection으로 격하한다.

스캔은 기존 bounded `PeriodicMaintenanceLoop`의 독립 step으로 두고 다음 수치를 v2 설정 정본으로 고정한다.

| 수치 | 값 | 의미 |
| --- | ---: | --- |
| `EXECUTION_RECONCILE_SCAN_MS` | 5,000ms | due job을 확인하는 최대 간격 |
| `EXECUTION_RECONCILE_JOB_LEASE_MS` | 15,000ms | worker fail-stop 뒤 같은 job이 다시 runnable해지는 상한 |
| `PROCESS_ABSENCE_GRACE_MS` | 15,000ms | 마지막 positive process liveness 뒤 process-absence 판정을 금지하는 구간 |
| `PROCESS_ABSENCE_SECOND_SCAN_MS` | 5,000ms | 서로 다른 두 absence 관측의 최소 간격. due 뒤 두 번째 관측은 최대 10,000ms 안에 끝남 |
| `REPLACEMENT_CAPACITY_RESERVATION_MS` | 60,000ms | process 부재 proof 뒤 successor 책임을 예약하는 상한 |

DB의 `next_wake_at`이 지난 job을 `FOR UPDATE SKIP LOCKED`로 claim하며, worker lease가 끝나면 DB가 다시 runnable하게 만든다. 마지막 liveness를 `t0`라 하면 첫 absence proof 후보는 `t0+15s` 이전에 생길 수 없고 다음 scan은 최대 5초 뒤, 두 번째 독립 scan은 다시 최대 5초 뒤다. process 부재 proof 뒤 60초 안에 reserved recovery capacity가 successor row를 받으므로 predecessor execution waiter의 `reaped/replaced` 내부 settle 상한은 **85초**다. 이 상한은 중앙 DB, maintenance worker 하나, 예약된 v2 replacement capacity 하나가 건강하다는 availability envelope에서 성립한다. 전체 기반 시설 fail-stop 동안에는 시간을 보장할 수 없지만 durable 책임과 wake는 남고, 이를 503·session interrupt·외부 timeout으로 투영하지 않는다.

replacement capacity는 일반 placement와 경쟁하는 희망값이 아니라 node별 최소 1개 복구 슬롯을 따로 예약하는 운영 capability다. 60초를 넘기면 내부 P0 invariant breach와 capacity 증설 wake를 만들되 승인된 delivery와 외부 stream은 계속 대기한다. 새 메시지, reserve, intervention, 배포, 재시작은 가속 wake일 수 있지만 회수의 전제는 아니다. 한 실행의 reconcile이 다른 실행을 막지 않는다.

### owner-null은 identity-unresolved 책임이다

v2 migration은 owner-null running row를 `idle`, `terminal`, session `interrupted` 중 어느 것으로도 투영하지 않는다. 두 번 관측에서 stable identity가 나오면 같은 execution을 `identified`로 backfill하고 adopt한다. identity가 여전히 없으면 `recovering`의 `identity_unresolved` subject와 durable reconcile job을 만든다. 그 상태는 다음 두 종착지만 가진다.

1. runner/registration/bootstrap 증거가 합쳐지면 같은 `executionId`와 command를 adopt한다.
2. exact process 부재와 outbox 경계가 증명되면 `session_replace_execution_v2(...)`가 predecessor terminal proof, successor `reserved` row, 승인된 입력·context·pending request handoff를 한 transaction에 commit한다. open execution pointer가 predecessor에서 successor로 원자적으로 바뀌므로 session은 `idle`이나 terminal을 거치지 않는다.

따라서 legacy 두 번 관측은 “identity를 못 찾았으니 interrupt”가 아니라 “누가 맡을지 아직 증명하지 못했으니 recovering 책임을 유지”하는 분류다. 이 과정은 외부 session status와 ACK에 나타나지 않는다.

### progress와 process liveness 분리

살아 있는 프로세스와 진행하는 턴은 다른 사실이다.

- semantic `assistant_message`, `thinking`, `tool_result`만 foreground progress lease를 갱신한다. 정본 predicate는 하나다.
- backend 정규화는 exhaustive adapter 표 하나가 담당한다. Claude client `text`는 semantic `assistant_message`로 변환하고, Codex event mapper와 Codex app-server의 완료 agent message, OpenAI Agents의 완료 output은 모두 semantic `assistant_message`로 수렴한다. `thinking`과 `tool_result`도 각 mapper가 같은 semantic kind로 수렴시킨 뒤 lease 계층에 들어온다.
- `tool_start`는 progress가 아니라 해당 tool의 **30분(1,800,000ms) 비갱신 absolute lease**를 연다. heartbeat와 중복 tool start는 연장하지 않으며 `tool_result`, explicit tool cancellation, execution terminal이 닫는다.
- runner heartbeat는 process liveness만 갱신한다. 객체, socket, PID, 등록 디렉터리 존재는 progress가 아니다.
- 중앙 progress row는 runner SQLite의 monotonic `progress_seq`를 CAS 투영한다. 늦은 host가 sequence를 되돌릴 수 없다.
- foreground progress gap도 현행 설정 정본 `SOUL_RUNNER_LEASE_TIMEOUT_MS=1,800,000ms`를 그대로 쓴다 (`soul-server-ts/src/config.ts:71`). progress gap이 지났더라도 absolute lease 안의 in-flight tool이 있으면 기다리고, tool lease가 지났더라도 최근 semantic progress가 있으면 기다린다. 둘 다 지났고 terminal witness가 없으며 두 scan에서 sequence가 같을 때만 `reap_stalled` intent를 만든다.
- `awaiting_external_input`에서는 foreground progress와 tool absolute lease 판정을 중지한다. durable request 집합의 process liveness는 계속 감시하되 사람의 고민 시간을 stalled로 해석하지 않는다. Claude request deadline은 request subsystem이 exact `input_request_expired` receipt를 만들 뿐 progress reaper가 execution을 종료하지 않는다. 마지막 open request가 정산된 뒤에만 새 30분 progress deadline으로 `active`를 재개한다.

이는 “tool result, thinking, agent message가 오고 있으면 살아 있다”는 사용자 기준을 정본 predicate로 올린 것이다. 현재 `runner_child_runtime.ts:584`의 모든 SSE event progress, `runner_process_registry.ts:160`의 renewable gap, `claude_runtime_followup_watchdog.ts:205`의 foreground predicate를 하나로 합친다. 현행에는 tool absolute lease가 없으므로 이는 신규 durable 필드이며, 기존 gap 수치만 재사용한다.

| backend | raw 완료·진행 event | semantic progress | 비고 |
| --- | --- | --- | --- |
| Claude SDK | client `text` | `assistant_message` | `mapClaudeClientEvent()` 경계에서 변환. raw `text`를 lease 계층에 직접 넣지 않음 |
| Claude SDK | `thinking`, `tool_result` | 동명 semantic kind | `input_request`는 progress가 아니라 external wait 전이 |
| Codex CLI 모드 | completed `agent_message`, reasoning, completed tool item | `assistant_message`, `thinking`, `tool_result` | live delta는 durable progress로 세지 않음 |
| Codex app-server 모드 | completed agent message, completed reasoning/tool item | `assistant_message`, `thinking`, `tool_result` | 두 Codex mapper 모두 같은 semantic union을 반환 |
| OpenAI Agents | completed output `assistant_message`, tool result | `assistant_message`, `tool_result` | `tool_approval_requested`는 external wait 전이 |

adapter 반환 타입은 `ExecutionProgressKind | ExternalWaitSignal | NonProgressEvent`의 exhaustive union으로 하고, classifier에 backend string switch를 다시 두지 않는다. 새 backend event를 추가했는데 어느 variant에도 넣지 않으면 compile/test가 실패한다.

### exhaustive disposition 정책

분류와 행동을 if-chain에 함께 쓰지 않는다. 분류는 사실만 반환하고, 다음 표가 행동을 전부 정한다.

```ts
type RecoveryAction =
  | "await_bootstrap_deadline"
  | "adopt"
  | "replay"
  | "replay_then_retire"
  | "observe_terminal"
  | "revalidate_then_reap"
  | "resume_reaped"
  | "drain_closed"
  | "resolve_identity_or_prepare_replacement";

type RunnerRecoveryDispositionV2 =
  | RunnerRecoveryDisposition
  | "identity_unresolved";

interface DispositionPolicy {
  task: "required" | "forbidden";
  contendsForOwnership: boolean;
  revalidate: "never" | "before_irreversible_action";
  action: RecoveryAction;
  onOwnershipConflict: "not_applicable" | "schedule_retry_at_canonical_lease";
}

const DISPOSITION_POLICY = {
  wait_for_bootstrap: {
    task: "forbidden", contendsForOwnership: false,
    revalidate: "never", action: "await_bootstrap_deadline",
    onOwnershipConflict: "not_applicable",
  },
  adopt_prebootstrap: {
    task: "required", contendsForOwnership: true,
    revalidate: "before_irreversible_action", action: "adopt",
    onOwnershipConflict: "schedule_retry_at_canonical_lease",
  },
  adopt_running: {
    task: "required", contendsForOwnership: true,
    revalidate: "before_irreversible_action", action: "adopt",
    onOwnershipConflict: "schedule_retry_at_canonical_lease",
  },
  replay_terminal: {
    task: "required", contendsForOwnership: false,
    revalidate: "before_irreversible_action", action: "replay",
    onOwnershipConflict: "not_applicable",
  },
  replay_terminal_dead: {
    task: "required", contendsForOwnership: false,
    revalidate: "before_irreversible_action", action: "replay_then_retire",
    onOwnershipConflict: "not_applicable",
  },
  retired_terminal: {
    task: "forbidden", contendsForOwnership: false,
    revalidate: "never", action: "observe_terminal",
    onOwnershipConflict: "not_applicable",
  },
  reap_dead: {
    task: "required", contendsForOwnership: false,
    revalidate: "before_irreversible_action", action: "revalidate_then_reap",
    onOwnershipConflict: "not_applicable",
  },
  reap_stalled: {
    task: "required", contendsForOwnership: false,
    revalidate: "before_irreversible_action", action: "revalidate_then_reap",
    onOwnershipConflict: "not_applicable",
  },
  already_reaped: {
    task: "required", contendsForOwnership: true,
    revalidate: "before_irreversible_action", action: "resume_reaped",
    onOwnershipConflict: "schedule_retry_at_canonical_lease",
  },
  closed: {
    task: "required", contendsForOwnership: false,
    revalidate: "before_irreversible_action", action: "drain_closed",
    onOwnershipConflict: "not_applicable",
  },
  identity_unresolved: {
    task: "required", contendsForOwnership: true,
    revalidate: "before_irreversible_action", action: "resolve_identity_or_prepare_replacement",
    onOwnershipConflict: "schedule_retry_at_canonical_lease",
  },
} satisfies Record<RunnerRecoveryDispositionV2, DispositionPolicy>;
```

action executor의 반환 타입은 다음 둘뿐이다.

```ts
type RecoveryReceipt =
  | { kind: "completed"; executionId: ExecutionId; resultingPhase: TaskExecution["phase"] }
  | { kind: "scheduled"; executionId: ExecutionId; wakeAt: IsoDateTime; reason: string };
```

refreshed disposition이 달라지면 executor는 새 키로 같은 `Record`를 다시 조회한다. 아무 일도 하지 않는 `return`은 타입에 없다. v2의 11번째 `identity_unresolved`를 포함한 이 구조는 이후 12번째 disposition이 추가될 때 policy와 test matrix 양쪽을 컴파일 오류로 만든다.

## delivery와 실행의 연결

### caller가 만드는 stable delivery identity

exactly-once의 시작점은 orch가 아니라 **첫 network send 전 caller**다. orch가 admission commit 직후 응답 전에 죽었을 때 같은 논리 메시지를 같은 ID로 다시 물을 수 없으면 중복과 유실 중 하나를 피할 수 없다. v2 cutover 전에 다음 inventory를 모두 관통시킨다.

| caller·동작 | 현재 결손 | v2 delivery ID 계약 | retry 보존 위치 |
| --- | --- | --- | --- |
| soul-ui web message·intervene | `submitIntervention.ts:30`에 ID 없음 | action 시작 시 UUID를 생성하고 payload와 함께 전송 | pending action store에 ACK까지 보존 |
| soul-app intervene | `sessionEndpoints.ts:158`에 ID 없음 | web과 같은 action UUID | persisted pending action |
| soul-ui web·soul-app respond | ID 없음 | `UUIDv5(sessionId, "respond", requestId)` | durable pending request |
| soul-ui web·soul-app approve/reject | ID 없음 | `UUIDv5(sessionId, "tool_approval", approvalId)`; decision은 payload hash에 포함 | durable pending approval |
| soul-app·web interrupt | invocation identity 없음 | 클릭·호출마다 새 action UUID. session id에서만 결정적으로 만들지 않음 | pending interrupt action |
| Slack intervention | `intervention.py:22`가 `thread_ts`를 delivery로 전달하지 않음 | `UUIDv5(channelId, messageEventId)` | Slack event retry의 동일 event id |
| Cogito MCP create/intervene/respond/approval/interrupt | `session_mgmt.ts:150` 스키마에 없음 | 명시적 required `delivery_id`; MCP client가 첫 호출 전에 생성 | MCP 호출자의 request state |
| orch create/intervene 요청 모델 | `session_models.py:22`에 없음 | required `delivery_id`를 admission까지 그대로 전달 | idempotency receipt |
| cross-node command | TS 수신은 수용, `node_connection.py:438` Python 송신 누락 | 기존 `delivery_id`를 Python→TS 전 구간 관통 | orch delivery row |
| completion/runtime followup | 이미 있음 (`delivery_identity.ts:11`) | 기존 결정적 ID 유지 | 기존 delivery identity 정본 |

respond/approval ID가 결정적이어도 같은 ID에 다른 답·decision payload가 오면 admission의 payload hash mismatch proof로 거부한다. interrupt는 같은 session을 여러 번 중단할 수 있으므로 request id에서 파생할 수 없고 invocation UUID가 필요하다. UI와 MCP adapter는 transport disconnect를 외부 실패로 확정하지 않고 같은 ID로 내부 재조회·재시도하여 동일 `AcceptedInput`을 돌려준다.

이 전환은 delivery bind의 부가 작업이 아니라 v2 admission의 **선행 fence**다. 모든 caller capability가 등록되기 전에는 v2 ingress를 켜지 않는다. 구 caller 요청은 v1 경로로만 처리되며 v2 execution row에 bind할 수 없다.

서버가 누락 ID를 payload hash로 임의 생성하는 fallback은 두지 않는다. 동일 문구의 서로 다른 action을 합칠 수 있기 때문이다. web은 dashboard release와 함께 전환하고, mobile은 v2 ID를 가진 minimum supported version이 배포되기 전까지 해당 caller kind의 ingress capability를 ready로 만들지 않는다. old caller가 남은 rolling 창에는 그 caller가 만든 session/input을 v1로 유지하며, v2 session에 무ID 요청을 라우팅하지 않는다.

### 논리 메시지와 시도 분리

`session_deliveries`는 사용자 의도를 나타내는 논리 메시지다. `session_delivery_attempts`는 그 메시지를 특정 실행에 건네려 한 이력이다. attempt에 정확한 실행 identity가 없으면 “다른 delivery가 같은 runner에서 성공했으니 앞 delivery도 성공했을 것”이라는 현재 오판을 막을 수 없다.

```ts
type DeliveryResponsibility =
  | { state: "queued"; deliveryId: DeliveryId; enqueueSequence: bigint }
  | {
      state: "assigned";
      deliveryId: DeliveryId;
      enqueueSequence: bigint;
      attempt: AssignedDeliveryAttempt;
    }
  | {
      state: "reconciling";
      deliveryId: DeliveryId;
      enqueueSequence: bigint;
      attempt: AssignedDeliveryAttempt;
      reason: "result_unknown";
    }
  | {
      state: "retry_paused";
      deliveryId: DeliveryId;
      enqueueSequence: bigint;
      lastAttempt: AssignedDeliveryAttempt;
      wakeOn: "execution_activated" | "ownership_changed" | "maintenance_tick";
      nextWakeAt: IsoDateTime;
    }
  | { state: "consumed"; deliveryId: DeliveryId; receipt: DeliveryConsumptionReceipt }
  | { state: "rejected"; deliveryId: DeliveryId; proof: DeliveryRejectionProof }
  | { state: "cancelled"; deliveryId: DeliveryId; cancellationId: string }
  | { state: "superseded"; deliveryId: DeliveryId; successorDeliveryId: DeliveryId };

interface AssignedDeliveryAttempt {
  attemptId: string;
  attemptNumber: number;
  executionId: ExecutionId;
  ownershipGeneration: number;
  executionCommandId: ExecutionCommandId;
  payloadHash: string;
  assignedAt: IsoDateTime;
}

interface DeliveryConsumptionReceipt {
  attemptId: string;
  executionId: ExecutionId;
  executionCommandId: ExecutionCommandId;
  runnerInputSequence: number;
  consumedAt: IsoDateTime;
}

interface DeliveryRejectionProof {
  proofId: string;
  deliveryId: DeliveryId;
  kind: "payload_identity_conflict" | "authorization_denied" | "caller_cancelled_before_consumption";
  payloadHash: string;
  committedAt: IsoDateTime;
}
```

`uncertain`은 delivery의 종착지가 아니다. 이전 attempt의 결과를 아직 모른다는 뜻이면 `reconciling`이고, 같은 command의 runner input journal과 consumption receipt를 조회해 `consumed` 또는 `queued`로 끝낸다. 조회 전에는 새 attempt를 만들 수 없다.

재시도 횟수 소진도 종착지가 아니다. cadence를 늦추는 `retry_paused`이며 ownership 변화, 새 execution activation, maintenance tick이 모두 wake source다. `dead_letter`는 유효하고 이미 승인한 메시지의 상태에서 제거한다. `rejected`는 payload identity 충돌, 권한 거부처럼 **시스템이 durable admission 전에 또는 consumption 전에 명시적으로 비수용을 증명한 경우**에만 허용한다.

### 할당과 순서

application role의 delivery/attempt 직접 DML은 revoke한다. 유일한 write 경계인 `session_assign_delivery_head_v2(...)` stored procedure가 `session_delivery_heads`의 session별 head pointer와 open execution을 함께 잠근다.

1. `session_delivery_heads.head_delivery_id`와 `head_enqueue_sequence`가 가리키는 row만 고른다.
2. head가 `queued`가 아니면 뒤 delivery를 조회·할당할 권한 자체가 없다.
3. active execution row와 command identity를 읽는다.
4. `(delivery_id, attempt_number)` row에 `execution_id`, generation, command id를 기록한다.
5. runner durable input inbox에 같은 attempt id를 넣고 receipt fence를 만든다.
6. runner receipt 뒤에만 delivery를 `consumed`로 바꾸고, 같은 procedure가 head pointer를 정확히 다음 nonterminal delivery로 전진시킨다.

제약은 다음을 DB에서도 막는다.

- delivery 하나당 open attempt 최대 1개
- attempt 하나당 execution 정확히 1개
- consumption receipt의 `(delivery_id, attempt_id)` unique
- runner input의 `attempt_id` unique
- attempt의 `(session_id, enqueue_sequence)`가 현재 head와 다르면 procedure가 거부
- application role의 direct `INSERT/UPDATE/DELETE` revoke로 stored procedure 우회 금지

execution activation은 binder wake event를 같은 durable transaction에 넣는다. 복구가 끝나기 전에 온 개입은 `queued`로 머물고, 기존 execution이 `active`로 돌아오면 그 execution에, 이미 terminal이면 다음 execution에 할당된다. 어느 경우에도 호출자가 다시 보내지 않는다.

### admission과 외부 ACK

모든 입력 종류를 admission 정본으로 통합한다.

```ts
type ExecutionInputKind =
  | "user_message"
  | "intervention"
  | "ask_question_response"
  | "tool_approval"
  | "tool_result"
  | "interrupt"
  | "completion_notification"
  | "runtime_followup";

interface AcceptedInput {
  status: "accepted";
  deliveryId: DeliveryId;
  payloadHash: string;
}
```

orch는 node WebSocket을 호출하기 전에 delivery와 idempotency receipt를 Postgres에 commit한다. 정상일 때도 곧바로 node에 보내지 않고 binder를 깨운다. node 단절과 command timeout은 API 결과가 아니라 내부 지연 사유다.

`markQueued()`나 assignment CAS가 false이면 즉시 실패하지 않는다. caller가 준 stable delivery id로 canonical row를 재조회한다.

- `queued`, `assigned`, `reconciling`, `retry_paused`, `consumed`면 같은 `AcceptedInput`을 반환한다.
- identity가 다른 payload면 `delivery_rejection_proofs`를 먼저 commit한 뒤 409를 반환할 수 있다. 이는 restart 신호가 아니라 caller idempotency 위반이다.
- DB commit 결과 자체가 불명확하면 같은 idempotency key로 내부 재조회하며 HTTP 연결을 유지한다. 연결이 끊기면 caller transport가 같은 key로 자동 재시도하고 동일 receipt를 받는다.

route의 반환 타입은 `AcceptedInput | ProvenAdmissionRejection`뿐이고 node command 결과 타입은 들어오지 않는다. 현재 “queued-state CAS false → throw → 503”과 `sessions.py:408`의 node 단절 503은 이 경계가 생기면 구조적으로 사라진다. 외부에는 queued, auto-resumed, recovering 같은 disposition도 노출하지 않는다. 정상 경로와 재기동 경로의 응답을 같게 만들기 위해서다.

## 재기동 투명성

### 반드시 durable한 것

| 사실 | durable 위치 | 재기동 뒤 사용 |
| --- | --- | --- |
| 논리 실행 identity와 phase | 중앙 execution row | open inventory와 controller 재구성 |
| host termination intent | 중앙 intent row | interrupt·reap 요청 보존. visible terminal로 사용하지 않음 |
| runner terminal witness와 outbox high-watermark | runner lifecycle/outbox transaction | terminal 이전 출력 경계 증명 |
| terminal ingress receipt와 first visible signal | event ingress receipt + 중앙 first-signal CAS | 출력 receipt 뒤 중복 terminal 차단과 session 최종 투영 |
| runner child identity와 execute command | 중앙 row + runner bootstrap witness | exact process adopt·rollback |
| foreground progress와 in-flight tool lease | runner lifecycle + 중앙 monotonic projection | stalled 판정 |
| pending external request | runner request journal + 중앙 execution row | approval·AskUserQuestion 대기 보존과 progress reap suspension |
| engine 입력 | runner command/input journal | command 재전송 중복 차단 |
| engine 출력 | runner event outbox + IPC journal | event id 순서 replay |
| host call 요청·응답 | runner request journal + host idempotency receipt | host 교체 뒤 같은 correlation id 재개 |
| 사용자 입력과 FIFO | orch delivery ledger | 복구 전 입력 보존과 activation bind |
| delivery→execution attempt | delivery attempt row + runner input receipt | 결과 reconcile과 exactly-once |
| execution reconcile 책임·wake | 중앙 reconcile job + `reconcile_due_at` | 아무 입력이 없어도 자력 회수 |
| session semantics와 host capability | 중앙 cutover epoch + capability lease | v1 writer의 v2 row 접근 차단 |
| backend session id와 context mutation | 기존 durable session/event effect | 새 host Task hydration |

runner child는 soul-server shutdown 대상이 아니다. 계획 재기동에서 host는 `detachAttachment("host_shutdown")`만 수행한다. engine turn, runner SQLite, writer lock, child socket은 살아 남는다.

child가 보내는 host call은 전송 전에 correlation id와 payload를 runner journal에 기록한다. host attachment가 없으면 deadline error를 engine에 반환하지 않고 대기한다. 새 host가 붙으면 같은 요청을 replay하고, host는 idempotency receipt가 있으면 같은 응답을 돌려준다. request cadence는 조절할 수 있지만 retry budget은 책임을 끝내지 않는다.

출력은 host 메모리 stream이 아니라 runner outbox와 event ingress receipt를 기준으로 이어진다. dashboard는 재접속 뒤 마지막 event id 다음부터 replay한다. 실행 중 agent는 engine process가 계속 살아 있고 host call이 대기하므로 재시작을 오류로 관측하지 않는다.

### 복구 창 입력

복구 전 입력의 순서는 다음으로 고정한다.

1. caller가 첫 network send 전에 stable delivery id를 만들고 retry state에 보존한다.
2. orch가 입력을 durable admission하고 정상과 같은 `accepted`를 반환한다. node call은 ACK 조건이 아니다.
3. input은 session FIFO head chain에서 unassigned로 기다린다.
4. v2 capability host가 중앙 open execution과 pending external request를 hydrate한다.
5. exact child를 adopt하고 `recovering → active` 또는 `recovering → awaiting_external_input`을 commit한다.
6. activation/reattach wake가 FIFO binder를 실행한다.
7. bind procedure가 기존 command와 session head pointer를 다시 확인한다.
8. foreground active면 그 command inbox로, external response면 같은 pending request에, terminal이면 다음 execution의 첫 입력으로 들어간다.

“recovery 중이므로 queued” 같은 외부 결과는 없다. 호출자가 보는 것은 정상 때와 같은 accepted receipt와 늦게 도착한 실제 agent 응답뿐이다.

### 관측 불가능성 경계

| 내부 사건 | 정상과 같은 외부 표현 | 금지되는 표현 |
| --- | --- | --- |
| node WebSocket 단절 | admission 성공 후 지연 | 503, retry 요청 |
| dispatcher reconnect 소진 | event stream 유지, controller recovery | stream error, turn failure |
| host shutdown | child 계속 실행, output replay | interrupt, close event |
| adoption 지연 | delivery accepted, FIFO 대기 | queued/recovering 배지나 ACK |
| terminal 경합 | 첫 결과 한 번 | 중복 완료, 늦은 실패 |
| delivery result unknown | 내부 reconcile 뒤 결과 | uncertain/dead-letter 알림 |

`in_process` execution은 host process와 운명을 같이하므로 이 수용 기준을 만족할 수 없다. 과거 user-visible 실행 5건이 실제로 폴백을 탔으므로 사용처 수나 최근 빈도로 존속을 정당화하지 않는다.

v2 user-visible 진입은 durable admission 뒤 `reserved.executor.placement="waiting"`으로 남고 `execution_semantics_v2` capability를 가진 독립 runner가 배정될 때까지 기다린다. `session_execution_ownerships`의 CHECK는 `semantics_version=2 AND executor_kind <> 'independent_runner'`를 거부하고, v2 reserve procedure는 capability lease가 없는 host·runner identity를 받지 않는다. `TaskExecutor.startExecution()`의 in-process factory는 test·명시적 비사용자 내부 작업에서만 별도 capability로 남길 수 있으며 v2 admission type을 입력으로 받을 수 없다. 독립 runner 부재를 오류, 503, interrupted session으로 바꾸는 fallback은 없다.

## 불변식에서 구조로의 매핑

### 실행 불변식 16개

| ID | 불변식 | 위반이 구성상 불가능한 이유 | 강제 수단 |
| ---: | --- | --- | --- |
| E1 | session당 current execution 최대 1, 모든 참조 identity 일치 | required controller 하나와 DB open-execution unique 제약이 같은 `executionId`만 허용한다. | 타입 + DB CAS |
| E2 | 실행 lifecycle은 명시적 단일 상태기계 | 9 phase가 `TaskExecution` 판별 유니온이고 presence 판정 API가 없다. external request 1개 이상은 non-empty set을 가진 `awaiting_external_input`, 0개는 `active`로만 표현된다. 메모리와 v2 DB phase가 동형이다. | 타입 + DB phase/request CHECK |
| E3 | provisional spawn도 실행 | spawn proof와 attachment를 가진 `provisional`이 activation 전에 필수다. | 타입 + 단일 attach 경로 |
| E4 | 새 identity가 옛 자원과 격리 | callback과 transition이 branded `executionId + generation`을 요구한다. wire 경계는 DB identity CAS를 다시 검사한다. | 타입 + DB/runtime fence |
| E5 | runner·registration 소실 시 모든 waiter bounded settle | 모든 nonterminal row는 `reconcile_due_at NOT NULL`이고 1:1 reconcile job을 가진다. 5초 scan, 15초 absence grace, 두 scan 최대 10초, replacement capacity 60초로 predecessor waiter는 availability envelope 안에서 최대 85초에 내부 settle한다. waiter는 execution terminal/replacement row subscription에서 재구성된다. | DB CHECK/FK + leased job + reserved recovery capacity |
| E6 | 회수는 restart·reserve·message와 독립 | open execution insert가 같은 transaction에서 durable reconcile job을 강제하고, worker lease 만료가 job을 다시 runnable하게 만든다. | DB trigger/procedure + maintenance |
| E7 | reference clear는 종료가 아님 | public clear API가 없고 `terminal` DB phase는 terminal proof, ingress receipt, 모든 external request resolution, cleanup report가 없으면 CHECK에 실패한다. | 타입 + DB CHECK + 단일 경로 |
| E8 | terminal은 멱등, visible 결과 하나 | runner witness의 outbox high-watermark receipt 뒤 first-signal CAS만 visible terminal을 만든다. | DB unique/CAS + receipt FK |
| E9 | activeRunnerOperations는 실행과 함께 끝남 | 별도 begin/finish mutable set을 없애고 nonterminal controller/resource ledger의 순수 projection으로 계산한다. execution terminal이면 관측 row도 생성 불가다. | 타입 projection + DB execution FK |
| E10 | activation 실패 시 같은 generation active 또는 exact child dead | `provisional`은 exact child proof를 보유하고 failure가 proof-bearing `terminate()` 없이는 상태를 벗어나지 못한다. | 타입 + identity-fenced rollback |
| E11 | live child/open ownership/unreachable waiter의 제3상태 금지 | open phase별 필수 resource CHECK, 1:1 reconcile job, terminal proof CHECK가 무표현 상태를 거부한다. identity 불명은 제3상태가 아니라 명시적 `recovering(identity_unresolved)`다. | 판별 유니온 + DB CHECK/FK |
| E12 | rollback은 exact spawned child proof 사용 | `provisional.child` 없이는 rollback proof를 만들 수 없다. sidecar 최신값은 입력 타입이 아니다. | 타입 |
| E13 | recovery retry 또는 명시적 책임 | action receipt와 reconcile job update가 한 DB transaction이다. `scheduled`는 non-null `next_wake_at`, `completed`는 resulting phase를 요구한다. | 타입 + DB CHECK/transaction |
| E14 | execution inventory는 registration과 별도 reconcile | reconcile job은 execution row FK에서 생성되고 등록 테이블과 독립적으로 열거된다. registration 0건도 job 수를 0으로 만들지 못한다. | DB FK/procedure + full outer join |
| E15 | acquire/release 대칭 경계와 자원 순서 | attachment/resource token과 non-empty request set 생성자는 controller module private이고 resource ledger 없이는 attach phase를 구성할 수 없다. `TerminationSubject`가 activity 전체를 소유하며 terminal은 request별 resolution을 포함한 cleanup receipt inventory를 요구한다. TypeScript는 affine type을 지원하지 않으므로 private module 경계·architecture test·DB receipt가 선형성의 대체 강제다. | 타입/module boundary + DB CHECK + contract test |
| E16 | durable/process/memory 불일치는 한 결정표로 해결 | classifier는 사실만 만들고 exhaustive `Record<RunnerRecoveryDispositionV2, DispositionPolicy>`가 action을 강제한다. | exhaustive 타입 + runtime 검사 |

### delivery 불변식 10개

| # | 불변식 | 위반이 구성상 불가능한 이유 | 강제 수단 |
| ---: | --- | --- | --- |
| D1 | 승인된 논리 메시지는 재전송 없이 다음 유효 실행에 도달 | admission 뒤 책임 상태에는 폐기 terminal이 없고 queued/retry_paused를 maintenance와 activation이 깨운다. | DB 상태기계 + wake |
| D2 | attempt는 concrete execution 또는 explicit unassigned | `queued`에는 attempt가 없고 `assigned`부터 `AssignedDeliveryAttempt`가 필수다. | 판별 유니온 + DB NOT NULL |
| D3 | consumption 최대 1, durable tombstone | attempt id와 runner input receipt unique, delivery consumption receipt unique다. | DB unique + idempotency |
| D4 | unknown attempt reconcile 전 새 attempt 금지 | `reconciling`에 open attempt가 필수이며 binder는 queued만 할당한다. | 타입 + DB partial unique |
| D5 | session FIFO | `session_delivery_heads`가 유일한 assignable delivery를 가리키고 application role의 direct DML을 revoke한다. head advance와 attempt insert는 stored procedure 하나다. | DB head pointer + privilege fence + transaction |
| D6 | 새 execution activation이 redelivery를 깨움 | activation transaction이 durable binder wake를 함께 기록한다. | 단일 transaction |
| D7 | attempt budget은 cadence만 제어 | DB responsibility CHECK에는 `retry_paused`를 terminal로 인정하는 값이 없고, 해당 상태는 `next_wake_at NOT NULL`과 durable reconcile job을 요구한다. | 타입 + DB CHECK/FK |
| D8 | durable admission 또는 동일 receipt는 성공 ACK | `session_accept_input_v2`가 delivery와 idempotency receipt를 commit하고 그 반환만 generated `AcceptedInput`이 된다. node command 결과는 route 반환 union에 없다. cross-language caller는 stable ID로 내부 retry한다. 언어 하나의 타입으로 전 구간을 막을 수 없어 DB procedure·생성 스키마·transport contract test를 함께 쓴다. | DB procedure + generated contract + caller retry |
| D9 | failure는 비수용 증명 때만, uncertain은 pending | `rejected` row는 `delivery_rejection_proofs` FK와 proof kind/hash가 없으면 CHECK 실패한다. result unknown과 retry exhaustion에는 rejection proof를 만들 권한이 없다. | 판별 유니온 + DB FK/CHECK |
| D10 | 결과 판정은 assigned execution receipt만 사용 | verdict 입력에 attempt id, execution id, command id, runner sequence가 모두 필요하다. session liveness는 타입에 없다. | 타입 + receipt join |

## 사라지는 것

| 현재 | 새 구조 | 수량 변화 |
| --- | --- | ---: |
| Task 실행 optional 필드 12개 | required `execution: TaskExecutionController` | 12 → 1 |
| 실행 해제 partial mutation 지점 | `TaskExecutionController.terminate()` | 9 → 1 |
| 실행 해제로 오인된 host detach | `detachAttachment()` 비종료 연산 | 해제 9개 집계에서 분리된 1개 |
| dispatcher `closed`, stream `ended`, stream `error` | dispatcher/stream terminal 판별 유니온 | boolean·optional 3 → terminal state 1 |
| dispatcher terminal 진입점별 정산 | first-signal controller termination | 5 → 1 |
| 실행 생존을 부분 표현하는 자료구조 7개 | controller state + durable witness projection | 7 → 1 의미 정본 |
| `runnerTerminalFact` 별도 필드 | `ExecutionTerminalRecord.firstSignal.outcome` | 1 → 0 |
| `executionPromise`, activation promise/handoff, interrupt promise | `ExecutionWaiters` | optional 4 → required resource 1 |
| `runnerRetainedForClaudeBackground`, `runnerIsOfflineReplay` | `terminal.retention`, `recovering.method`, recovery handle kind | boolean 2 → variant 0 |
| `executionOwnership`, reservation, recovered ownership | phase별 reservation/proof/ownership | optional 3 → variant 0 |
| `dispositionRequiresTask`, `contendsForExecutionOwnership`와 분기 중복 | `DISPOSITION_POLICY` | 다중 helper → exhaustive table 1 |
| delivery `uncertain`, transient `dead_letter` | `reconciling`, `retry_paused` | 책임 종착지 2 → 0 |
| adoption 옛 필드 fixture | 제품 controller factory 기반 shared fixture | 구조 화석 1 제거, 계약 8 유지 |
| user-visible `createInProcessTaskRunnerRuntime` fallback | durable v2 independent-runner placement wait | 사용자 fallback 1 → 0 |
| owner-null → session `interrupted` backfill | `recovering(identity_unresolved)` → adopt/replacement | 사용자-visible interrupt 분기 1 → 0 |
| `execution_ended`를 terminal 사실로 해석 | witness 조회 wake only | terminal 정본 역할 1 → 0 |
| delivery assignment의 임의 row scan | `session_delivery_heads` stored procedure | assignment write 경로 N → 1 |

직접 field assignment인 `task.runner = undefined`, `task.executionPromise = undefined`, `task.runnerTerminalFact = ...`와 dispatcher `activeStream?.finish/fail`, `closed = true`는 전부 삭제 대상이다. 관측용 `NodeStallMonitor.activeRunnerOperations`는 남을 수 있지만 controller snapshot의 projection일 뿐 생존 판정에는 쓰지 않는다.

## 적용 순서

각 단위는 독립 커밋·독립 review가 가능해야 하고, 끝날 때 시스템은 계속 동작해야 한다.

| 단위 | 변경 | 단위 종료 시 관측 가능한 결과 | 호환 전략 |
| --- | --- | --- | --- |
| 0. 계약 고정 | 정상, pure adopt, 복구 창 intervention, runner-death, activation rollback RED를 영구 gate로 등록 | 제품 동작 변화 없음. 현재 결함 2종만 RED | 별도 테스트 세션이 수행 |
| 1. caller identity 선배포 | web/app action UUID, Slack event ID, MCP required `delivery_id`, respond/approval 결정 ID, interrupt invocation ID, cross-node field 관통 | v1 응답·실행 동작은 그대로지만 동일 logical action 재시도에 같은 ID가 보임 | ID는 shadow 기록만 하고 v2 admission 미활성 |
| 2. 중앙 스키마·fence additive | migration 073의 execution/delivery identity, semantics version, terminal witness/receipt, reconcile job, head pointer, capability/write fence 추가 | 제품 동작 변화 없음. v1 row만 기존 함수로 계속 동작 | v2 procedure 권한은 배포하되 cutover capability off |
| 3. 2-1 controller·external wait 도입 | 9-phase `TaskExecution`, 제품 factory, shared fixture, `awaiting_external_input` 전환. legacy 필드는 controller projection | 실행 결과 동일. provisional spawn·pending approval/request·waiter가 inspector에 명시 | v1 writer는 controller adapter만 호출, direct setter 금지 architecture test |
| 4. 2-2 terminal + 2-3 recovery | witness→receipt→visible terminal, first-signal stream, exhaustive decision table, durable reconcile jobs, owner-null identity-unresolved 도입 | terminal 경합 첫 결과 보존. 새 입력 없이 소실 실행 회수. approval 대기는 reap되지 않음 | v2 path는 capability off; v1 terminal projection 유지 |
| 5. 독립 executor 전환 | v2 placement scheduler와 DB executor CHECK를 연결하고 user-visible `createInProcessTaskRunnerRuntime` fallback 제거 | v2 dry-run row는 독립 runner가 없으면 waiting이고 실패하지 않음. in-process 선택 0 | v1 production traffic 유지, v2 shadow placement만 검사 |
| 6. attachment 투명화 | durable host-call journal/receipt, 30초 host-call deadline의 외부 실패 투영 제거, shutdown detach, adopt 후 outbox replay | v2 shadow 실행에서 host 부재가 engine error·turn 중단으로 나타나지 않음 | v1 runner witness adapter 유지, ingress ACK 아직 미전환 |
| 7. delivery·admission 완성 | execution-bound attempt, stored-procedure FIFO head, reconcile/retry_paused, `session_accept_input_v2`를 inactive gate 뒤에서 통합 | shadow 입력이 다른 delivery에 가려지지 않고 caller ID별 동일 receipt를 만듦 | 외부 route는 아직 v1 ACK. v2 end-to-end gate만 실험 |
| 8. 단일 capability cutover | caller ID, v2 DB writer, v2 host, 독립 runner, attachment transparency, binder가 모두 ready인 session에서 active v1 실행을 같은 PID·command의 v2 실행으로 원자 승격하고 cutover epoch 활성 | active v1의 drain을 기다리지 않고 그 순간부터 새 delivery가 같은 command에 bind. 정상·복구 창 모두 같은 accepted ACK와 event 순서 | exact identity가 없는 row는 `recovering(identity_unresolved)`. old host write lease는 같은 transaction에서 폐기 |
| 9. 구 표면 제거 | Task optional 12, partial cleanup 9곳, legacy disposition helper와 상태 projection 삭제 | 구조 화석 2 제거, direct mutation·v1 open execution 0 | 전 cluster v2 drain과 rollback window 종료 뒤 수행 |

단위 3에서 legacy field와 새 controller를 독립적으로 dual-write하지 않는다. controller가 유일한 writer이고 legacy getter는 controller state의 projection이다. 단위 2의 DB도 v1 row는 v1 함수, v2 row는 v2 함수만 쓰므로 중간 상태에서도 row별 정본은 하나다.

단위 5~7은 모두 `execution_semantics_v2` capability gate 뒤에서 완성하고 외부 traffic에는 노출하지 않는다. 특히 attachment 투명화와 active-v1 compatibility binder가 admission 전환보다 먼저 배포된다. 외부 ACK 전환은 단위 8 한 번뿐이며, cutover transaction이 host·runner capability lease와 caller identity capability를 다시 확인한다. 따라서 “입력은 accepted인데 실행 중 agent는 현행 host-call deadline으로 실패”하는 중간 배포가 없다.

현재 동작 기록 테스트 32개는 단위별 정책 변경표와 연결한다. 바뀐 정책을 기대한 RED만 새 계약으로 갱신하고, 나머지 RED는 회귀다. shared fixture 전환으로 따라오는 8개는 개별 수정하지 않는다.

## DB 마이그레이션과 구·신 호환

DB 변경은 필요하다. 실행 identity, first terminal, progress와 delivery assignment는 process memory만으로 재기동을 관통할 수 없기 때문이다. 이 설계 세션에서는 파일을 만들거나 적용하지 않는다.

계획하는 migration은 `073_execution_turn_state_machine.sql` 하나다.

### 중앙 DB 계획

`session_execution_ownerships`를 durable execution ledger로 확장한다.

- 최종형 `execution_id TEXT NOT NULL UNIQUE`. migration 첫 DDL에서는 nullable로 추가하고 deterministic v1 backfill 뒤 전환한다
- 최종형 `semantics_version SMALLINT NOT NULL`과 `executor_kind TEXT NOT NULL`. migration 첫 DDL에서는 nullable로 추가한다
- `CHECK (semantics_version <> 2 OR executor_kind = 'independent_runner')`
- v2 phase constraint에 `reserved`, `provisional`, `activating`, `active`, `awaiting_external_input`, `recovering`, `terminating`, `terminal`; v1 `identity_proven/failed`는 version별 compatibility branch
- `ownership_proof_id TEXT`, `activation_receipt_id TEXT`와 phase별 identity shape CHECK
- `pending_external_requests JSONB`, `request_resolution_receipts JSONB`; key uniqueness와 phase별 empty/non-empty CHECK. response/expiry/cancel은 runner-journal proof, execution terminal은 cleanup proof만 허용
- `termination_intent JSONB`, `runner_terminal_witness JSONB`, `terminal_ingress_receipt JSONB`
- `first_terminal_signal JSONB`, `first_terminal_committed_at TIMESTAMPTZ`; visible terminal은 witness/receipt 또는 preactivation proof가 없으면 거부
- `progress_seq BIGINT`, `progress_kind TEXT`, `progress_at TIMESTAMPTZ`
- `progress_lease_expires_at TIMESTAMPTZ`, `tool_leases JSONB`
- `cleanup_state TEXT`, `cleanup_report JSONB`
- `attachment_epoch BIGINT`
- `reconcile_due_at TIMESTAMPTZ`; nonterminal이면 non-null, terminal이면 null
- open phase 전체를 대상으로 한 session당 unique partial index
- `session_reserve_execution_v2(...)` semantics/capability/executor fence
- `session_commit_runner_terminal_witness_v2(...)` witness high-watermark CAS
- `session_commit_execution_terminal_v2(...)` receipt 검증 뒤 first visible signal CAS
- `session_replace_execution_v2(...)` predecessor proof와 successor responsibility의 원자 handoff
- `session_promote_open_execution_v1_to_v2(...)` exact v1 identity·attachment receipt를 같은 execution/command의 v2 phase로 원자 승격
- `session_assign_delivery_to_promoted_command_v2(...)` 승격된 active command에 head delivery를 bind하고 deterministic runner input identity를 기록
- `session_assign_delivery_to_legacy_bridge_v2(...)` migration 시점의 open `legacy_in_process` command에만 허용되는 compatibility bind
- `session_list_open_executions(node_id, limit)` inventory 함수

`execution_reconcile_jobs`는 open execution과 1:1 FK를 가진다. `state`, `next_wake_at`, `lease_owner`, `lease_expires_at`, `last_receipt`을 보유하고 open row 생성·전이 transaction에서만 갱신한다. owner-null row도 `identity_unresolved` job으로 들어간다.

기존 physical 이름은 rolling window 동안 유지한다. 이름은 설계 정본이 아니며 repository가 `DurableExecutionRecord`로 감싼다. 테이블 rename은 정확성에 기여하지 않고 구 stored function을 깨뜨리므로 이 migration의 대상이 아니다.

`session_delivery_attempts`에는 다음을 더한다.

- `attempt_id TEXT UNIQUE`
- `execution_id TEXT`
- `ownership_generation BIGINT`
- `execution_command_id TEXT`
- `execution_semantics_version SMALLINT`, `assignment_kind TEXT`; 일반 v2 attempt는 v2 execution만, `legacy_bridge`는 migration에서 표식된 open v1 command만 참조
- `assignment_state TEXT`
- `runner_input_sequence BIGINT`
- `resolved_at TIMESTAMPTZ`
- open attempt unique partial index와 execution FK

`session_deliveries`에는 `responsibility_state`를 추가한다. 이것이 새 정본이고 기존 `state`, `aggregate_state`, `uncertain`, `dead_letter`는 rolling compatibility projection으로만 갱신한다. 새 코드는 projection을 읽지 않는다.

추가 표와 제약은 다음과 같다.

- `session_delivery_heads(session_id PRIMARY KEY, head_delivery_id, head_enqueue_sequence, version)`와 FK
- `delivery_rejection_proofs(proof_id PRIMARY KEY, delivery_id UNIQUE, kind, payload_hash, committed_at)`
- `execution_host_capabilities(host_instance_id, capability, semantics_version, lease_epoch, lease_expires_at)`
- `execution_ingress_capabilities(caller_kind, semantics_version, release_id, ready_at, retired_at)`; 지원 중인 모든 caller kind가 v2 ready여야 cutover 가능
- `session_execution_semantics(session_id PRIMARY KEY, active_version, cutover_epoch)`
- `session_deliveries.delivery_id`는 caller가 준 stable ID이고 `(delivery_id, payload_hash)` idempotency receipt가 정본
- `session_deliveries.semantics_version`은 admission procedure가 session cutover epoch에서 복사하며 v1/v2 writer fence에 포함
- `session_assign_delivery_head_v2(...)`, `session_accept_input_v2(...)`만 delivery/attempt/head를 쓸 수 있으며 application role의 관련 table 직접 DML은 revoke
- `retry_paused`는 `next_wake_at NOT NULL`, `rejected`는 rejection proof FK, v2 delivery는 `responsibility_state NOT NULL` CHECK

마이그레이션 산출 단계에서는 다음 세 곳을 같은 커밋에서 갱신한다.

1. `packages/db-schema/sql/migrations/073_execution_turn_state_machine.sql`
2. `packages/db-schema/migration-manifest.json`의 sha256·rollback compatibility
3. `packages/db-schema/sql/schema.sql`의 bootstrap 동형 정의

runner SQLite는 중앙 migration과 별도로 additive schema upgrade를 한다. execution id, command id, input sequence, terminal witness와 outbox high-watermark, delivery attempt id, pending external request 집합과 resolution receipt, fixed tool lease, durable host-call request/response를 추가한다. 중앙 execution row가 책임 정본이고 runner SQLite는 child가 host 부재 중 남기는 증거다. reconcile이 monotonic sequence와 identity fence를 검증한 뒤 중앙 정본에 투영한다.

### migration 073의 라이브 데이터 순서

2026-08-23 실측은 `session_execution_ownerships` 6,319행이며 `active=2`, `identity_proven=2`, `reserved=1`, `failed=5,804`, `terminal=510`이다. `semantics_version`, `executor_kind`, `reconcile_due_at`은 아직 없다. 이 수치는 migration의 가정이 아니라 검증 fixture다. 실제 적용 직전 같은 query를 다시 실행하고 발견한 모든 phase·owner kind를 분류한다.

073은 다음 순서로만 실행한다.

1. `semantics_version`, `executor_kind`, `execution_id`, v2 phase/proof/request/terminal 필드, `reconcile_due_at`을 **nullable**로 추가한다. 이 단계에서 `NOT NULL`이나 validated CHECK를 걸지 않는다.
2. 기존 v1 insert/update procedure를 compatibility wrapper로 교체해 새로 쓰이는 row가 즉시 `semantics_version=1`, owner kind에서 결정한 executor kind, 결정적 `execution_id='legacy:' || session_id || ':' || ownership_generation`을 받게 한다. application role direct DML은 이 wrapper 배포 뒤 revoke한다. backfill 중 새 null row가 생기지 않는 write fence다.
3. 기존 6,319행을 primary-key 순 bounded batch로 backfill한다. `runner_process/adopted_runner → independent_runner`, `in_process → legacy_in_process`로 기록하고, v1 phase는 그대로 둔다. terminal/failed row는 `reconcile_due_at=NULL`, open `reserved/identity_proven/active` row는 `reconcile_due_at=NOW()`로 둔다.
4. 같은 transaction 계열에서 **모든** open v1 row를 `execution_reconcile_jobs`에 `INSERT ... ON CONFLICT`한다. 실측 5행만 하드코딩하지 않는다. `reserved`는 placement, `identity_proven`은 activation recovery, `active`는 attachment/adoption job이며, owner-null·불완전 identity는 `identity_unresolved` job이다.
5. 기존 phase constraint보다 넓은 version별 phase·identity·request·terminal·reconcile shape CHECK를 `NOT VALID`로 추가한다. 검증 query가 null execution/semantics/executor, duplicate execution id, session별 복수 open row, open row without job/due, terminal row with due, identity shape mismatch를 각각 0건으로 확인한 뒤 `VALIDATE CONSTRAINT`하고 구 phase constraint를 제거한다. 복수 open v1 row가 나오면 삭제하거나 interrupt하지 않고 exact current row 하나를 보존하며 predecessor를 proof-bearing `terminating/recovering`으로 옮긴 뒤 다시 검증한다.
6. validated non-null CHECK를 이용해 lock을 제한한 채 `execution_id`, `semantics_version`, `executor_kind`를 `SET NOT NULL`로 전환하고 execution id unique constraint를 건다. 이때까지 v1 wrapper와 v2 procedure 모두 값 없는 write를 거부한다.
7. 마지막에 open-row unique index와 v2 procedure/capability fence를 활성화한다. migration transaction 종료 뒤 inventory count와 reconcile job count를 다시 읽어 모든 open row가 정확히 한 책임 job을 갖는지 확인한다.

`legacy_in_process`는 backfill 분류일 뿐 v2 reserve가 선택할 수 있는 executor가 아니다. 해당 open row가 있으면 unit 5가 새 입력은 v2 ledger에 승인·대기시키고 old generation을 compatibility bridge로 유지한 채 다음 durable command boundary에서 독립 runner successor로 원자 handoff한다. session ingress cutover를 drain 뒤로 미루지는 않지만, old process를 그 전에 종료하지도 않는다. 신규 user-visible v2 execution은 처음부터 `independent_runner`만 허용한다.

### active v1 실행의 in-place v2 승격

결정은 **(a) active v1을 같은 실행으로 승격**이다. open v1 execution이 0이 될 때까지 기다리지 않고, 기존 독립 runner의 PID·start identity·`executionCommandId`·manifest·event/outbox watermark를 보존한다. 새 모델 turn이나 replacement execution을 만들지 않으므로 이미 진행 중인 tool·thinking·context도 끊지 않는다.

`session_promote_open_execution_v1_to_v2(...)`는 다음 순서의 단일 cutover procedure다.

1. v2 host가 exact v1 row와 runner lifecycle/bootstrap을 shadow-read하고 `execution_semantics_v2`, attachment journal, compatibility input adapter capability를 증명한다. live v1 host가 붙어 있어도 이 preflight에서는 detach하거나 writer lease를 바꾸지 않는다. 대신 child를 살린 채 넘길 수 있는 prepared handoff token을 만든다.
2. `execution_id`는 migration에서 고정한 `legacy:{session_id}:{ownership_generation}`을 그대로 쓴다. runner lifecycle의 registration/PID/start identity/command가 중앙 row와 일치해야 exact promotion이 가능하다. 불일치하면 row를 없애거나 interrupt하지 않고 같은 transaction의 `recovering(identity_unresolved)` branch로 들어간다.
3. procedure는 session semantics row, open execution row, delivery head를 `FOR UPDATE`로 잠근다. v1 `reserved → v2 reserved`, v1 `identity_proven → v2 activating`, v1 `active → v2 active`로 매핑하고 proof·activation compatibility receipt, progress/outbox watermark, reconcile job을 기록한다. `identity_proven → activating`은 `prepareSession`/activation ACK를 다시 거치며 active로 추측 승격하지 않는다.
4. 같은 transaction에서 execution promotion, attachment epoch, DB writer lease epoch, `session_execution_semantics.active_version=2`를 함께 CAS한다. exact attachment가 아직 없으면 execution은 `recovering`이지만 v2 admission은 이 commit부터 즉시 열려 입력을 durable queue에 받는다. 이전 v1 host의 lease는 즉시 만료돼 commit 이후 reserve/activate/terminate/update가 DB에서 거부된다. transaction과 경합한 요청은 commit 전 v1 또는 commit 후 v2 중 한 경로에만 직렬화되고, commit 후에는 node command 실패를 ACK에 쓰는 경로가 없다.
5. 이미 승인된 session head가 있고 승격 phase가 `active`면 `session_assign_delivery_to_promoted_command_v2(...)`가 같은 transaction에서 attempt를 기존 `execution_id/execution_command_id`에 bind한다. `activating/recovering`이면 attempt를 만들지 않고 binder wake를 기록한다. activation/reattach transaction이 같은 head를 이어서 bind한다.
6. `LegacyExecutionInputAdapter`는 v2 attempt를 기존 frame protocol의 `deliveryId`와 deterministic `inputUuid=buildDeliveryInputUuid(deliveryId)`로 투영한다. rolling v1 runner에서는 기존 `runner_intervention_inbox.intervention_id=deliveryId` primary key와 `claimed_execution_command_id`가 중복·다른 command 소비를 막고, v2 runner에서는 이를 `(attempt_id, runner_input_sequence)` receipt로 확장한다. 두 경우 모두 중앙 attempt가 exact runner receipt와 맞아야 consumed가 된다. 응답 전 host가 죽으면 reconcile이 같은 delivery/input UUID만 재전송하므로 중복 turn을 만들지 않는다.
7. commit 뒤 old host는 prepared token으로 `detachAttachment("adoption_handoff")`하고 v2 controller는 동일 execution/command를 hydrate한다. old host가 먼저 죽었으면 detach receipt를 기다리지 않고 중앙 row·runner lifecycle로 adopt한다. procedure 전 crash는 전부 rollback돼 v1 row와 lease가 유지되고, procedure 후 crash는 v2 reconcile job이 계속한다. v1과 v2가 동시에 정본인 중간 row는 없다.

`legacy_in_process`는 PID 밖으로 현재 engine state를 옮길 durable witness가 없으므로 거짓으로 in-place 승격하지 않는다. 앞 절의 compatibility bridge가 v2 ingress를 먼저 열고 old generation을 current command의 물리 executor로 유지한다. v2 attempt는 명시적으로 그 v1 command를 target으로 갖고, `session_assign_delivery_to_legacy_bridge_v2(...)`만 bridge inbox에 deterministic input UUID를 쓸 수 있다. successor handoff receipt 전에는 restart controller가 그 old generation을 종료할 수 없다. 이는 session cutover를 drain 뒤로 미루는 것이 아니라 **cutover 뒤 물리 executor retirement만 지연**하는 경로다. 이 bridge가 준비되지 않은 node에는 unit 8 capability가 발급되지 않는다.

### rolling coexistence

1. additive 073을 먼저 배포한다. v1 function은 `semantics_version=1` row만 쓸 수 있고 v2 function은 caller의 live capability lease와 `writer_semantics_version=2`를 검사한다.
2. 기존 v1 writer inventory를 전수 확인하고, direct DML 호출이 있으면 같은 signature의 v1 compatibility procedure로 먼저 옮긴다. 그 뒤 application role의 direct execution/delivery DML을 revoke한다. v1 procedure는 v2 row reserve/activate/terminate/update를 DB에서 거부한다. rollback·늦은 재접속·부분 배포도 이 fence를 우회하지 못한다.
3. semantics v2 host는 v1 runner bootstrap을 `LegacyExecutionWitnessAdapter`로 읽을 수 있지만, v1 host는 v2 row를 읽기 전용 조회만 할 수 있다. v2 row에 ownership을 claim할 수 없다.
4. orch routing은 `execution_host_capabilities`의 unexpired `execution_semantics_v2` lease가 있는 host·runner에만 v2 session을 보낸다. 가능한 host가 없으면 admission된 delivery와 reserved placement가 기다리며 old host로 downgrade하거나 실패하지 않는다.
5. v2 row의 정본은 `responsibility_state`와 v2 execution phase다. legacy `state`/`aggregate_state`는 v2 procedure가 만드는 역방향 read projection일 뿐이고 v1 writer가 수정할 수 없다. v1 row는 기존 column이 정본이므로 row별 정본이 하나다.
6. v2 runner는 rolling 기간에 기존 `frame_protocol` 형식과 bootstrap projection을 함께 기록한다. Zod 형식 정본은 유지하고 `semantics_version`이 의미 계약을 가른다.
7. session cutover는 caller identity, DB writer, host, independent runner, attachment, compatibility binder capability를 한 번에 확인하고 `session_promote_open_execution_v1_to_v2(...)` 안에서 `cutover_epoch`를 CAS한다. active v1 row가 있어도 같은 execution/command로 승격하거나 identity-unresolved 책임으로 옮기며 drain을 기다리지 않는다.
8. rollback 시 이미 열린 v2 execution은 capability lease가 남은 v2 host가 drain·handoff한다. v1 binary로 강제 인계하지 않으며, DB fence 때문에 운영 순서를 어겨도 v1 writer가 v2 정본을 훼손하지 못한다.

이 공존 전략에서도 사용자 ACK는 admission receipt 하나다. 구·신 runner 선택이나 handoff 대기는 외부 결과에 나타나지 않는다. “구 host가 v2-only 실행을 만나지 않게 배포한다”는 운영 희망이 아니라 DB write fence와 capability routing이 정본 하나를 강제한다.

## 검증자가 확인할 열어 둔 질문

1. engine별 비멱등 host call inventory는 무엇인가. correlation receipt만으로 충분한 호출과 별도 operation receipt·보상 transaction이 필요한 호출을 전수 열거해야 한다.
2. runner process 자체 crash에서 Claude, Codex 두 모드, Agents 각각 같은 command를 checkpoint-resume할 수 있는가. 불가능한 backend는 process-absence proof 뒤 replacement continuity로 수렴하지만, 이미 engine 내부에서 실행된 비멱등 tool effect를 어떻게 증명할지는 별도 검증이 필요하다.
3. capability cutover의 최소 단위를 session으로 둘지 node로 둘지 운영·부하 실측이 필요하다. 정확성 조건은 어느 쪽이든 DB cutover epoch와 unexpired host/runner/caller capability를 한 transaction에서 확인하는 것이다.
4. 배포 당시 존재할 수 있는 가장 오래된 v1 runner schema가 deterministic input UUID와 outbox high-watermark를 모두 제공하는가. 제공하지 않으면 in-place promotion이 아니라 같은 `identity_unresolved → replacement` branch를 타며, drain 대기로 남기지 않는다.
5. external input 대기 중 runner process가 죽고 pending request UI가 이미 노출된 경우 replacement가 같은 request id를 재노출하지 않고 이어받는 exact receipt shape를 검증해야 한다.

## 설계 검증 통과 조건

- 문서의 9 phase가 실제 entry/terminal/external-input 경로를 MECE로 덮고, silent return이나 direct clear가 필요한 사례가 없어야 한다.
- 실행 불변식 16개와 delivery 불변식 10개가 각각 최소 한 개의 타입, DB 제약, 단일 경로, runtime reconcile에 연결되어야 한다.
- 정상, pure adopt, 복구 전 intervention 세 시나리오가 행 단위 trace에서 같은 ACK와 semantic event 순서를 보여야 한다. 현재 ③의 503·event 2종 소실·pending receipt가 모두 사라져야 한다.
- runner-death와 activation rollback 영구 RED가 새 구조에서는 각각 bounded terminal settle과 exact child cleanup으로만 green이 되어야 한다.
- #818의 2-2 기존 green 0 파단, 2-3 37 passed를 기준선으로 삼고, 2-1은 shared fixture 한 곳 변경으로 계약 8개를 보존해야 한다.
- Claude `text`, Codex 두 mapper, Agents 완료 output이 semantic progress 3종으로 exhaustive하게 정규화되고, 30분 gap·30분 tool absolute lease·external wait suspension의 경계 테스트가 있어야 한다.
- 한 execution에 external request 2개 이상을 열고 하나씩 response/expiry/cancel하는 테스트, 마지막 request에서만 active로 돌아가는 테스트, terminating이 전 request resolution receipt를 요구하는 테스트, Claude 300초 expiry 뒤 late response가 재기동 유무와 무관하게 같은 `expired`를 반환하는 테스트가 있어야 한다.
- ownership proof 직후, `prepareSession` 중, activation ACK 직전 crash가 각각 durable `activating`으로 hydrate되고 v1 `identity_proven`을 v2가 직접 만들지 않는 DB phase 계약 테스트가 있어야 한다.
- active v1 runner를 승격하는 동안 같은 PID·command·manifest를 보존하고 concurrent delivery가 기존 command에 정확히 한 번 bind되며 late v1 write가 거부되는 trace가 있어야 한다. open v1 execution 0건을 사전조건으로 삼으면 실패다.
- migration 073은 6,319행 fixture와 migration 중 concurrent v1 insert fixture에서 nullable 추가→backfill→job 생성→CHECK validate→NOT NULL 순서를 dry-run하고 open 5행 전부에 정확히 한 reconcile job이 생겨야 한다.
- caller 8계열이 첫 send 전 stable ID를 만들고 commit-after-response-loss에서 같은 receipt를 받는 transport test를 통과해야 한다.
- 제품 코드 구현 전에 migration 073의 forward/rollback compatibility, direct DML revoke, v1 writer→v2 row 거부, capability routing을 별도 검토해야 한다.

## 중간 결론

재기동 투명성은 더 많은 예외 처리로 얻지 못한다. 실행 턴, 그 턴에 할당된 입력, 첫 terminal과 자원 수명을 하나의 identity와 상태기계로 묶고, 정상 경로도 같은 durable 경계를 통과시킬 때만 재기동이 평상시와 구분되지 않는다.
