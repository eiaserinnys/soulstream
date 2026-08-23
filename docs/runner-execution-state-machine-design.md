# 실행 턴 1급 상태기계 재설계

기준 커밋: `e5d66742` (2026-08-23, PR #819 포함)

상태: 설계 5차·마지막 문서 라운드. 앞선 검증의 중심축은 유지하되, 중복 안전장치를 제거하고 타입·lease·receipt의 불완전한 계약만 바로잡았다. 제품 코드, DB 마이그레이션, 배포는 이 문서의 범위가 아니다.

## 판정 기준

이 설계의 성공 조건은 하나다.

> 사용자와 실행 중인 에이전트는 서버 재시작을 알 수 없어야 한다. 대시보드가 내려가는 것과 전달이 보장된 지연만 허용한다. 오류, 503, 재시도 요구, 턴 중단, 응답 누락, 중복, 컨텍스트 유실은 모두 실패다.

따라서 “실패를 정직하게 알렸다”, “큐에 넣었다고 알려 줬다”, “다시 보내면 된다”는 수용되지 않는다. 정상 경로와 재기동 경로가 같은 입력 승인 계약, 같은 출력 스트림, 같은 최종 결과를 사용해야 한다.

## 설계 결정 요약

현재 결함의 뿌리는 러너가 아니라 **실행 중인 한 턴을 나타내는 1급 개념의 부재**다. 다음 열 결정을 함께 적용한다.

1. `Task`의 실행 관련 optional 필드 12개를 항상 존재하는 `execution: TaskExecutionController` 한 필드로 바꾼다.
2. 실행은 `idle`, `reserved`, `provisional`, `activating`, `active`, `awaiting_external_input`, `recovering`, `terminating`, `terminal`의 판별 유니온이다. provisional spawn은 활성화 전이라도 이미 실행이고, 사람 입력을 기다리는 상태도 살아 있는 실행이다.
3. 획득은 `begin()`에서, 해제는 `terminate()`에서만 일어난다. 필드 삭제는 상태 전이가 아니다.
4. dispatcher의 접속 수명과 실행 수명을 분리한다. `detachHost()`는 접속만 반납하며 실행을 종료하거나 스트림을 실패시키지 않는다.
5. 중앙 DB의 열린 실행 inventory와 fenced reconcile saga를 자력 회수의 정본으로 삼는다. 등록 디렉터리는 증거이지 inventory가 아니며, 물리 zero-process는 다음 시도의 선행 조건이 아니다.
6. 모든 사용자 입력은 먼저 durable delivery로 승인한 뒤 정확한 `executionId`에 할당한다. 호출자에게는 정상·복구 여부와 무관하게 같은 `accepted` 응답만 반환한다.
7. user-visible 실행은 `in_process`로 폴백하지 않는다. durable admission 뒤 semantics v2 독립 runner가 준비될 때까지 기다리며, 기다림을 오류나 503으로 바꾸지 않는다.
8. host의 종료 의도와 runner의 durable terminal 증명을 분리한다. 출력과 terminal witness가 먼저 durable해지고 그 receipt를 확인한 뒤에만 중앙 visible terminal을 commit한다.
9. host attachment는 중앙 DB lease와 runner journal이 공유하는 monotonic epoch다. 모든 양방향 command에 epoch를 넣고 runner가 stale writer를 실행 전에 거부한다.
10. replacement는 backend별 `ExecutionContinuityCertificate`가 있을 때만 가능하다. 인증서 없는 legacy executor를 옮기는 bridge는 만들지 않으며, 안전한 executor가 아니면 v2 capability를 발급하지 않는다.

5차는 메커니즘을 더하지 않는다. attempt namespace와 capability revoke가 논리적 격리를 이미 보장하므로 persistent supervisor의 zero-process gate를 삭제한다. cleanup barrier는 임의 step 배열 대신 유한한 receipt record로 줄이고, recovery saga의 기존 lease에는 monotonic claim fence를 넣는다. 안전성과 활성이 충돌하는 고아 child에서는 **논리적 격리 뒤 successor 진행**을 택한다. 물리 process 회수는 내부 maintenance 책임이지만 실행 진행을 막지 않는다.

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
- 현행 command frame에는 attachment/writer epoch가 없고 (`frame_protocol.ts:78`), runner child는 현재 socket의 intervention·interrupt·close를 epoch 검사 없이 실행한다 (`runner_child_runtime.ts:211`). DB writer lease만 바꾸는 handoff는 runner command plane의 늦은 writer를 막지 못한다.

### 260823 두 교착에서 확인된 사실

두 표본의 수동 회수 순서는 인과 증명이 아니다. 1차(kill→restart)에서는 회수 뒤 orphan spawn이 관측됐고, 2차(restart→kill→ping)에서는 관측되지 않았다. 각각 `n=1`이므로 “회수 직후 orphan이 반드시 생긴다”거나 특정 수동 순서가 정답이라는 주장은 삭제한다.

확정할 수 있는 사실은 셋뿐이다.

- 12:01 표본은 runner process가 사라진 뒤 host memory·중앙 ownership이 남은 **process-absence 불일치**였다.
- 18:06 표본은 `reserve → prove → activate applied:true` 뒤 live PID와 새 host command plane이 서로를 정본으로 인정하지 못한 **attachment split-brain**이었다. runner에는 `Runner host request timed out after 30000ms`가 기록됐고 18:06:29 이후 event가 끊겼다.
- 현재 `runner_process_registration.ts:23-30`은 session-scoped PID 후보 중 하나라도 살아 있으면 `runner pid evidence disagrees`를 낸다. 따라서 실패 attempt의 PID 후보가 다음 attempt 판정에 섞일 가능성은 코드 수준에서 실재한다. 이를 막는 근거는 사고 순서가 아니라 `(executionId, spawnAttemptId)` namespace와 revoked attempt의 canonical join 제외다.

두 intervention은 delivery row에 등재된 뒤 queued-state CAS가 빗나갔고 caller에는 503이 반환됐으며, 복구 뒤에도 `queued`로 남았다. CAS miss는 접수 실패가 아니다. v2 admission은 stable delivery id로 canonical receipt를 재조회해 `queued/assigned/reconciling/retry_paused/consumed` 중 하나면 항상 같은 `accepted`를 반환하고, execution phase 복귀 transaction이 binder wake를 남긴다.

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
- 등록 소멸 뒤 waiter는 중앙 열린 실행 inventory와 fenced saga를 따라 재구성된다. 외부 timeout은 없으며, 무제한 worker fail-stop까지 포함한 유한 settle bound는 주장하지 않는다.
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
| 4 | execution bind | session head를 현재 `executionId/executionCommandId`에 bind | adopt가 보존한 같은 execution/command와 higher attachment epoch에 bind | recovering 중 queued; runner attachment barrier 또는 eligible active-v1 승격 receipt 직후 **같은 열린 command**에 bind |
| 5 | runner input | `runnerInputSequence=N` inbox receipt 뒤 consume | 동일 | 복구 대기만 늘고 동일 receipt |
| 6 | semantic event | `user_message → tool_start → intervention_sent → tool_result → 개입이 반영된 단일 assistant_message` | 동일 순서·event id dedupe | 동일 순서·event id dedupe. `intervention_demand/context_reply` 소실 없음 |
| 7 | delivery 정산 | `consumed`, attempt와 input receipt가 동일 execution을 가리킴 | 동일 | 동일. `queued/pending` 영구 잔류 없음 |
| 8 | caller 재조회·재전송 | 같은 delivery receipt를 반환 | 동일 | admission 응답 전에 orch가 죽어도 같은 stable ID로 동일 receipt 반환 |

③의 내부 trace는 `accepted → queued(recovering) → host capability 확인 → higher-epoch attachment barrier 또는 eligible active-v1 in-place promotion → binder wake → bind → consumed`다. spawn failure가 끼면 `quarantine old attempt → isolated successor attempt → activation binder wake`가 들어가지만 외부 행은 변하지 않는다. 이 내부 phase와 대기 시간은 ACK·session status·agent stream에 투영하지 않는다. 이 표의 행 3·6·7이 PR #819 transparency oracle의 비교 대상이고, 세 열의 값이 다르면 v2 cutover를 열지 않는다.

검증 라운드별 폐쇄표는 삭제했다. 같은 계약을 이력별로 반복하면 장치가 늘어난 것처럼 보이고 정본이 갈린다. 현행 정본은 아래 타입·전이표·불변식 매핑뿐이며, 5차에서 바뀐 핵심은 preactivation recovery context, fenced saga, logical isolation, 고정 cleanup receipt, gap-free attachment receipt, v1 admission cutoff, honest eventual settle, request publication identity다.

## 시스템 그림

### A. 진입 경로 매트릭스

| # | 진입 | 현재 조립 위치 | 새 구조의 첫 호출 | 실행 identity |
| ---: | --- | --- | --- | --- |
| 1 | 최초 턴 | `task_executor.ts:374` | `task.execution.begin({ entryPath: "initial" })` | begin 전에 생성한 `executionId` |
| 2 | 자동 재개 | `task_auto_resume_transition.ts:67` | durable input 승인 후 `begin({ entryPath: "auto_resume" })` | 새 `executionId`, delivery는 activation 뒤 할당 |
| 3 | live runner adopt | `task_executor.ts:723` | `beginRecovery({ method: "adopt" })` | 중앙 open execution의 기존 `executionId` |
| 4 | offline terminal replay | `task_executor.ts:788` | `beginRecovery({ method: "offline_replay" })` | runner witness와 중앙 row가 가리키는 기존 `executionId` |
| 5 | certified replacement | `task_executor.ts:1030` | predecessor process-absence proof와 `ExecutionContinuityCertificate` 뒤 새 `begin({ entryPath: "replacement" })` | 앞 실행과 다른 새 `executionId`; certificate 없으면 진입 불가 |
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
  → attempt-scoped namespace의 독립 runner spawn/isolation
  → DB prepare → runner quiesce barrier → DB commit attachment
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
| attachment command 추가 | DB grant procedure, frame envelope, runner epoch journal, host dispatcher, stale-frame no-effect test |
| spawn identity 추가 | execution current-attempt pointer, attempt table, attempt별 state namespace, registration join, quarantine cleanup |
| replacement backend 추가 | continuity capability, checkpoint adapter, effect inventory hash, certificate DB CHECK, duplicate-effect test |

## 1급 타입 정의

다음은 구현 목표 시그니처다. 타입 이름과 필드 의미는 계약이며 실제 구현 단계에서 임의로 optional로 약화하지 않는다.

```ts
type ExecutionId = string & { readonly __brand: "ExecutionId" };
type DeliveryId = string & { readonly __brand: "DeliveryId" };
type ExecutionCommandId = string & { readonly __brand: "ExecutionCommandId" };
type ExternalRequestId = string & { readonly __brand: "ExternalRequestId" };
type SpawnAttemptId = string & { readonly __brand: "SpawnAttemptId" };
type AttachmentEpoch = number & { readonly __brand: "AttachmentEpoch" };
type RunnerCommandSequence = number & { readonly __brand: "RunnerCommandSequence" };
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
  spawnAttemptId: SpawnAttemptId;
  stateNamespace: string;
  registrationId: string;
  pid: number;
  startIdentity: string;
  executionCommandId: ExecutionCommandId;
}

type SpawnAttemptDisposition =
  | { phase: "prepared"; attemptId: SpawnAttemptId; stateNamespace: string }
  | { phase: "spawned"; attemptId: SpawnAttemptId; child: SpawnedChildProof }
  | { phase: "activated"; attemptId: SpawnAttemptId; child: SpawnedChildProof }
  | {
      phase: "quarantined";
      attemptId: SpawnAttemptId;
      child: SpawnedChildProof;
      isolation: SpawnAttemptIsolationReceipt;
      physicalCleanupOwner: CleanupResponsibilityOwner;
      cleanupWakeAt: IsoDateTime;
    }
  | { phase: "retired"; attemptId: SpawnAttemptId; cleanupReceiptId: string };

interface SpawnAttemptIsolationReceipt {
  attemptId: SpawnAttemptId;
  capabilityRevocationReceiptId: string;
  canonicalJoin: "excluded";
  isolatedNamespace: string;
  isolatedAt: IsoDateTime;
}

interface CleanupResponsibilityOwner {
  ownerId: string;
  jobId: string;
  claimEpoch: number;
  acceptedAt: IsoDateTime;
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
      publication: ExternalRequestPublication;
    }
  | {
      kind: "ask_user_question";
      requestId: ExternalRequestId;
      inputRequestId: string;
      requestedAt: IsoDateTime;
      deadline: Extract<ExternalRequestDeadline, { kind: "at" }>;
      publication: ExternalRequestPublication;
    };

type ExternalRequestPublication =
  | { state: "not_published"; semanticEventId: string }
  | {
      state: "published";
      semanticEventId: string;
      ingressReceiptId: string;
      publishedAt: IsoDateTime;
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

interface PreparedAttachmentGrant {
  grantId: string;
  executionId: ExecutionId;
  executionCommandId: ExecutionCommandId;
  hostInstanceId: string;
  epoch: AttachmentEpoch;
  previousEpoch: AttachmentEpoch | null;
  issuedAt: IsoDateTime;
  leaseExpiresAt: IsoDateTime;
  dbPrepareReceiptId: string;
}

interface AttachmentGrant extends PreparedAttachmentGrant {
  dbLeaseReceiptId: string;
  committedAt: IsoDateTime;
}

interface RunnerCommandEnvelope<TCommand> {
  executionId: ExecutionId;
  executionCommandId: ExecutionCommandId;
  attachmentEpoch: AttachmentEpoch;
  commandSequence: RunnerCommandSequence;
  commandId: string;
  command: TCommand;
}

interface RunnerHostCallEnvelope<TCall> {
  executionId: ExecutionId;
  executionCommandId: ExecutionCommandId;
  attachmentEpoch: AttachmentEpoch;
  hostCallSequence: number;
  operationId: string;
  call: TCall;
}

interface RunnerHostResponseEnvelope<TResult> {
  executionId: ExecutionId;
  executionCommandId: ExecutionCommandId;
  attachmentEpoch: AttachmentEpoch;
  hostCallSequence: number;
  operationId: string;
  result: TResult;
}

interface RunnerAttachmentBarrierReceipt {
  grantId: string;
  executionId: ExecutionId;
  executionCommandId: ExecutionCommandId;
  acceptedEpoch: AttachmentEpoch;
  previousEpoch: AttachmentEpoch | null;
  acceptedThrough: RunnerCommandSequence;
  settledThrough: RunnerCommandSequence;
  inFlight: ReadonlyArray<RunnerCommandHandoffDisposition>;
  inputHighWatermark: number;
  outboxHighWatermark: number;
  hostCallHighWatermark: number;
  committedAt: IsoDateTime;
}

type RunnerCommandHandoffDisposition =
  | {
      state: "settled";
      sequence: RunnerCommandSequence;
      commandId: string;
      resultReceiptId: string;
    }
  | {
      state: "transferred";
      sequence: RunnerCommandSequence;
      commandId: string;
      kind: "intervention" | "interrupt" | "close" | "host_response";
      journalEntryId: string;
      resumeAtEpoch: AttachmentEpoch;
    };

interface LegacyDetachBarrierReceipt {
  executionId: ExecutionId;
  executionCommandId: ExecutionCommandId;
  oldHostInstanceId: string;
  barrierCommandId: string;
  lastAcknowledgedCommandId: string;
  acceptedThrough: RunnerCommandSequence;
  settledThrough: RunnerCommandSequence;
  inputHighWatermark: number;
  outboxHighWatermark: number;
  hostCallHighWatermark: number;
  oldSocketClosedAt: IsoDateTime;
  commandDispositions: ReadonlyArray<RunnerCommandHandoffDisposition>;
  outstandingUnaccountedCommands: 0;
}

type PromotionHandoffFence =
  | { kind: "runner_epoch"; preparedGrant: PreparedAttachmentGrant; barrier: RunnerAttachmentBarrierReceipt }
  | { kind: "legacy_detach_barrier"; receipt: LegacyDetachBarrierReceipt };

type RunnerAttachmentJournal =
  | { phase: "unattached"; highestEpoch: AttachmentEpoch | null }
  | { phase: "quiescing"; preparedGrant: PreparedAttachmentGrant; previousEpoch: AttachmentEpoch }
  | { phase: "attached"; grant: AttachmentGrant; barrier: RunnerAttachmentBarrierReceipt };

interface RunnerHostResourceLedger {
  readonly executionId: ExecutionId;
  readonly grant: AttachmentGrant;
  readonly requestLifetimes: ReadonlyMap<string, AbortController>;
  readonly frameHandlers: ReadonlySet<Promise<void>>;
  readonly pumpRegistration: EventOutboxPumpRegistration;
  readonly runnerObservation: RunnerOperationObservation;
  readonly parentOutbox: RunnerParentOutbox;
  releaseAttachment(): Promise<RunnerAttachmentBarrierReceipt>;
}

interface LiveRunnerAttachment {
  kind: "live_runner";
  grant: AttachmentGrant;
  barrier: RunnerAttachmentBarrierReceipt;
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
      kind: "command_plane_orphan";
      runnerIdentity: SpawnedChildProof;
      staleEpoch: AttachmentEpoch;
      takeoverGrant: PreparedAttachmentGrant | AttachmentGrant | null;
    }
  | {
      kind: "quarantined_spawn";
      failedAttempt: Extract<SpawnAttemptDisposition, { phase: "quarantined" }>;
    }
  | {
      kind: "continuity_unproven";
      predecessorExecutionId: ExecutionId;
      missingProofs: ReadonlyArray<"engine_checkpoint" | "input_watermark" | "outbox_watermark" | "host_call_receipt" | "effect_receipt">;
      nextWakeAt: IsoDateTime;
    }
  | {
      kind: "replacement_prepared";
      successorExecutionId: ExecutionId;
      continuity: ExecutionContinuityCertificate;
    };

type RecoverySagaEffect =
  | "fence_stale_host"
  | "fence_owner"
  | "prepare_runner"
  | "wake_delivery";

interface RecoverySagaFence {
  executionId: ExecutionId;
  jobId: string;
  claimEpoch: number;
  leaseOwner: string;
  leaseExpiresAt: IsoDateTime;
  operationIds: Record<RecoverySagaEffect, string>;
}

type ExecutionRecoverySaga = RecoverySagaFence & (
  | { phase: "detected" }
  | { phase: "stale_host_fenced"; hostFenceReceiptId: string }
  | { phase: "owner_fenced"; ownerReceiptId: string }
  | {
      phase: "runner_ready";
      readiness:
        | { kind: "same_runner"; attachmentBarrier: RunnerAttachmentBarrierReceipt }
        | { kind: "isolated_spawn"; attempt: Extract<SpawnAttemptDisposition, { phase: "activated" }> };
    }
  | { phase: "delivery_wake_committed"; binderWakeReceiptId: string }
  | { phase: "superseded_by_terminal"; terminalWitnessId: string; supersessionReceiptId: string }
);

type DurableEffectReceipt =
  | { operationId: string; state: "not_started"; receiptId: null }
  | { operationId: string; state: "committed"; receiptId: string }
  | { operationId: string; state: "compensated"; receiptId: string };

declare const executionContinuityCertificate: unique symbol;

interface ExecutionContinuityCertificate {
  readonly [executionContinuityCertificate]: true;
  certificateId: string;
  predecessorExecutionId: ExecutionId;
  predecessorCommandId: ExecutionCommandId;
  backend: "claude" | "codex_cli" | "codex_app_server" | "agents";
  continuityContractVersion: number;
  effectInventoryHash: string;
  engineCheckpoint: { resumeToken: string; committedEngineBoundary: number };
  runnerInputConsumedThrough: number;
  runnerOutboxCommittedThrough: number;
  hostCallsSettledThrough: number;
  effects: ReadonlyArray<DurableEffectReceipt>;
  pendingExternalRequests: ExternalRequestInventory;
  deliveryHeadId: DeliveryId | null;
  issuedAt: IsoDateTime;
}

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
      kind: "command_plane_orphan";
      central: DurableExecutionRecord;
      registration: RunnerRegistration;
      runnerLifecycle: RunnerLifecycleRecord;
      reason: "attachment_expired" | "host_cannot_adopt" | "epoch_mismatch";
    }
  | {
      kind: "quarantined_spawn";
      central: DurableExecutionRecord;
      attempt: Extract<SpawnAttemptDisposition, { phase: "quarantined" }>;
    }
  | {
      kind: "continuity_unproven";
      central: DurableExecutionRecord;
      processAbsenceObservationIds: readonly [string, string];
      missingProofs: Extract<ExecutionRecoveryHandle, { kind: "continuity_unproven" }>["missingProofs"];
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

interface PreactivationResourceLedger {
  child: SpawnedChildProof;
  attachmentGrant: AttachmentGrant;
  hostResourceLedgerId: string;
  stateNamespace: string;
}

type PreactivationRecoverySubject =
  | {
      kind: "provisional_attempt";
      reservation: ExecutionReservation;
      resources: PreactivationResourceLedger;
      ownershipProofId: null;
    }
  | {
      kind: "activating_attempt";
      reservation: ExecutionReservation;
      resources: PreactivationResourceLedger;
      ownershipProofId: string;
    };

type ExecutionRecoveryContext =
  | {
      kind: "running_execution";
      subject: ExecutionRecoverySubject;
      activity: ExecutionActivity;
    }
  | {
      kind: "preactivation_spawn";
      subject: PreactivationRecoverySubject;
    };

type ExecutionTerminalOutcome =
  | { kind: "completed"; terminalEventId: number }
  | { kind: "failed"; code: string; message: string }
  | { kind: "interrupted"; reason: "user" | "policy" };

interface ExecutionSupersessionRecord {
  predecessorExecutionId: ExecutionId;
  reason: "runner_exited" | "lease_expired" | "continuity_handoff";
  continuityCertificateId: string;
  successorExecutionId: ExecutionId;
  committedAt: IsoDateTime;
}

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
    };

interface ExecutionTerminalRecord {
  key: ExecutionKey;
  firstSignal: ExecutionTerminalSignal;
  committedAt: IsoDateTime;
  deliveryResolution: "settled";
  cleanup: ExecutionCleanupBarrier;
}

interface LogicalCleanupReceipt {
  state: "settled";
  receiptId: string;
  committedAt: IsoDateTime;
}

type PhysicalCleanupReceipt =
  | { state: "released"; receiptId: string; committedAt: IsoDateTime }
  | {
      state: "retained";
      receiptId: string;
      responsibilityOwner: CleanupResponsibilityOwner;
      committedAt: IsoDateTime;
    }
  | {
      state: "transferred";
      transferReceiptId: string;
      responsibilityOwner: CleanupResponsibilityOwner;
      committedAt: IsoDateTime;
    };

interface ExecutionCleanupReceipts {
  delivery: LogicalCleanupReceipt;
  externalRequests: LogicalCleanupReceipt & { resolvedRequestIds: ReadonlyArray<ExternalRequestId> };
  stream: LogicalCleanupReceipt;
  hostCalls: LogicalCleanupReceipt;
  attachment: PhysicalCleanupReceipt;
  writer: PhysicalCleanupReceipt;
  childOrRetention: PhysicalCleanupReceipt;
}

declare const executionCleanupBarrier: unique symbol;

interface ExecutionCleanupBarrier {
  readonly [executionCleanupBarrier]: true;
  executionId: ExecutionId;
  externalRequestReceipts: ReadonlyArray<ExternalRequestResolutionReceipt>;
  receipts: ExecutionCleanupReceipts;
  completedAt: IsoDateTime;
}

interface ExecutionPostTerminalMaintenance extends CleanupResponsibilityOwner {
  executionId: ExecutionId;
  step:
    | "release_attachment"
    | "release_writer"
    | "terminate_isolated_child"
    | "delete_temp_files"
    | "compact_diagnostics"
    | "emit_telemetry";
  status: "pending" | "completed";
  nextWakeAt: IsoDateTime | null;
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
      context: ExecutionRecoveryContext;
      recovery: ExecutionRecoveryHandle;
    };

type ExecutionTerminationProgress =
  | { phase: "intent_recorded"; intent: HostTerminationIntent }
  | { phase: "proof_observed"; signal: ExecutionTerminalSignal }
  | { phase: "cleanup_barrier_complete"; signal: ExecutionTerminalSignal; barrier: ExecutionCleanupBarrier }
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
      activity: Extract<ExecutionActivity, { kind: "foreground" }>;
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
      context: ExecutionRecoveryContext;
      method: "host_reattach" | "adopt" | "offline_replay" | "identity_resolution" | "attachment_takeover" | "spawn_retry" | "continuity_wait";
      evidence: ExecutionRecoveryEvidence;
      handle: ExecutionRecoveryHandle;
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
  method: "host_reattach" | "adopt" | "offline_replay" | "identity_resolution" | "attachment_takeover" | "spawn_retry" | "continuity_wait";
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

`ExecutionSupersessionRecord`는 predecessor execution의 내부 정산이지 terminal signal이 아니다. certificate-bearing atomic replacement handoff가 session의 `running`과 외부 stream을 유지하며 `ExecutionTerminalSignal` 타입으로 변환할 수 없다. `interrupted`는 같은 invocation ID의 명시적 사용자 interrupt가 runner witness로 확인된 경우에만 session으로 투영한다. host restart, owner-null, registration identity 불완전, process absence는 이 outcome을 만들 수 없다.

`Task.execution`은 required다. 자원이 없는 이유는 `undefined`가 아니라 phase가 말한다. 아직 시작하지 않았으면 `idle`, 독립 runner placement를 기다리면 `reserved`, 자식을 만들었지만 활성화 전이면 `provisional`, 사람의 approval·답변을 기다리면 `awaiting_external_input`, 회수 중이면 `recovering`, 자원을 정산했으면 terminal record를 가진 `terminal`이다. “없음”, “해당 없음”, “치웠음”이 같은 값이 되는 경로가 사라진다.

`PendingExternalRequestSet`은 controller module의 private `create/add/removePendingExternalRequestSet()`만 만들 수 있는 non-empty branded collection이다. 메모리에서는 request id별 map을 제공하고 durable row와 runner journal에는 같은 내용을 key-unique JSON object로 직렬화한다. `awaiting_external_input`은 이 집합이 비어 있으면 구성할 수 없고, `foreground`는 명시적인 `externalRequests.state="empty"`를 가진다. 따라서 단일 pending slot, controller 밖 lookup, expiry 때의 direct clear가 필요 없다.

`recovering`은 활성화 뒤 실행과 활성화 전 spawn을 `ExecutionRecoveryContext`로 구분한다. 전자는 ownership 또는 identity-unresolved subject와 실제 `ExecutionActivity`를 갖고, 후자는 reservation·exact child·attachment grant·host resource ledger id·namespace와 ownership proof 유무를 갖는다. 따라서 `provisional/activating → recovering(quarantined_spawn)`은 가짜 ownership/progress나 controller 밖 resource lookup 없이 구성된다. durable row도 `recovery_context.kind`와 preactivation resource/proof shape를 같은 CHECK로 강제한다.

external request replacement는 기존 request와 publication identity를 보존한다. `publication.state="published"`면 successor는 UI request event를 다시 emit하지 않고 같은 request id의 response·expiry·cancel만 소비한다. `not_published`면 같은 `semanticEventId`를 한 번 publish하고 event ingress unique key가 중복 카드를 막는다. AskUserQuestion과 approval 모두 이 계약을 사용하므로 재기동 뒤 같은 질문이나 승인 창이 다시 나타나는 관측은 허용되지 않는다.

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
| `executionOwnership` | `active/awaiting_external_input.ownership`, `recovering.context` 또는 termination subject |
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

정상·pure adopt·attachment takeover는 `executionId`와 `executionCommandId`를 모두 보존한다. runner process가 사라진 경우에는 complete continuity certificate가 있을 때만 predecessor를 증명·정산하고 새 `executionId`와 새 command를 만든다. checkpoint-resume이나 effect receipt가 없으면 replacement하지 않는다. `deliveryId` 하나는 정확히 한 `runnerInputSequence` consumption receipt와 결합하며, provider model turn에는 직접 bind하지 않는다. 이 구분으로 구현자가 “intervention 한 번 = execution 하나” 또는 “model turn 하나 = 실행 수명”으로 축소하는 것을 막는다.

## 상태 전이표

| 현재 | 계기 | 다음 | 필수 durable 효과 | 금지 |
| --- | --- | --- | --- | --- |
| `idle` 또는 `terminal` | durable delivery head가 실행을 요구 | `reserved` | semantics v2 execution row, generation, reconcile job을 함께 commit | admission 전 실행, `in_process` 배치 |
| `reserved` | v2 독립 runner capacity 부재 | `reserved` | placement wake의 `next_wake_at` 갱신 | 실패·503·in-process fallback |
| `reserved` | 정확한 v2 child spawn 성공 | `provisional` | child proof를 execution row와 runner witness에 기록 | 활성화 전 실행 부재로 취급 |
| `reserved` | reserve 취소·만료 | `terminating` | `reservation_cancelled` outcome candidate와 cleanup barrier 시작 | reservation 필드만 삭제, barrier 전 visible terminal |
| `provisional` | ownership proof 성공 | `activating` | proof CAS | sidecar 재독만으로 child identity 교체 |
| `provisional` | proof·parent init 실패, exact child cleanup 성공 | `reserved` | spawn attempt `retired` receipt와 새 placement wake를 같은 transaction에 기록 | host 초기화 실패를 visible terminal로 투영 |
| `provisional` | proof·parent init 실패, exact child cleanup 미확인 | `recovering(context=preactivation_spawn, quarantined_spawn)` | attempt capability revoke + namespace isolation receipt + physical cleanup 책임 이전 | 가짜 ownership/activity 생성, child를 canonical registration으로 남김 |
| `recovering(quarantined_spawn)` | isolation receipt와 cleanup 책임 owner commit | `reserved` | revoked attempt를 current pointer·canonical PID join에서 제외하고 별도 namespace의 placement wake commit | 물리 zero-process를 기다려 실행 영구 정지, 격리 전 successor spawn |
| `activating` | activation ACK | `active` | active CAS, activation waiter resolve | delivery 선할당 |
| `activating` | activation 실패, exact child cleanup 성공 | `reserved` | exact attempt `retired` receipt, proof/activation slot reset, 새 placement wake | promise reject를 visible terminal로 투영 |
| `activating` | activation 실패, child cleanup 미확인 | `recovering(context=preactivation_spawn, quarantined_spawn)` | ownership proof를 보존한 capability revoke·namespace isolation·cleanup 책임 이전 | 가짜 active ownership 생성, live child를 다음 attempt의 identity 후보로 유지 |
| `active` | 첫 durable tool approval·AskUserQuestion request | `awaiting_external_input` | non-empty request set과 request id를 execution row·runner journal에 함께 기록 | `tool_start`나 단순 progress로 대체 |
| `awaiting_external_input` | 다른 request 생성 | `awaiting_external_input` | key-unique request set에 추가하고 다음 expiry wake를 갱신 | 기존 pending request 덮어쓰기 |
| `awaiting_external_input` | 같은 request id의 응답 delivery consumed | 남은 request가 있으면 `awaiting_external_input`, 없으면 `active` | `responded` receipt, runner input sequence, 집합 remove를 한 transaction에 commit | 전체 집합 clear, foreground stall clock 소급 적용 |
| `awaiting_external_input` | request deadline 도달 | 남은 request가 있으면 `awaiting_external_input`, 없으면 `active` | exact request의 `expired` receipt와 runner `input_request_expired` journal을 commit | progress reaper가 execution 종료, 다른 request clear |
| `awaiting_external_input` | request owner·사용자 취소 | 남은 request가 있으면 `awaiting_external_input`, 없으면 `active` | exact request의 `cancelled` receipt를 commit | controller 밖 callback map만 삭제 |
| `active` 또는 `awaiting_external_input` | 이미 resolved된 request의 late response | 동일 phase | 기존 resolution receipt를 반환. Claude expiry면 semantic `expired` | runner에 재전달, 새 delivery bind |
| `awaiting_external_input` | host attachment 상실 | `recovering` | pending request를 보존한 recovery wake | stalled reap, request 유실 |
| `active` | host attachment 상실 | `recovering` | recovery wake 기록 | stream fail, execution terminal 처리 |
| `recovering(context.running_execution.activity=awaiting_external_input)` | request expiry·취소 receipt 관측 | `recovering` | exact request만 정산하고 나머지 set 또는 foreground activity를 보존 | attach 전 direct clear, execution reap |
| `recovering(context.running_execution.activity=awaiting_external_input)` | response delivery 도착 | `recovering` | delivery는 accepted/queued, pending request는 runner consumption까지 유지 | host 부재를 503으로 반환, 응답했다고 선반영 |
| `recovering` | 같은 identity reattach/adopt | `active` 또는 `awaiting_external_input` | attachment epoch 갱신, 보존한 activity로 복귀 | 새 execution 생성, pending request 삭제 |
| `recovering(command_plane_orphan)` | higher attachment grant를 runner가 journal CAS | `active` 또는 `awaiting_external_input` | stale epoch revoke, barrier receipt, durable host-call replay | ownership reserve 재시도, runner SIGTERM, 30초 timeout을 lifecycle failure로 투영 |
| `recovering(identity_unresolved)` | identity 증명 성공 | `active` 또는 `awaiting_external_input` | 기존 execution/command identity backfill | session `interrupted` 투영 |
| `recovering(identity_unresolved)` | process 부재 확정·continuity certificate 있음 | successor `reserved` | predecessor proof + certificate FK + successor row를 한 transaction에 commit | 중간 `idle`, session terminal/interrupted, 입력 유실 |
| `recovering(identity_unresolved)` | process 부재 확정·continuity proof 불완전 | `recovering(continuity_unproven)` | missing proof inventory와 durable wake | proof 없는 replacement, context/effect 재실행 |
| `recovering` | durable terminal witness | `terminating` | witness high-watermark drain wake와 saga `superseded_by_terminal`을 current claim epoch CAS로 함께 기록 | stale saga effect, receipt 전 first signal CAS, 늦은 host 오류로 덮기 |
| `active`, `awaiting_external_input`, `recovering` | host interrupt·reaper 의도 | `terminating(intent_recorded)` | durable intent와 전체 recovery context, runner control wake를 보존 | intent만으로 visible terminal commit, pending request·preactivation child 유실 |
| nonterminal | runner terminal witness와 ingress receipt | `terminating(proof_observed)` | immutable outcome candidate와 cleanup wake | process absence를 terminal로 승격, receipt·cleanup barrier 전 session terminal 투영 |
| `terminating` | delivery와 mandatory cleanup barrier 완료 | `terminal` | outcome candidate + ingress receipt + cleanup barrier의 단일 CAS | barrier 전에 stream/waiter/session terminal 게시 |
| `terminal` | 다음 유효 입력 | 새 `reserved` | 새 `executionId`, retention attachment의 명시적 handoff | terminal record 재사용, retained runner를 current turn으로 간주 |

모든 mutation은 controller의 `transition(expectedExecutionId, expectedPhase, next)` CAS를 거친다. 이전 실행의 callback은 execution id가 다르면 관측만 기록하고 현재 실행의 자원에 접근할 수 없다.

### 외부 입력 수명 정책

Claude `AskUserQuestion`은 현행 UX인 **300,000ms**를 유지한다. request 생성 시 `expiresAt=requestedAt+300_000`을 runner journal과 중앙 ledger에 같이 쓴다. deadline worker는 exact runner expiry wake만 만들고 request를 직접 지우지 않는다. runner journal의 `input_request_expired`가 `{ kind: "runner_journal" }` proof로 resolution CAS를 이기며, exact process 부재·termination이면 cleanup proof가 대신 닫는다. 늦은 응답은 새 input으로 보지 않고 기존 `{ kind: "expired" }` receipt를 반환한다. 재기동 전후 모두 같은 결과이므로 이는 재시작 신호가 아니다.

Agents tool approval은 현행처럼 자동 만료가 없는 `{ kind: "none" }`이다. 명시적 request cancellation이나 execution terminal만 닫을 수 있다. 한 request가 응답·만료·취소돼도 나머지 request는 그대로 남고, 마지막 open request가 사라질 때만 `active`로 돌아가 새 30분 foreground progress lease를 시작한다. execution이 `terminating`으로 들어가면 running recovery/attached `TerminationSubject`가 전체 집합을 보존하고 cleanup은 각 request를 `execution_terminated` receipt로 정산한 뒤에만 terminal을 게시한다.

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
| `recovering` | `recovering` | running context면 subject+activity, preactivation context면 reservation+resource ledger+proof shape, 공통으로 reconcile job 있음 | 실제 context를 보존해 adopt·spawn retry·replacement |
| `terminating` | `terminating` | 원 termination subject(running activity 또는 preactivation child)와 intent/proof 있음 | terminal pipeline 재개 |
| `terminal` | `terminal` 또는 `failed` compatibility projection | first signal, ingress receipt/preactivation proof, cleanup barrier | immutable terminal 재조회 |

DB CHECK는 이를 직접 강제한다. v2 `reserved`는 child identity가 모두 null, `provisional`은 child identity가 모두 non-null이면서 `ownership_proof_id IS NULL`, `activating`은 proof가 non-null이면서 `activation_receipt_id IS NULL`, `active/awaiting_external_input`은 둘 다 non-null이어야 한다. `awaiting_external_input`은 `jsonb_object_length(pending_external_requests) > 0`, `active`는 빈 object다. `recovering`의 `running_execution` context는 subject와 activity를, `preactivation_spawn` context는 reservation·child·attachment/resource ledger와 nullable/non-null proof의 두 variant를 요구하고 activity를 금지한다. `terminating`도 원 context를 그대로 보존한다. 따라서 `task_executor.ts:495`의 proof commit 뒤 `prepareSession` 또는 activation ACK 전에 죽어도 durable row가 `activating` 또는 proof-bearing preactivation recovery 이외 상태로 복원될 수 없다.

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

spawn의 획득 단위는 session state directory가 아니라 `(executionId, spawnAttemptId)`다. `session_prepare_spawn_attempt_v2(...)`가 current spawn slot을 CAS하고 `runner-state/{sessionHash}/{executionId}/{spawnAttemptId}` namespace를 발급한다. child bootstrap, registration, pid file, lifecycle, socket은 모두 attempt id를 필수로 갖고 다른 attempt의 파일을 후보로 합치지 않는다. provisional child는 activation grant 전에는 `execute`나 host call을 시작할 수 없다.

rollback이 exact child의 종료 receipt를 얻지 못하면 controller는 그 attempt의 capability와 attachment grant를 revoke하고, namespace를 canonical registration/PID join에서 제외한 `SpawnAttemptIsolationReceipt`와 physical cleanup owner를 같은 transaction에 기록한다. 이 **논리적 격리 receipt**가 successor spawn의 gate다. 별도 namespace의 successor는 즉시 진행할 수 있고, 이전 child가 kill 불가여도 revoked attempt id·epoch·operation id로는 canonical write나 side effect를 만들 수 없다. 물리 종료는 책임 owner가 계속 재시도하지만 실행 진행을 막지 않는다.

여기서는 활성을 명시적으로 택한다. 물리 zero-process를 기다리는 이전 gate와 persistent supervisor/cgroup 필수 계약은 삭제한다. 그 gate는 supervisor 장기 불가나 unkillable process에서 승인된 입력을 영구 정지시켰고, attempt namespace·capability revoke와 같은 안전 불변식을 중복 방어했다. 물리 process가 남더라도 canonical execution이 아니라 owner가 명시된 **격리 cleanup debt**이며, 새 attempt의 identity 후보·writer·effect executor에는 절대 합류하지 않는다.

### 해제 경계

`terminate(executionId, cause)`만 실행을 끝낸다. 같은 execution에 대한 모든 호출은 하나의 memoized termination promise를 돌려받는다. 여러 host intent는 합쳐지지만 terminal 결과가 아니다. outbox receipt를 갖춘 첫 유효 proof가 outcome candidate slot을 이기고, 이후 proof·오류는 late signal 진단으로 남는다. candidate는 아직 stream, waiter, session status에서 보이는 terminal이 아니다.

해제 순서는 다음으로 고정한다.

1. 해당 execution으로의 새 delivery bind와 새 interrupt 시작을 닫는다. host-origin 종료면 `HostTerminationIntent`만 durable하게 기록한다. **의도는 visible terminal이 아니다.**
2. runner는 마지막 engine event와 pending outbox를 먼저 durable하게 쓴 뒤, 그 outbox high-watermark와 outcome을 가진 `RunnerTerminalWitness`를 같은 runner transaction에 commit한다.
3. runner는 비정본 `execution_ended` control frame으로 host를 깨운다. frame 유실은 maintenance poll로 대체되며 terminal 사실을 만들지 않는다.
4. host는 witness의 high-watermark까지 runner outbox·IPC journal을 event ingress로 replay하고 `TerminalIngressReceipt`를 durable하게 받는다.
5. controller는 witness identity와 receipt sequence가 일치함을 확인해 immutable first outcome candidate를 기록한다. 이때 늦은 `finish/fail`은 진단으로만 남으며 visible terminal은 아직 금지된다.
6. 할당된 delivery attempt를 `consumed`, `unconsumed`, `reconcile_pending` 중 하나로 정산하고 `delivery` logical receipt를 만든다.
7. `TerminationSubject`의 running context에 있는 **모든** open external request를 request id별 `execution_terminated` receipt로 정산한다. 각 receipt를 commit한 뒤에만 deadline timer·adapter callback을 끊는다. request id 집합과 resolution receipt 집합이 다르면 `externalRequests` logical receipt를 만들 수 없다. preactivation context에는 request 집합이 없다는 사실이 타입으로 고정된다.
8. stream과 durable host-call journal을 정산해 두 logical receipt를 만든다. 진행 관측·timer·callback은 의미 사실이 아니라 attachment physical cleanup에 포함한다.
9. attachment, writer, child/retention의 세 physical slot을 각각 `released`, 새 owner가 명시된 `retained`, 또는 durable cleanup owner에게 넘어간 `transferred` receipt로 닫는다. host restart와 live adoption handoff는 execution termination이 아니므로 이 pipeline이 아니라 epoch-fenced `detachAttachment()`를 탄다.
10. 6~9의 **고정된 일곱 slot**을 모두 가진 `ExecutionCleanupBarrier`를 commit한다. 임의 문자열 step, 누락 가능한 배열, `retry_pending` terminal 값은 없다. DB는 JSON key가 `delivery/externalRequests/stream/hostCalls/attachment/writer/childOrRetention`과 정확히 같은지 검사한다.
11. **같은 DB transaction에서만** outcome candidate + ingress receipt + cleanup barrier를 `terminal` row로 CAS한다. commit 뒤 `ProcessFrameStream.terminate(firstSignal)`를 한 번 게시하고 activation·terminal·interrupt waiter를 settle하며 session status를 투영한다.
12. 9번에서 responsibility를 넘긴 attachment/writer/isolated child의 물리 회수와 temp file·diagnostic·telemetry만 `ExecutionPostTerminalMaintenance`가 맡는다. 이 lane의 `pending`은 terminal을 지연하지 않지만 external request·delivery·stream·host-call 의미 정산을 포함할 수 없다.

runner가 witness 전에 죽은 경우에도 host intent나 process absence를 visible terminal로 승격하지 않는다. reservation/provisional process absence는 attempt cleanup·quarantine 뒤 같은 execution의 새 spawn으로 돌아간다. active execution의 process absence는 `recovering` 증거이며, continuity certificate가 있으면 `ExecutionSupersessionRecord`와 successor responsibility를 한 transaction에 넘기고 session stream은 유지한다. certificate가 없으면 `continuity_unproven`에 머문다. 이 구분이 출력 유실과 context/effect 중복을 동시에 막는다.

runner lifecycle의 terminal witness slot도 `(execution_id, execution_command_id)`당 하나인 CAS다. `finish → fail`, `fail → finish`, `fail → fail`에서 첫 witness의 outcome과 high-watermark가 고정되고 late witness는 별도 diagnostic row로만 남는다. 중앙 first visible signal은 그 첫 witness를 receipt 뒤 투영하므로 첫 실패 대신 late failure가 노출될 수 없다.

11번이 유일한 visible terminal CAS다. session status broadcast, `TaskExecution.phase="terminal"`, stream terminal, terminal waiter resolution은 그 commit 뒤 같은 memoized termination promise의 끝에서만 게시한다. logical cleanup은 DB transaction으로 반드시 settled되어야 하며 미정산 상태로 terminalize할 수 없다. physical release가 반복 실패하면 무한 `terminating`으로 두지 않고 고정 slot의 `transferred` receipt가 새 cleanup owner와 fenced job을 기록한다. 즉 visible terminal 전에 **의미 책임은 끝나고 물리 책임은 소유자가 바뀐다**. unowned `retained`, 임의 step 추가, 영구 무책임 대기는 구성할 수 없다.

host attachment 반납은 이 목록과 다른 연산이다.

```ts
interface DispatcherTerminal {
  firstSignal: ExecutionTerminalSignal;
  cleanup: ExecutionCleanupBarrier;
}

interface RunnerProcessDispatcher {
  detachAttachment(reason: "host_shutdown" | "adoption_handoff" | "epoch_superseded"): Promise<RunnerAttachmentBarrierReceipt>;
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

### attachment epoch는 평상시 기본 계약이다

attachment는 socket 존재가 아니라 중앙 lease와 runner SQLite journal이 함께 승인한 `AttachmentGrant`다. DB의 `attachment_epoch`는 execution별 단조 증가하고 runner journal의 `highestEpoch`는 감소하지 않는다.

1. host는 `session_prepare_runner_attachment_v2(...)`로 다음 epoch의 `PreparedAttachmentGrant`를 얻는다. procedure는 execution/command identity와 runner capability를 검사하고 DB attachment를 `handoff_pending`으로 CAS한다. 이때 old host의 일반 DB mutation lease는 freeze되고 new host 권한은 아직 없다. 취소 시에도 old epoch를 되살리지 않고 더 높은 rollback grant를 발급한다.
2. host는 runner의 **recovery control endpoint**에 prepared grant를 보낸다. 이 endpoint는 execution command socket과 별개이며 higher epoch grant와 liveness probe만 받는다.
3. runner는 higher epoch를 SQLite `quiescing`에 CAS하면서 이전 epoch command admission을 즉시 닫는다. receipt는 `settledThrough..acceptedThrough` 사이의 모든 accepted sequence를 빠짐없이 열거하고, 각 intervention·interrupt·close·host response를 `settled(resultReceiptId)` 또는 `transferred(journalEntryId, resumeAtEpoch)` 중 하나로 처분한다. input/outbox/host-call high-watermark도 같은 `RunnerAttachmentBarrierReceipt`에 commit한다. 이때부터 old writer도 new writer도 side effect command를 실행하지 못한다.
4. host는 `session_commit_attachment_grant_v2(preparedGrant, barrier)`로 DB writer를 새 epoch에 CAS한다. 이 transaction이 성공한 `AttachmentGrant` 뒤에만 runner journal을 `attached`로 바꾸고 `LiveRunnerAttachment`를 구성해 durable host-call response와 outbox replay를 시작한다.
5. 이후 host→runner command와 runner→host request/response는 모두 `executionId + executionCommandId + attachmentEpoch + monotonic sequence`를 갖는다. runner와 host는 자기 정본 epoch보다 낮은 frame을 **효과 수행 전** no-effect receipt로 거부한다. 새 host는 `transferred` command만 같은 command id로 이어 받고 `settled` command는 재실행하지 않는다.

old host detach는 정확성의 전제가 아니다. prepare 전에는 DB와 runner 모두 old epoch 한 곳만 writer다. prepare 뒤 runner quiesce 전에는 DB writer가 0개이고 runner old epoch만 barrier까지 처리하며, quiesce 뒤 commit 전에는 둘 다 0개, commit 뒤에는 new epoch만 writer다. `acceptedThrough - settledThrough` 구간에 빠진 sequence, 중복 sequence, 처분 없는 command가 하나라도 있으면 DB commit이 거부된다. clean detach receipt는 자원 회수를 앞당길 뿐 writer fence를 만들지 않는다. DB commit이 실패하면 runner는 epoch를 내리지 않고 같은 prepared grant를 재시도하거나 더 높은 rollback grant로 old host를 다시 붙인다.

host는 grant를 5초마다 renew하고 lease TTL은 15초다. runner가 TTL 동안 current host의 유효 ack를 못 받으면 engine을 실패시키거나 lifecycle을 terminal로 쓰지 않고 **self-quiesce**한다. 새 tool effect와 새 host call 전송을 멈추되 현재 engine context, input/outbox, pending host call을 SQLite에 보존하고 higher epoch grant를 기다린다. 기존 30초 `Runner host request timed out`은 v2에서 외부 error가 아니라 pending host-call journal의 reconcile wake다.

reconciler는 live PID + 중앙 open execution + attachment TTL 경과 또는 adopt 실패를 `command_plane_orphan`으로 분류한다. 이 disposition은 ownership reserve와 dead-owner backoff를 타지 않고 같은 execution/runner에 higher epoch grant를 발급한다. recovery endpoint가 응답하면 사람의 SIGTERM 없이 같은 command를 이어 간다. recovery endpoint도 응답하지 않으면 “살아 있는 runner”로 추측하지 않고 process liveness와 continuity certificate를 별도로 판정한다. 인증서 없는 live process는 kill/replacement하지 않고 격리된 책임으로 유지한다.

회수는 `ExecutionRecoverySaga` 하나다. ① stale host lease fence, ② owner/attachment fence, ③ same-runner barrier 또는 isolated successor spawn, ④ delivery binder wake를 순서대로 durable 기록하며 중간 phase를 건너뛸 transition이 없다. provisional child quarantine은 물리 zero-process가 아니라 attempt capability revoke와 namespace isolation receipt로 ③을 충족한다. ④가 commit되기 전에는 recovery를 completed로 표시할 수 없다.

saga claim은 단순 lease가 아니라 monotonic `claimEpoch` fence다. job 생성 때 네 단계의 stable operation id를 한 번 만들고, 모든 DB mutation·runner takeover·spawn·binder wake가 `(jobId, claimEpoch, operationId, expectedPhase)`를 요구한다. lease 재청구는 epoch를 증가시키므로 worker A가 effect 뒤 멎고 B가 재청구한 다음 A가 돌아와도 A의 늦은 effect와 receipt는 effect 수행 전 거부된다. effect가 이미 일어났으면 같은 stable operation id의 기존 receipt를 재조회한다.

terminal witness commit은 같은 execution row와 saga를 잠그고 `phase="superseded_by_terminal"`을 현재 claim epoch CAS로 기록한다. 그 뒤 어떤 recovery step도 nonterminal execution predicate를 통과하지 못한다. 반대로 recovery step이 먼저 commit됐으면 terminal procedure가 그 resulting execution/command identity를 재검증한다. 이 계약으로 saga lease와 terminal witness가 서로 다른 정본이 되는 경로를 닫는다.

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
  | { kind: "command_plane_orphan"; execution: DurableExecutionRecord; registration: RunnerRegistration; staleEpoch: AttachmentEpoch }
  | { kind: "registration_missing"; execution: DurableExecutionRecord }
  | { kind: "execution_missing"; registration: RunnerRegistration }
  | { kind: "quarantined_spawn"; attempt: Extract<SpawnAttemptDisposition, { phase: "quarantined" }> }
  | { kind: "memory_missing"; execution: DurableExecutionRecord; registration: RunnerRegistration }
  | { kind: "memory_orphan"; controller: TaskExecutionController };
```

매 maintenance tick은 다음 순서로 독립 스냅샷을 만든다.

1. semantics v2 row는 `reserved`, `provisional`, `activating`, `active`, `awaiting_external_input`, `recovering`, `terminating`을, rolling 중 v1 row는 `reserved`, `identity_proven`, `active`를 node별로 읽는다. 모든 open row는 같은 transaction에서 만들어지거나 migration에서 backfill된 `execution_reconcile_jobs` row와 non-null `reconcile_due_at`을 가진다.
2. runner 등록 디렉터리, attempt-scoped spawn inventory와 runner SQLite lifecycle/attachment witness를 읽는다. quarantined attempt는 canonical registration join에서 제외하고 cleanup lane에만 넣는다.
3. 메모리 controller를 읽되 판단 근거가 아니라 불일치 탐지에만 쓴다.
4. `executionId`를 기준으로 full outer join한다.
5. 모든 row를 disposition으로 분류하고, 각 결과를 execution row와 reconcile job을 한 transaction에서 갱신하는 `completed` 또는 `scheduled(wakeAt)` receipt로 끝낸다. `active/awaiting_external_input` 복귀나 successor activation은 같은 transaction에서 delivery binder wake도 기록한다.

따라서 등록 디렉터리가 0개여도 중앙의 열린 실행 4개와 durable reconcile job 4개가 나오면 네 실행을 모두 검사한다. 반대로 중앙 execution 없이 등록만 있으면 orphan child 회수 대상이다. `activeRunnerOperations`와 Task 필드 존재는 inventory가 아니라 controller phase의 순수 projection으로 격하한다.

스캔은 `PeriodicMaintenanceLoop`의 독립 step으로 두고 다음 수치를 v2 운영 설정 정본으로 고정한다. 이 값은 정상 availability에서의 탐지·처리 SLO이지, 무제한 worker fail-stop까지 덮는 correctness bound가 아니다.

| 수치 | 값 | 의미 |
| --- | ---: | --- |
| `EXECUTION_RECONCILE_SCAN_MS` | 5,000ms | due job을 확인하는 최대 간격 |
| `EXECUTION_RECONCILE_JOB_LEASE_MS` | 15,000ms | worker fail-stop 뒤 같은 job이 다시 runnable해지는 상한 |
| `ATTACHMENT_RENEW_MS` | 5,000ms | current host가 DB와 runner journal의 grant를 갱신하는 간격 |
| `ATTACHMENT_TTL_MS` | 15,000ms | 마지막 유효 renew 뒤 runner가 self-quiesce하고 takeover를 허용하는 시각 |
| `ATTACHMENT_TAKEOVER_HANDSHAKE_MS` | 10,000ms | due job claim부터 higher epoch barrier receipt commit까지의 protocol deadline |
| `PROCESS_ABSENCE_GRACE_MS` | 15,000ms | 마지막 positive process liveness 뒤 process-absence 판정을 금지하는 구간 |
| `PROCESS_ABSENCE_SECOND_SCAN_MS` | 5,000ms | 서로 다른 두 absence 관측의 최소 간격. due 뒤 두 번째 관측은 최대 10,000ms 안에 끝남 |
| `RECOVERY_RESPONSIBILITY_COMMIT_MS` | 5,000ms | proof 뒤 동일-runner takeover 또는 certified successor row를 commit하는 deadline |

85초 hard bound와 `30초 + 20초 × F` 식은 모두 폐기한다. 연속 claim-worker fail-stop 횟수 `F`에 상한이 없으므로 어떤 유한식도 전체 시스템의 waiter settle을 보장하지 못한다. 이 설계가 실제로 보장하는 것은 **fair scheduling과 저장소 가용성 아래 eventual settle, 그리고 그 전 과정의 durable·관측 가능한 내부 진행**이다.

정상 availability에서는 command-plane orphan이 TTL 15초 + scan alignment 5초 + handshake 목표 10초, process absence가 grace/두 scan/commit 목표 합계 30초 안에 끝나는 것을 SLO로 측정한다. 초과해도 waiter나 외부 stream을 실패시키지 않는다. saga row의 `claimEpoch`, 현재 phase, 마지막 fenced receipt, `leaseExpiresAt`, `nextWakeAt`이 매 성공 단계마다 갱신되고, 정체는 내부 P0 alert가 된다. 외부 관측은 계속 지연뿐이다. 별도 capacity entitlement는 bounded 보장을 만들지 못하므로 삭제하고, 기존 scheduler의 fair recovery priority를 운영 정책으로만 둔다.

새 메시지, reserve, intervention, 배포, 재시작, 멱등 ping은 가속 wake일 수 있지만 회수의 전제가 아니다. 한 execution의 reconcile이 다른 execution을 막지 않는다.

### owner-null은 identity-unresolved 책임이다

v2 migration은 owner-null running row를 `idle`, `terminal`, session `interrupted` 중 어느 것으로도 투영하지 않는다. 두 번 관측에서 stable identity가 나오면 같은 execution을 `identified`로 backfill하고 adopt한다. identity가 여전히 없으면 `recovering`의 `identity_unresolved` subject와 durable reconcile job을 만든다. 그 상태는 다음 두 종착지만 가진다.

1. runner/registration/bootstrap 증거가 합쳐지면 같은 `executionId`와 command를 adopt한다.
2. exact process 부재와 `ExecutionContinuityCertificate`가 모두 있으면 `session_replace_execution_v2(...)`가 predecessor proof, successor `reserved` row, engine checkpoint, effect ledger, 승인된 입력·pending request handoff를 한 transaction에 commit한다. 인증서가 없으면 replacement 권한이 없고 `recovering(continuity_unproven)` 책임을 유지한다. open execution pointer가 predecessor에서 successor로 원자적으로 바뀌므로 session은 `idle`이나 terminal을 거치지 않는다.

따라서 legacy 두 번 관측은 “identity를 못 찾았으니 interrupt”가 아니라 “누가 맡을지 아직 증명하지 못했으니 recovering 책임을 유지”하는 분류다. 이 과정은 외부 session status와 ACK에 나타나지 않는다.

### replacement는 연속성 인증서가 있어야 한다

`ExecutionContinuityCertificate`는 “다시 실행해도 될 것 같다”는 추측이 아니라 predecessor가 다음 engine boundary에서 이어질 수 있음을 증명하는 branded receipt다. backend checkpoint/resume token, consumed input high-watermark, outbox high-watermark, durable host-call response, pending external request, delivery head, 모든 비멱등 tool effect의 `not_started/committed/compensated` receipt가 완전해야 발급된다. effect가 `unknown`인 variant는 타입과 DB CHECK에 없다.

`session_replace_execution_v2(...)`는 certificate FK를 required로 받고, certificate의 predecessor execution/command와 현재 open row가 다르면 거부한다. certificate의 `continuityContractVersion/effectInventoryHash`는 runner capability에 등록된 backend 전수 inventory와 같아야 하고 operation id unique/count CHECK를 통과해야 한다. successor는 certificate의 checkpoint와 sequence 바로 다음에서만 시작한다. 같은 operation id의 committed effect는 재실행할 수 없고, `not_started`만 실행 가능하며 `compensated`는 명시한 후속 operation으로만 진행한다.

Claude, Codex CLI, Codex app-server, Agents 각각이 이 certificate를 모든 engine/effect boundary에서 만들 수 있다는 contract test를 통과하기 전에는 해당 backend에 `execution_semantics_v2` capability를 발급하지 않는다. old runner나 backend가 deterministic input, outbox, checkpoint, effect receipt 중 하나를 제공하지 않으면 in-place attachment takeover만 허용하고 process replacement는 허용하지 않는다. process가 이미 사라졌다면 책임은 `recovering(continuity_unproven)`에 남고 사용자-visible terminal이나 context를 날린 새 실행을 만들지 않는다. 이 제한은 기능 누락이 아니라 증명 없는 중복 tool effect·context 유실 경로를 애초에 만들지 않는 결정이다.

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
  | "resolve_identity_or_prepare_replacement"
  | "take_over_attachment_epoch"
  | "quarantine_spawn_and_retry"
  | "await_continuity_certificate";

type RunnerRecoveryDispositionV2 =
  | RunnerRecoveryDisposition
  | "identity_unresolved"
  | "command_plane_orphan"
  | "quarantined_spawn"
  | "continuity_unproven";

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
  command_plane_orphan: {
    task: "required", contendsForOwnership: false,
    revalidate: "before_irreversible_action", action: "take_over_attachment_epoch",
    onOwnershipConflict: "not_applicable",
  },
  quarantined_spawn: {
    task: "required", contendsForOwnership: false,
    revalidate: "before_irreversible_action", action: "quarantine_spawn_and_retry",
    onOwnershipConflict: "not_applicable",
  },
  continuity_unproven: {
    task: "required", contendsForOwnership: false,
    revalidate: "before_irreversible_action", action: "await_continuity_certificate",
    onOwnershipConflict: "not_applicable",
  },
} satisfies Record<RunnerRecoveryDispositionV2, DispositionPolicy>;
```

action executor의 반환 타입은 다음 둘뿐이다.

```ts
type RecoveryReceipt =
  | { kind: "completed"; executionId: ExecutionId; resultingPhase: TaskExecution["phase"] }
  | { kind: "scheduled"; executionId: ExecutionId; wakeAt: IsoDateTime; reason: string };
```

refreshed disposition이 달라지면 executor는 새 키로 같은 `Record`를 다시 조회한다. 아무 일도 하지 않는 `return`은 타입에 없다. `identity_unresolved`, `command_plane_orphan`, `quarantined_spawn`, `continuity_unproven`을 포함한 이 구조는 이후 variant가 추가될 때 policy와 test matrix 양쪽을 컴파일 오류로 만든다.

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

2차 사고의 `lost queued-state CAS`는 이 계약의 필수 회귀다. delivery 2건이 이미 row와 idempotency receipt를 가졌으므로 CAS false는 “접수 실패”가 아니라 “내가 기대한 이전 상태가 아니었다”는 concurrency 결과뿐이다. route는 두 row를 canonical ID로 재조회해 둘 다 같은 `AcceptedInput`을 반환해야 하며 node command를 다시 호출하지 않는다. session head와 delivery reconcile job은 execution이 `active`로 돌아온 transaction에서 binder wake를 받기 때문에 멱등 ping이 없어도 `queued → assigned → consumed`로 진행한다. 동일 stable ID 재전송은 기존 receipt를 반환하고 두 번째 row를 만들지 않는다.

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

runner process는 soul-server의 in-process child가 아니라 독립 runner worker 수명에 속하며 soul-server shutdown 대상이 아니다. 계획 재기동에서 host는 `detachAttachment("host_shutdown")`만 수행한다. engine turn, runner SQLite, writer lock, child socket은 살아 남는다. 정확성은 별도 supervisor의 물리 process 관제가 아니라 execution/attempt/attachment fence에서 나온다.

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
| E4 | 새 identity가 옛 자원과 격리 | callback과 transition이 branded `executionId + generation`을 요구하고, spawn attempt별 state namespace와 attachment epoch가 child·command frame을 fence한다. quarantine attempt와 stale epoch는 canonical 증거/효과가 될 수 없다. | 타입 + DB/runner journal fence |
| E5 | runner·registration 소실 시 waiter eventual settle과 진행 관측 | waiter는 durable execution/saga subscription으로 재구성되고, fair scheduling·저장소 가용성 아래 fenced saga가 eventual settle한다. 무제한 worker fail-stop에는 유한 bound를 주장하지 않는다. 각 claim/phase/receipt/wake가 내부에서 관측되고 외부 timeout은 없다. | DB CHECK/FK + claim epoch + durable wake/alert |
| E6 | 회수는 restart·reserve·message와 독립 | open execution insert가 같은 transaction에서 durable reconcile saga를 강제한다. 재청구마다 claim epoch가 증가하고 모든 step은 stable operation id·expected phase를 검사한다. terminal witness는 saga를 CAS supersede한다. | DB trigger/procedure + saga phase/epoch CHECK |
| E7 | reference clear는 종료가 아님 | public clear API가 없고 `terminal` DB phase는 terminal proof, ingress receipt, request resolution과 고정 7-slot cleanup receipt를 묶은 `ExecutionCleanupBarrier`가 없으면 CHECK에 실패한다. physical release 영구 실패도 owner-bearing transfer로 닫혀 무한 terminating이나 unowned retained가 없다. | branded fixed record + exact-key DB CHECK + 단일 경로 |
| E8 | terminal은 멱등, visible 결과 하나 | runner witness의 outbox high-watermark receipt 뒤 first-signal CAS만 visible terminal을 만든다. | DB unique/CAS + receipt FK |
| E9 | activeRunnerOperations는 실행과 함께 끝남 | 별도 begin/finish mutable set을 없애고 nonterminal controller/resource ledger의 순수 projection으로 계산한다. execution terminal이면 관측 row도 생성 불가다. | 타입 projection + DB execution FK |
| E10 | activation 실패 시 같은 generation active 또는 exact child 격리 | `provisional/activating`은 attempt-scoped exact child proof를 보유한다. cleanup receipt가 없으면 capability-revoked·namespace-excluded `quarantined`가 되고, isolation receipt와 cleanup owner가 없으면 successor spawn을 거부한다. 물리 death는 진행 gate가 아니다. | recovery context 타입 + attempt unique/CAS + isolation receipt |
| E11 | live child/open ownership/unreachable waiter의 제3상태 금지 | running recovery와 preactivation recovery를 다른 context variant로 구성한다. identity 불명, command-plane split-brain, failed spawn은 각각 실제 ownership/activity shape를 위조하지 않고 표현된다. | 판별 유니온 + context별 DB CHECK/FK |
| E12 | rollback은 exact spawned child proof 사용 | `provisional.child` 없이는 rollback proof를 만들 수 없다. sidecar 최신값은 입력 타입이 아니다. | 타입 |
| E13 | recovery retry 또는 명시적 책임 | action receipt와 reconcile job update가 한 DB transaction이다. `scheduled`는 non-null `next_wake_at`, `completed`는 resulting phase를 요구하고, 모든 effect는 current claim epoch와 stable operation id를 요구한다. | 타입 + DB CHECK/CAS transaction |
| E14 | execution inventory는 registration과 별도 reconcile | reconcile job은 execution row FK에서 생성되고 등록 테이블과 독립적으로 열거된다. registration 0건도 job 수를 0으로 만들지 못한다. | DB FK/procedure + full outer join |
| E15 | acquire/release 대칭 경계와 자원 순서 | attachment grant/resource token과 non-empty request set 생성자는 controller module private다. `TerminationSubject`가 running 또는 preactivation context 전체를 소유하고, terminal procedure는 request별 resolution과 고정 7-slot resource receipt를 검사한 barrier만 받는다. | 타입/module boundary + exact-key DB CHECK + contract test |
| E16 | durable/process/memory 불일치는 한 결정표로 해결 | classifier는 사실만 만들고 exhaustive `Record<RunnerRecoveryDispositionV2, DispositionPolicy>`가 action을 강제한다. | exhaustive 타입 + runtime 검사 |

E5의 원문 “제한 시간 안에 settle”은 무제한 worker fail-stop까지 포함하면 달성 불가능하므로 의도적으로 낮췄다. correctness 보장은 durable eventual settle과 외부 timeout 부재이고, 30초는 정상 availability SLO다. E10도 normal path에서는 exact child death를 계속 요구하지만, exact child가 kill 불가이면 물리 death를 기다리며 전체 실행을 멈추지 않는다. capability·namespace·writer를 격리해 그 child를 **현재 실행에 대해 죽은 것**으로 만든 뒤 successor를 허용한다. 둘 다 안전성을 과장하지 않고 사용자-visible 활성을 택한 결정이다.

### delivery 불변식 10개

| # | 불변식 | 위반이 구성상 불가능한 이유 | 강제 수단 |
| ---: | --- | --- | --- |
| D1 | 승인된 논리 메시지는 재전송 없이 다음 유효 실행에 도달 | admission 뒤 책임 상태에는 폐기 terminal이 없고 queued/retry_paused를 maintenance와 activation이 깨운다. | DB 상태기계 + wake |
| D2 | attempt는 concrete execution 또는 explicit unassigned | `queued`에는 attempt가 없고 `assigned`부터 `AssignedDeliveryAttempt`가 필수다. | 판별 유니온 + DB NOT NULL |
| D3 | consumption 최대 1, durable tombstone | attempt id와 runner input receipt unique, delivery consumption receipt unique다. | DB unique + idempotency |
| D4 | unknown attempt reconcile 전 새 attempt 금지 | `reconciling`에 open attempt가 필수이며 binder는 queued만 할당한다. | 타입 + DB partial unique |
| D5 | session FIFO | `session_delivery_heads`가 유일한 assignable delivery를 가리키고 application role의 direct DML을 revoke한다. head advance와 attempt insert는 stored procedure 하나다. | DB head pointer + privilege fence + transaction |
| D6 | 새 execution activation이 redelivery를 깨움 | activation·attachment takeover·spawn retry transaction이 durable binder wake를 함께 기록한다. ping이나 새 메시지는 필요 없다. | 단일 transaction |
| D7 | attempt budget은 cadence만 제어 | DB responsibility CHECK에는 `retry_paused`를 terminal로 인정하는 값이 없고, 해당 상태는 `next_wake_at NOT NULL`과 durable reconcile job을 요구한다. | 타입 + DB CHECK/FK |
| D8 | durable admission 또는 동일 receipt는 성공 ACK | `session_accept_input_v2`가 delivery와 idempotency receipt를 commit하고 그 반환만 generated `AcceptedInput`이 된다. queued-state CAS miss는 stable ID 재조회로 canonical receipt를 반환하며 node command 결과는 route 반환 union에 없다. | DB procedure + generated contract + canonical reread test |
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
| session-scoped registration/pid/lifecycle 후보 병합 | `(executionId, spawnAttemptId)` namespace + current attempt pointer | 이전 attempt가 다음 spawn identity 후보가 되는 경로 1 → 0 |
| `legacy_in_process` compatibility bridge·proof 없는 replacement | v2 capability 거부 + certificate-only replacement | unsafe handoff 경로 2 → 0 |
| persistent supervisor zero-process gate | attempt capability revoke + namespace isolation | 실행을 영구 멈출 수 있는 물리 gate 1 → 0 |
| 임의 이름 cleanup step 배열·unowned retained | 고정 7-slot receipt + owner-bearing physical transfer | 누락 가능한 step N → 고정 record 1 |

직접 field assignment인 `task.runner = undefined`, `task.executionPromise = undefined`, `task.runnerTerminalFact = ...`와 dispatcher `activeStream?.finish/fail`, `closed = true`는 전부 삭제 대상이다. 관측용 `NodeStallMonitor.activeRunnerOperations`는 남을 수 있지만 controller snapshot의 projection일 뿐 생존 판정에는 쓰지 않는다.

## 적용 순서

각 단위는 독립 커밋·독립 review가 가능해야 하고, 끝날 때 시스템은 계속 동작해야 한다.

| 단위 | 변경 | 단위 종료 시 관측 가능한 결과 | 호환 전략 |
| --- | --- | --- | --- |
| 0. 계약 고정 | 정상, pure adopt, 복구 창 intervention, runner-death, activation rollback RED를 영구 gate로 등록 | 제품 동작 변화 없음. 현재 결함 2종만 RED | 별도 테스트 세션이 수행 |
| 1. caller identity 선배포 | web/app action UUID, Slack event ID, MCP required `delivery_id`, respond/approval 결정 ID, interrupt invocation ID, cross-node field 관통 | v1 응답·실행 동작은 그대로지만 동일 logical action 재시도에 같은 ID가 보임 | ID는 shadow 기록만 하고 v2 admission 미활성 |
| 2. 중앙 스키마·fence additive | migration 073의 execution/delivery identity, semantics version, terminal witness/receipt, reconcile job, head pointer, capability/write fence 추가 | 제품 동작 변화 없음. v1 row만 기존 함수로 계속 동작 | v2 procedure 권한은 배포하되 cutover capability off |
| 3. v1 durable admission·legacy spawn fence | caller ID를 기존 delivery ledger에 먼저 commit하고, DB cutoff 뒤 `legacy_in_process` execution 생성을 거부 | v1 요청도 독립 runner 부재 시 durable queued로 기다림. 신규 legacy row 0 | 기존 active legacy row만 grandfathered; direct fallback 호출 금지 |
| 4. 2-1 controller·external wait 도입 | 9-phase `TaskExecution`, 제품 factory, shared fixture, `awaiting_external_input` 전환. legacy 필드는 controller projection | 실행 결과 동일. provisional spawn·pending approval/request·waiter가 inspector에 명시 | v1 writer는 controller adapter만 호출, direct setter 금지 architecture test |
| 5. 2-2 terminal + 2-3 recovery | witness→fixed cleanup receipts→visible terminal, first-signal stream, fenced saga와 exhaustive decision table 도입 | terminal 경합 첫 결과 보존. approval 대기는 reap되지 않고 failed attempt는 격리 뒤 다음 spawn을 막지 않음 | v2 path는 capability off; attempt namespace·quarantine을 shadow 검증 |
| 6. 독립 executor 전환 | attempt-scoped namespace의 독립 runner placement와 DB executor CHECK를 연결하고 user-visible in-process fallback 제거 | v1/v2 durable admission은 capacity가 없으면 waiting. 신규 in-process 선택 0 | 단위 3 fence가 이미 켜져 있어 제거와 admission 사이 공백 없음 |
| 7. attachment 투명화 | frame epoch, gap-free command disposition receipt, recovery endpoint, durable host-call journal, shutdown detach, adopt 후 outbox replay | v2 shadow 실행에서 host 부재가 engine error·턴 중단으로 나타나지 않고 split-brain이 higher epoch로 회수됨 | native epoch 또는 complete legacy barrier가 없으면 eligibility 없음, 외부 ACK 아직 미전환 |
| 8. delivery v2 binder 완성 | execution-bound attempt, stored-procedure FIFO head, reconcile/retry_paused, `session_accept_input_v2`를 inactive gate 뒤에서 통합 | shadow 입력이 다른 delivery에 가려지지 않고 caller ID별 동일 receipt를 만듦 | 외부 route는 단위 3의 durable v1 ACK. v2 end-to-end gate만 실험 |
| 9. 단일 capability cutover | caller ID, v2 DB writer, 독립 runner, handoff fence, continuity certificate, attachment transparency, binder가 모두 ready인 session에서 eligible active v1 실행을 같은 PID·command로 승격 | active v1의 drain을 기다리지 않고 새 delivery가 같은 command에 bind | exact identity가 없으면 recovering. grandfathered legacy in-process는 진입 불가 |
| 10. 구 표면 제거 | Task optional 12, partial cleanup 9곳, legacy disposition helper와 상태 projection 삭제 | 구조 화석 2 제거, direct mutation·v1 open execution 0 | 전 cluster v2 drain과 rollback window 종료 뒤 수행 |

단위 4에서 legacy field와 새 controller를 독립적으로 dual-write하지 않는다. controller가 유일한 writer이고 legacy getter는 controller state의 projection이다. 단위 2의 DB도 v1 row는 v1 함수, v2 row는 v2 함수만 쓰므로 중간 상태에서도 row별 정본은 하나다.

단위 5~8은 모두 `execution_semantics_v2` capability gate 뒤에서 완성하고 v2 traffic에는 노출하지 않는다. 단위 3에서 먼저 켜는 v1 ACK도 node 실행 성공이 아니라 같은 durable admission receipt만 반환하므로 독립 runner 전환 전 공백이 없다. attempt namespace/quarantine, runner-side epoch fence, attachment 투명화와 active-v1 compatibility binder가 v2 cutover보다 먼저 배포되고, v2 cutover는 단위 9 한 번뿐이다. 따라서 “입력은 accepted인데 실행 중 agent는 현행 host-call deadline으로 실패”하는 중간 배포가 없다.

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
- `recovery_context JSONB`; running variant는 subject+activity를 요구하고 preactivation variant는 reservation+child+proof shape를 요구하며 activity를 금지
- `pending_external_requests JSONB`, `request_resolution_receipts JSONB`; request id·semantic event id·publication ingress receipt를 보존하고 key uniqueness와 phase별 empty/non-empty CHECK. response/expiry/cancel은 runner-journal proof, execution terminal은 cleanup proof만 허용
- `termination_intent JSONB`, `runner_terminal_witness JSONB`, `terminal_ingress_receipt JSONB`
- `first_terminal_signal JSONB`, `first_terminal_committed_at TIMESTAMPTZ`; visible terminal은 witness/receipt 또는 preactivation proof와 complete cleanup barrier가 없으면 거부
- `progress_seq BIGINT`, `progress_kind TEXT`, `progress_at TIMESTAMPTZ`
- `progress_lease_expires_at TIMESTAMPTZ`, `tool_leases JSONB`
- `cleanup_state TEXT`, `cleanup_barrier JSONB`; complete barrier는 정확히 7개 key와 request receipt cardinality를 요구하고 physical `retained/transferred`는 responsibility owner FK 없이는 거부
- `attachment_epoch BIGINT`, `attachment_lease_expires_at TIMESTAMPTZ`, `attachment_grant_id TEXT`, `attachment_handoff_state TEXT`; barrier는 `(settledThrough, acceptedThrough]`의 모든 sequence를 settled/transferred로 gap 없이 처분해야 commit 가능
- `current_spawn_attempt_id TEXT`; provisional/activating identity는 이 attempt의 child proof만 참조
- `reconcile_due_at TIMESTAMPTZ`; nonterminal이면 non-null, terminal이면 null
- open phase 전체를 대상으로 한 session당 unique partial index
- cluster cutoff epoch 뒤 `legacy_in_process` executor 생성을 거부하는 v1 admission/execution CHECK procedure
- `session_reserve_execution_v2(...)` semantics/capability/executor fence
- `session_commit_runner_terminal_witness_v2(...)` witness high-watermark CAS
- `session_commit_execution_terminal_v2(...)` outcome candidate·receipt·mandatory cleanup barrier를 한 transaction에서 first visible signal CAS
- `session_replace_execution_v2(...)` predecessor proof, continuity certificate FK와 successor responsibility의 원자 handoff
- `session_prepare_spawn_attempt_v2(...)`, `session_quarantine_spawn_attempt_v2(...)`; current attempt CAS와 capability revoke receipt
- `session_prepare_runner_attachment_v2(...)`, `session_commit_attachment_grant_v2(...)`; DB prepare → runner quiesce barrier → DB writer commit의 monotonic epoch takeover
- `session_promote_open_execution_v1_to_v2(...)` exact v1 identity·attachment receipt를 같은 execution/command의 v2 phase로 원자 승격
- `session_assign_delivery_to_promoted_command_v2(...)` 승격된 active command에 head delivery를 bind하고 deterministic runner input identity를 기록
- `session_list_open_executions(node_id, limit)` inventory 함수

`execution_reconcile_jobs`는 open execution과 1:1 FK를 가진다. `state`, `saga_phase`, `next_wake_at`, `claim_epoch`, `lease_owner`, `lease_expires_at`, 단계별 stable `operation_ids`, `last_receipt`을 보유한다. 재청구는 `claim_epoch=claim_epoch+1` CAS이고 모든 saga effect procedure가 current epoch·operation id·expected phase와 nonterminal execution을 검사한다. `saga_phase`는 stale-host fence → owner fence → runner ready → delivery wake 또는 terminal supersession의 선형 CHECK를 가진다. owner-null row도 `identity_unresolved` job으로 들어간다.

기존 physical 이름은 rolling window 동안 유지한다. 이름은 설계 정본이 아니며 repository가 `DurableExecutionRecord`로 감싼다. 테이블 rename은 정확성에 기여하지 않고 구 stored function을 깨뜨리므로 이 migration의 대상이 아니다.

`session_delivery_attempts`에는 다음을 더한다.

- `attempt_id TEXT UNIQUE`
- `execution_id TEXT`
- `ownership_generation BIGINT`
- `execution_command_id TEXT`
- `execution_semantics_version SMALLINT`, `assignment_kind TEXT`; v2 attempt는 promoted 또는 native v2 independent-runner command만 참조하며 `legacy_in_process` assignment kind는 존재하지 않음
- `assignment_state TEXT`
- `runner_input_sequence BIGINT`
- `resolved_at TIMESTAMPTZ`
- open attempt unique partial index와 execution FK

`session_deliveries`에는 `responsibility_state`를 추가한다. 이것이 새 정본이고 기존 `state`, `aggregate_state`, `uncertain`, `dead_letter`는 rolling compatibility projection으로만 갱신한다. 새 코드는 projection을 읽지 않는다.

추가 표와 제약은 다음과 같다.

- `session_delivery_heads(session_id PRIMARY KEY, head_delivery_id, head_enqueue_sequence, version)`와 FK
- `delivery_rejection_proofs(proof_id PRIMARY KEY, delivery_id UNIQUE, kind, payload_hash, committed_at)`
- `execution_semantics_control(singleton PRIMARY KEY, legacy_in_process_cutoff_epoch, activated_at)`; v1 execution 생성 procedure가 cutoff 뒤 legacy executor를 DB에서 거부
- `execution_host_capabilities(host_instance_id, capability, semantics_version, lease_epoch, lease_expires_at)`
- `execution_runner_capabilities(registration_id, frame_epoch_fence, durable_host_calls, continuity_contract_version, effect_inventory_hash, lease_expires_at)`
- `execution_spawn_attempts(attempt_id, execution_id, state_namespace UNIQUE, phase, child_identity, capability_revocation_receipt_id, canonical_join_state, cleanup_owner_id, cleanup_receipt_id)`; quarantined는 `canonical_join_state='excluded'`와 owner가 필수이며 물리 death는 successor FK의 조건이 아님
- `execution_continuity_certificates(certificate_id, predecessor_execution_id UNIQUE, predecessor_command_id, checkpoint, input/outbox/host_call_watermarks, effect_receipts, pending_requests, delivery_head_id)`
- `execution_post_terminal_maintenance(owner_id PRIMARY KEY, execution_id, claim_epoch, next_wake_at, receipt)`; physical cleanup transfer/retention만 소유하며 logical delivery·request·stream·host-call 정산은 받을 수 없음
- `execution_ingress_capabilities(caller_kind, semantics_version, release_id, ready_at, retired_at)`; 지원 중인 모든 caller kind가 v2 ready여야 cutover 가능
- `session_execution_semantics(session_id PRIMARY KEY, active_version, cutover_epoch)`
- `session_deliveries.delivery_id`는 caller가 준 stable ID이고 `(delivery_id, payload_hash)` idempotency receipt가 정본
- `session_deliveries.semantics_version`은 admission procedure가 session cutover epoch에서 복사하며 v1/v2 writer fence에 포함
- `session_assign_delivery_head_v2(...)`, `session_accept_input_v2(...)`만 delivery/attempt/head를 쓸 수 있으며 application role의 관련 table 직접 DML은 revoke
- `retry_paused`는 `next_wake_at NOT NULL`, `rejected`는 rejection proof FK, v2 delivery는 `responsibility_state NOT NULL` CHECK
- execution별 `prepared/spawned/activated/quarantined` live attempt partial unique 1개. quarantined는 canonical identity join에서 제외되지만 `retired` receipt 전 새 current attempt insert를 거부

마이그레이션 산출 단계에서는 다음 세 곳을 같은 커밋에서 갱신한다.

1. `packages/db-schema/sql/migrations/073_execution_turn_state_machine.sql`
2. `packages/db-schema/migration-manifest.json`의 sha256·rollback compatibility
3. `packages/db-schema/sql/schema.sql`의 bootstrap 동형 정의

runner SQLite는 중앙 migration과 별도로 additive schema upgrade를 한다. execution id, command id, spawn attempt id, input sequence, attachment grant/epoch/command sequence, terminal witness와 outbox high-watermark, delivery attempt id, pending external request 집합과 resolution receipt, fixed tool lease, durable host-call request/response, continuity checkpoint와 effect receipt를 추가한다. 중앙 execution row가 책임 정본이고 runner SQLite는 child가 host 부재 중 남기는 증거다. reconcile이 monotonic sequence와 identity fence를 검증한 뒤 중앙 정본에 투영한다.

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

073은 `legacy_in_process_cutoff_epoch=NULL`로 끝난다. 단위 3 compatibility release가 모든 v1 host의 `durable_v1_admission_no_inprocess` capability를 확인한 뒤 별도 CAS로 cutoff를 한 번 활성화한다. 따라서 schema migration과 fallback 제거 사이에 durable 대기 정본이 없는 창이 없다.

`legacy_in_process`는 host memory에 engine context가 있으므로 이미 active인 실행을 재기동 관통시킬 방법이 없다. 이 실행에 restart를 금지하는 것은 투명성 달성이 아니라 **마이그레이션 동안의 명시적 보장 제외**다. 해당 row가 하나라도 남아 있는 host는 계획 재시작과 v2 cutover를 보류하며, 비계획 host crash에는 컨텍스트 유실 가능성이 남는다. 완전 투명성 보장은 마지막 grandfathered row가 닫힌 뒤부터만 성립한다.

새 legacy row는 단위 3의 v1 admission fence가 막는다. 먼저 모든 v1 host가 `durable_v1_admission_no_inprocess` capability를 광고하는 compatibility release를 배포한다. `session_accept_input_v1_durable(...)`가 caller delivery와 idempotency receipt를 먼저 commit하고, 독립 runner capacity가 없으면 delivery를 `queued`로 유지한다. 그 뒤 DB cluster cutoff epoch를 올리면 v1 execution 생성 procedure가 `executor_kind=legacy_in_process`를 거부하고 `task_executor.ts:278-284`, `:473-479`의 direct fallback은 호출되지 않는다. 늦은 구 binary의 거부는 session/delivery 상태나 caller ACK를 실패로 바꿀 권한이 없고 내부 capability violation으로만 남는다. application role은 execution/delivery direct DML 권한이 없으므로 cutoff를 우회해 새 legacy row를 만들 수 없다. 신규 legacy row 0을 확인한 다음에만 fallback 코드를 제거한다. 기존 active row를 옮기는 bridge와 proof 없는 replacement는 끝까지 만들지 않는다.

### active v1 실행의 in-place v2 승격

eligible independent runner에 대한 결정은 **(a) active v1을 같은 실행으로 승격**이다. open v1 execution이 0이 될 때까지 기다리지 않고, 기존 독립 runner의 PID·start identity·`executionCommandId`·manifest·event/outbox watermark를 보존한다. 새 모델 turn이나 replacement execution을 만들지 않으므로 이미 진행 중인 tool·thinking·context도 끊지 않는다. `legacy_in_process`와 handoff fence/continuity 미지원 runner는 이 집합에 포함되지 않는다.

`session_promote_open_execution_v1_to_v2(...)`는 다음 순서의 단일 cutover procedure다.

1. v2 host가 exact v1 row와 runner lifecycle/bootstrap을 shadow-read하고 `execution_semantics_v2`, deterministic input/outbox, durable host-call journal, continuity certificate, compatibility input adapter capability를 증명한다. native epoch runner면 `runner_epoch`, epoch 전 additive v1 runner면 ordered command barrier·accepted command 전수 처분·socket close를 증명할 `legacy_detach_barrier` mode를 고른다. 이 둘 중 하나도 못 만드는 oldest runner는 promotion 대상이 아니며 실행이 끝날 때까지 그 host의 restart capability도 열지 않는다.
2. `execution_id`는 migration에서 고정한 `legacy:{session_id}:{ownership_generation}`을 그대로 쓴다. runner lifecycle의 registration/PID/start identity/command가 중앙 row와 일치해야 exact promotion이 가능하다. 불일치하면 row를 없애거나 interrupt하지 않고 같은 transaction의 `recovering(identity_unresolved)` branch로 들어간다.
3. procedure는 session semantics row, open execution row, delivery head를 `FOR UPDATE`로 잠근다. v1 `reserved → v2 reserved`, v1 `identity_proven → v2 activating`, v1 `active → v2 active`로 매핑하고 proof·activation compatibility receipt, progress/outbox watermark, reconcile job을 기록한다. `identity_proven → activating`은 `prepareSession`/activation ACK를 다시 거치며 active로 추측 승격하지 않는다.
4. promotion prepare가 DB writer를 `handoff_pending`으로 freeze한 뒤, `runner_epoch` mode는 higher grant를 예약해 runner를 `quiescing`에 CAS하고 barrier receipt를 얻는다. `legacy_detach_barrier` mode는 old host의 command admission을 freeze하고 같은 ordered socket에서 `execution_status` barrier response를 받은 뒤, durable input/outbox/host-call watermark와 accepted command 각각의 settled/transferred 처분을 기록하고 socket을 닫는다. unaccounted command는 0이어야 한다. 새 host가 같은 runner에 frozen 상태로 attach하지 못하면 promotion commit에 들어가지 않고 더 높은 rollback lease로 old host가 재attach·unfreeze한다. 이 preflight에는 input loss나 terminal 투영이 없다.
5. promotion transaction은 execution phase, DB writer lease epoch, `session_execution_semantics.active_version=2`, prepared `PromotionHandoffFence`를 함께 CAS한다. native mode는 runner quiesce barrier를, legacy mode는 closed old socket + prepared new socket identity를 검증한다. 이전 v1 host의 DB lease는 즉시 만료된다. transaction과 경합한 요청은 barrier 전 v1 또는 commit 후 v2 중 한 경로에만 직렬화되고, quiesce/barrier와 commit 사이에는 writer가 0개다. commit 후에는 node command 실패를 ACK에 쓰는 경로가 없다.
6. 이미 승인된 session head가 있고 승격 phase가 `active`면 `session_assign_delivery_to_promoted_command_v2(...)`가 같은 transaction에서 attempt를 기존 `execution_id/execution_command_id`에 bind한다. `activating/recovering`이면 attempt를 만들지 않고 binder wake를 기록한다. activation/reattach transaction이 같은 head를 이어서 bind한다.
7. native mode에서는 transaction commit 뒤 prepared grant를 runner journal `attached`로 활성화하고, legacy mode에서는 prepared new socket만 unfreeze한다. native old epoch frame은 runner가 stale no-op 처리하고, legacy old host는 barrier 전에 admission을 freeze하고 socket을 닫았으므로 늦은 command source 자체가 없다. v2 host는 DB commit과 해당 fence receipt 뒤에만 controller와 binder를 연다.
8. `LegacyExecutionInputAdapter`는 v2 attempt를 `deliveryId`, deterministic `inputUuid=buildDeliveryInputUuid(deliveryId)`, current attachment fence로 투영한다. 기존 `runner_intervention_inbox.intervention_id=deliveryId` primary key와 `claimed_execution_command_id`가 중복·다른 command 소비를 막고, native v2 receipt는 이를 `(attempt_id, runner_input_sequence, attachment_epoch)`로 확장한다. 응답 전 host가 죽으면 reconcile이 같은 delivery/input UUID만 재전송하므로 중복 turn을 만들지 않는다.
9. procedure 전 crash는 v1 row와 lease를 유지한다. runner quiesce 또는 legacy barrier 뒤 transaction 전 crash는 prepared handoff를 재시도하고, 포기할 때는 더 높은 epoch/old-host reattach로 v1을 unfreeze한다. DB commit 뒤 new-host activation 전 crash는 v2 `recovering(command_plane_orphan)` job이 같은 committed grant를 재전송한다. 어느 구간에도 DB writer 둘 또는 runner command writer 둘이 동시에 유효하지 않다.

`legacy_in_process`와 `PromotionHandoffFence`/continuity capability가 없는 old runner는 in-place 승격도 replacement도 하지 않는다. 이 경로를 지원하는 bridge가 문서와 DB procedure에 존재하지 않는 것이 fence다. active-v1 cutover의 대상은 same-command identity와 native epoch 또는 legacy detach barrier를 증명한 독립 runner뿐이다.

### rolling coexistence

1. additive 073을 먼저 배포한다. v1 function은 `semantics_version=1` row만 쓸 수 있고 v2 function은 caller의 live capability lease와 `writer_semantics_version=2`를 검사한다.
2. 기존 v1 writer inventory를 전수 확인하고, direct DML 호출이 있으면 같은 signature의 v1 compatibility procedure로 먼저 옮긴다. 그 뒤 application role의 direct execution/delivery DML을 revoke한다. v1 procedure는 v2 row reserve/activate/terminate/update를 DB에서 거부한다. rollback·늦은 재접속·부분 배포도 이 fence를 우회하지 못한다.
3. semantics v2 host는 additive v1 bootstrap을 `LegacyExecutionWitnessAdapter`로 읽는다. native epoch가 없더라도 durable host-call journal과 ordered detach barrier를 모두 증명하면 legacy fence로 promotion할 수 있다. 둘 다 없는 oldest runner는 eligibility가 없다. v1 host는 v2 row를 읽기 전용 조회만 할 수 있고 ownership·attachment를 claim할 수 없다.
4. orch routing은 `execution_host_capabilities`의 unexpired `execution_semantics_v2` lease가 있는 host·runner에만 v2 session을 보낸다. 가능한 host가 없으면 admission된 delivery와 reserved placement가 기다리며 old host로 downgrade하거나 실패하지 않는다.
5. v2 row의 정본은 `responsibility_state`와 v2 execution phase다. legacy `state`/`aggregate_state`는 v2 procedure가 만드는 역방향 read projection일 뿐이고 v1 writer가 수정할 수 없다. v1 row는 기존 column이 정본이므로 row별 정본이 하나다.
6. v2 runner는 rolling 기간에 기존 `frame_protocol` 형식과 bootstrap projection을 함께 기록한다. Zod 형식 정본은 유지하고 `semantics_version`이 의미 계약을 가른다.
7. session cutover는 caller identity, DB writer, host, independent runner, native epoch 또는 legacy detach barrier, continuity certificate, compatibility binder capability를 한 번에 확인하고 `session_promote_open_execution_v1_to_v2(...)` 안에서 `cutover_epoch`를 CAS한다. eligible active v1 row는 같은 execution/command로 승격하며 drain을 기다리지 않는다. `legacy_in_process`·handoff fence 미지원 runner·continuity 미지원 backend는 node restart/cutover capability 자체가 없으므로 이 procedure에 진입하지 못한다.
8. rollback 시 이미 열린 v2 execution은 capability lease가 남은 v2 host가 drain·handoff한다. v1 binary로 강제 인계하지 않으며, DB fence 때문에 운영 순서를 어겨도 v1 writer가 v2 정본을 훼손하지 못한다.

이 공존 전략에서도 사용자 ACK는 admission receipt 하나다. 구·신 runner 선택이나 handoff 대기는 외부 결과에 나타나지 않는다. “구 host가 v2-only 실행을 만나지 않게 배포한다”는 운영 희망이 아니라 DB write fence와 capability routing이 정본 하나를 강제한다.

## 검증자가 확인할 열어 둔 질문

1. capability cutover의 최소 단위를 session으로 둘지 node로 둘지 운영·부하 실측이 필요하다. 정확성 조건은 어느 쪽이든 DB cutover epoch와 unexpired host/runner/caller/continuity capability를 한 transaction에서 확인하는 것이다.
engine checkpoint와 비멱등 effect 증명은 열린 질문이 아니다. backend별 전수 inventory와 certificate contract test를 통과하지 못하면 해당 backend의 v2 capability가 닫힌다. epoch/deterministic input/outbox가 없는 old runner도 replacement로 보내지 않고 promotion eligibility를 주지 않는다.

external request의 사용자 관측도 열린 질문이 아니다. replacement는 request id와 semantic event id·publication receipt를 보존하고, 이미 published인 AskUserQuestion·approval을 다시 emit하지 않는다. transport별 저장 위치와 UI adapter 함수명만 구현 단계에서 확정한다.

## 설계 검증 통과 조건

- 문서의 9 phase가 실제 entry/terminal/external-input 경로를 MECE로 덮고, silent return이나 direct clear가 필요한 사례가 없어야 한다.
- 실행 불변식 16개와 delivery 불변식 10개가 각각 최소 한 개의 타입, DB 제약, 단일 경로, runtime reconcile에 연결되어야 한다.
- 정상, pure adopt, 복구 전 intervention 세 시나리오가 행 단위 trace에서 같은 ACK와 semantic event 순서를 보여야 한다. 현재 ③의 503·event 2종 소실·pending receipt가 모두 사라져야 한다.
- runner-death와 activation rollback 영구 RED가 새 구조에서는 각각 certificate-bearing responsibility handoff와 exact child cleanup 또는 capability-revoked namespace isolation으로만 green이 되어야 한다. worker fail-stop을 무제한 주입한 fixture에는 유한 settle을 요구하지 않고 fenced progress·wake 보존과 외부 timeout 부재를 요구한다.
- #818의 2-2 기존 green 0 파단, 2-3 37 passed를 기준선으로 삼고, 2-1은 shared fixture 한 곳 변경으로 계약 8개를 보존해야 한다.
- Claude `text`, Codex 두 mapper, Agents 완료 output이 semantic progress 3종으로 exhaustive하게 정규화되고, 30분 gap·30분 tool absolute lease·external wait suspension의 경계 테스트가 있어야 한다.
- 한 execution에 external request 2개 이상을 열고 하나씩 response/expiry/cancel하는 테스트, 마지막 request에서만 active로 돌아가는 테스트, terminating이 전 request resolution receipt를 요구하는 테스트, Claude 300초 expiry 뒤 late response가 재기동 유무와 무관하게 같은 `expired`를 반환하는 테스트가 있어야 한다.
- delivery·external request·stream·host-call logical cleanup 하나를 실패시킨 동안 phase와 visible 결과가 `terminating`에 머물러야 한다. attachment/writer/child physical release가 영구 실패하면 owner-bearing transfer receipt 뒤 terminal이 한 번 보이고, 새 owner가 없는 retained/transferred fixture는 DB에서 거부되어야 한다. exact 7-key 외 임의 cleanup step도 거부한다.
- ownership proof 직후, `prepareSession` 중, activation ACK 직전 crash가 각각 durable `activating`으로 hydrate되고 v1 `identity_proven`을 v2가 직접 만들지 않는 DB phase 계약 테스트가 있어야 한다.
- active v1 runner를 승격하는 동안 같은 PID·command·manifest를 보존하고 concurrent delivery가 기존 command에 정확히 한 번 bind되며 late v1 DB write와 stale attachment-epoch command가 모두 effect 전에 거부되는 trace가 있어야 한다. eligible independent runner에 open v1 execution 0건을 사전조건으로 삼으면 실패다.
- 18:06 표본을 fixture로 만들어 live PID + stale attachment에서 reserve conflict가 아니라 higher epoch barrier가 선택되고, host restart·runner SIGTERM·ping 없이 pending host call과 delivery가 같은 command에서 이어져야 한다.
- activation rollback의 normal fixture에서는 exact child 사망을 계속 검증한다. kill 불가 fixture에서는 capability revoke·namespace exclusion·cleanup owner가 한 transaction에 생긴 뒤 successor namespace가 열리고, old PID가 살아 있어도 canonical PID 후보·writer·effect executor가 되지 않아야 한다. N회 반복은 물리 process 수가 아니라 canonical candidate와 current spawn slot이 각각 최대 1인지 검증한다.
- recovery worker A를 effect 직후 멈추고 B가 higher claim epoch로 재청구한 뒤 A를 재개해, A의 takeover·spawn·binder receipt가 모두 effect 전에 거부되는 테스트가 있어야 한다. 같은 순간 terminal witness가 오면 saga는 `superseded_by_terminal` 한 경로로만 수렴해야 한다.
- attachment quiesce 직전 intervention·interrupt·close·host response를 accepted 상태로 삽입하고 barrier의 `(settledThrough, acceptedThrough]`가 전부 settled/transferred로 gap 없이 덮이는지 검증한다. transferred command는 새 epoch에서 같은 command id로 한 번만 실행되어야 한다.
- old epoch의 intervention·interrupt·close와 host response를 higher epoch commit 전후에 삽입해, 전에는 old writer 하나만 실행되고 runner CAS 뒤에는 모두 stale no-effect receipt가 되는 command-plane race test가 있어야 한다.
- `legacy_in_process`와 native epoch·complete legacy detach barrier 중 어느 것도 없는 runner, continuity 미지원 backend는 capability가 발급되지 않고 promotion/replacement procedure signature 자체로 입력할 수 없어야 한다. certificate의 effect receipt 하나를 제거한 fixture도 replacement FK/CHECK에서 거부되어야 한다.
- v1 admission cutoff 뒤 구 binary가 fallback을 선택해도 DB가 새 `legacy_in_process` row를 거부하고, delivery는 accepted/queued 한 row로 남아 독립 runner 배정 뒤 소비되어야 한다. 기존 active legacy row crash에는 투명성을 주장하지 않으며 마지막 row가 닫히기 전 계획 restart가 보류되는지도 별도 migration test로 고정한다.
- external input 중 replacement 전후 UI event를 비교해 published request는 재emit 0회, unpublished request는 같은 semantic event id로 총 1회여야 한다. response·expiry·cancel receipt는 동일 request id에 붙어야 한다.
- migration 073은 6,319행 fixture와 migration 중 concurrent v1 insert fixture에서 nullable 추가→backfill→job 생성→CHECK validate→NOT NULL 순서를 dry-run하고 open 5행 전부에 정확히 한 reconcile job이 생겨야 한다.
- caller 8계열이 첫 send 전 stable ID를 만들고 commit-after-response-loss에서 같은 receipt를 받는 transport test를 통과해야 한다.
- delivery 2건을 commit한 뒤 queued-state CAS false와 orch response loss를 주입해도 두 호출 모두 accepted receipt를 받고 row 수가 2에서 늘지 않으며, execution recovery transaction의 binder wake만으로 둘 다 FIFO consumed되어야 한다.
- no-worker-failure fixture에서 command-plane orphan과 certificate-bearing process-absence handoff의 30초 SLO를 측정한다. claim-worker fail-stop fixture는 수학적 상한 대신 claim epoch 증가, stable operation receipt 재사용, non-null next wake, 내부 alert, 외부 timeout·503 부재를 검증한다.
- 제품 코드 구현 전에 migration 073의 forward/rollback compatibility, direct DML revoke, v1 writer→v2 row 거부, capability routing을 별도 검토해야 한다.

## 중간 결론

재기동 투명성은 더 많은 예외 처리로 얻지 못한다. 실행 턴, 그 턴에 할당된 입력, 첫 terminal과 자원 수명을 하나의 identity와 상태기계로 묶고, 정상 경로도 같은 durable 경계를 통과시킬 때만 재기동이 평상시와 구분되지 않는다.
