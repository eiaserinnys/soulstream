# 실행 턴 1급 상태기계 재설계

기준 커밋: `e5d66742` (2026-08-23, PR #819 포함)

상태: 설계 10차·외부 r5 반영본. 축소 모델과 닫힌 계약은 유지하면서 mutation 대상을 stable lineage/delivery/request로 옮겼다. runner-local attachment journal과 assignment disposition slot, request application 단일 chain, delivery-level cancel, lineage-level stop, retention takeover/release를 같은 fact 모델 안에서 닫았다. 제품 코드, DB 마이그레이션, 배포는 이 문서의 범위가 아니다.

## 판정 기준

이 설계의 성공 조건은 하나다.

> **재시작 유무가 입력 승인 의미·출력·최종 결과·필요한 사용자 조작을 바꾸지 않는다.**

따라서 “실패를 정직하게 알렸다”, “큐에 넣었다고 알려 줬다”, “다시 보내면 된다”는 수용되지 않는다. 정상 경로와 재기동 경로가 같은 입력 승인 계약, 같은 출력 스트림, 같은 최종 결과를 사용해야 한다.

## 설계 결정 요약

현재 결함의 뿌리는 **실행 중인 한 턴의 의미를 너무 많은 writable state로 나눠 가진 것**이다. 최종 모델은 다음 일곱 정본만 둔다.

1. logical execution lifecycle은 `open | terminal` 둘뿐이고 terminal은 visible outcome, continuity transfer, migration archival을 구분한다.
2. spawn·ownership·activation은 `RunnerAttempt`의 단조 receipt이고, phase는 한 reducer의 projection이다.
3. attachment와 terminal 이후 retention은 중앙 DB와 runner journal이 공유하는 fenced epoch lease다. runner↔host call/response도 같은 epoch tuple을 가진 generated wire다.
4. 입력은 durable `DeliveryScope(session|execution|request)`와 consumption/no-effect receipt를 가진다. cancel은 stable delivery, stop은 stable execution lineage, response는 stable request를 mutation 대상으로 삼는다.
5. external request publication과 delivery assignment는 공통 생성 schema의 kind별 `IdempotentOperation`을 쓰고, operation 하나가 단계 receipt를 소유한다. 도메인 ledger는 receipt FK만 가진다.
6. terminal은 runner witness→event ingress receipt→`TerminalSafetyBarrier`→visible terminal 순서다. 물리 회수 권한은 `cleanup_obligation` 하나다.
7. 외부도 execution·delivery·availability·control을 독립 projection으로 내리고 continuity breach는 `blocked`로 표시한다. transport 중복은 semantic event id reducer가 제거한다.

user-visible 실행은 `in_process`로 폴백하지 않는다. replacement는 effect boundary마다 durable한 `ExecutionContinuityCertificate`가 있을 때만 가능하다. 전역 zero-process gate·recovery saga·process permit 상태기계는 두지 않으며, 격리 attempt의 미회수 process 수와 cleanup scheduling은 `RunnerAttempt` receipt와 단일 obligation에서 파생한다.

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

두 intervention은 delivery row에 등재된 뒤 queued-state CAS가 빗나갔고 caller에는 503이 반환됐으며, 복구 뒤에도 `queued`로 남았다. CAS miss는 접수 실패가 아니다. v2 admission은 stable delivery id로 immutable admission receipt를 재조회해 같은 `received`를 반환하고, append-only assignment가 runner inbox receipt와 consumption receipt를 얻을 때까지 같은 `IdempotentOperation` identity로 durable하게 재개된다.

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
| 2-1 `TaskExecution` 1급 모델 | 1 | adoption shared fixture를 fact-ledger factory로 바꾸면 8개 계약이 유지된다. 옛 필드 형태 자체를 기대하는 1개는 구조 화석이라 제거한다. |
| 2-2 단일 terminal state | 0 | 즉시 적용 가능한 저저항 경계다. 첫 terminal 신호 보존 RED도 구조 전환만으로 green이 됐다. |
| 2-3 `DispositionPolicy` 결정표 | 0 | 37개가 모두 통과했다. “기존 disposition 테스트가 결정표를 막는다”는 가설은 실측으로 폐기한다. |

adoption 10개 중 9개가 shared fixture를 통해 `runner` 또는 `executionPromise`에 의존하고, 그중 8개는 fixture 변환만으로 계약을 보존한다. cleanup 4개는 Task 필드에 의존하지 않는다. fixture 경계는 `createExecutionFactFixture(facts)` 하나로 통합하며 제품 reducer와 같은 projection 생성기를 사용한다.

추가로 다음 테스트 공백을 구조로 닫는다.

- `runner_adoption_failure_recovery.ts:300`의 supersession은 promise 존재 비교가 아니라 `executionId`와 generation 비교가 된다.
- `runner_recovery_disposition.ts:118`의 refreshed `closed` 분기는 declarative reducer가 action-bearing recovery projection을 반환하고, executor가 receipt 또는 다음 wake를 반드시 기록하게 한다. silent return 타입은 없다.
- 등록 소멸 뒤 waiter는 중앙 open execution fact를 구독해 재구성된다. 외부 timeout은 없으며, 무제한 worker fail-stop까지 포함한 유한 settle bound는 주장하지 않는다.
- `fail → fail`을 포함한 모든 terminal 조합은 first-signal CAS 하나가 처리한다.
- #818의 `Record<RunnerRecoveryDisposition, DispositionPolicy>` probe는 구현 저항도 기준으로 보존한다. 최종 구조에서는 같은 exhaustiveness를 `execution_semantics.v2` reducer 생성물이 담당한다.

기존 관련 테스트 62개는 명세 28, 현재 동작 기록 32, 구조 화석 2로 분류한다. 명세 28은 유지하고 구조 화석 2는 제거한다. 현재 동작 기록 32 중 아래 정책값과 맞닿은 것은 의도적으로 재기준화한다. 이 RED는 회귀가 아니다.

| 바뀌는 정책값 | 기존 | 새 정책 |
| --- | --- | --- |
| reconnect budget 소진 | active stream 실패 후 필드 정리 | `recovering` 전이와 자력 reconcile 요청. 외부 stream은 실패하지 않는다. |
| host detach | 실행 close와 같은 `closed=true` | attachment만 반납. 실행은 계속 active/recovering이다. |
| supersession | runner/promise 존재와 객체 동일성 | `executionId + ownershipGeneration`의 단일 비교다. |
| refreshed disposition 변화 | 분기별 silent return 가능 | reducer가 새 recovery projection의 action을 실행하거나 durable wake를 기록한다. |
| terminal 경합 | 마지막 `fail()`이 보일 수 있음 | durable first terminal signal만 보인다. |
| attempt budget 소진 | `uncertain` 또는 `dead_letter` | operation receipt와 next wake가 남는다. 별도 writable 상태는 없다. |
| queued CAS miss | 예외가 503으로 투영될 수 있음 | canonical admission receipt를 재조회하여 같은 `received`를 반환한다. |
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

adoption 10건 중 9건이 shared fixture를 경유하고 8건은 fact-ledger fixture로 계약을 유지할 수 있으며, stopped recovery 1건만 옛 field 존속 자체를 기대한다. cleanup 4건은 Task field 의존이 없다.

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
| 3 | caller ACK | `{ status: "received", deliveryId, meaning: "durably_received_may_not_be_running" }` | 동일 | 동일. 503·retry 요구 없음 |
| 4 | execution bind | assignment operation을 현재 `executionId/executionCommandId`에 prepare | adopt가 보존한 같은 execution/command와 higher attachment epoch에 prepare | attachment 복원 전 prepared 상태; barrier 또는 eligible active-v1 승격 receipt 직후 **같은 열린 command**의 runner inbox에 register |
| 5 | runner input | `runnerInputSequence=N` inbox receipt 뒤 consume | 동일 | 복구 대기만 늘고 동일 receipt |
| 6 | semantic event | `user_message → tool_start → intervention_sent → tool_result → 개입이 반영된 단일 assistant_message` | 동일 순서·event id dedupe | 동일 순서·event id dedupe. `intervention_demand/context_reply` 소실 없음 |
| 7 | delivery 정산 | `consumed`, attempt와 input receipt가 동일 execution을 가리킴 | 동일 | 동일. `queued/pending` 영구 잔류 없음 |
| 8 | caller 재조회·재전송 | 같은 delivery receipt를 반환 | 동일 | admission 응답 전에 orch가 죽어도 같은 stable ID로 동일 receipt 반환 |

③의 내부 trace는 `received → assignment prepared → higher-epoch attachment barrier 또는 eligible active-v1 in-place promotion → runner inbox registered → consumed → head advanced`다. spawn failure가 끼면 old attempt isolation과 successor attempt receipt가 추가되지만 외부 행은 변하지 않는다. 내부 원인은 숨겨도 delivery received/consumed, execution activity, availability의 보장 축은 숨기지 않는다. 이 표의 행 3·6·7이 PR #819 transparency oracle의 비교 대상이고, 세 열의 값이 다르면 v2 cutover를 열지 않는다.

검증 라운드별 폐쇄표는 삭제했다. 같은 계약을 이력별로 반복하면 장치가 늘어난 것처럼 보이고 정본이 갈린다. 현행 정본은 아래 fact schema·projection reducer·불변식 매핑뿐이다. 이전 라운드에서 통과한 attempt 격리, attachment command fence, terminal ordering, continuity certificate, admission cutoff는 이 작은 정본의 receipt 제약으로 유지한다.

## 시스템 그림

### A. 진입 경로 매트릭스

| # | 진입 | 현재 조립 위치 | 새 구조의 첫 호출 | 실행 identity |
| ---: | --- | --- | --- | --- |
| 1 | 최초 턴 | `task_executor.ts:374` | reservation receipt commit | 생성한 `executionId` |
| 2 | 자동 재개 | `task_auto_resume_transition.ts:67` | session-scoped delivery admission 뒤 open execution reserve | 새 `executionId` |
| 3 | live runner adopt | `task_executor.ts:723` | higher attachment epoch receipt | 중앙 open execution의 기존 `executionId` |
| 4 | offline terminal replay | `task_executor.ts:788` | witness/outbox ingress reconciliation | runner witness가 가리키는 기존 `executionId` |
| 5 | certified replacement | `task_executor.ts:1030` | process-absence proof와 continuity certificate를 successor reservation에 commit | 앞 실행과 다른 새 `executionId`; certificate 없으면 진입 불가 |
| 6 | 주기 회수 | `runner_recovery_coordinator.ts:161` | open facts를 reducer에 넣고 due receipt operation 실행 | 중앙 open row의 `executionId` |
| 7 | 개입·응답·interrupt | `task_intervention_route.ts:136`, `sessions.py:370` | scope-bearing delivery admission 또는 stop intent CAS | scope가 지정한 session/execution/request |

### B. 전달 경로

```text
사용자·에이전트 입력
  → caller stable delivery id + silent transport retry
  → orch durable admission + idempotency receipt
  → session FIFO delivery ledger (아직 unassigned 가능)
  → 중앙 open execution inventory
  → open logical execution과 reducer projection
  → RunnerAttempt namespace의 독립 runner spawn/isolation receipts
  → DB prepare → runner quiesce barrier → DB commit attachment
  → delivery attempt를 executionId + commandId에 bind
  → runner durable input inbox
  → engine turn
  → runner event/host-call journal
  → event ingress의 dedupe receipt
  → dashboard·호출자 replay

stable control/response
  → delivery cancel: session delivery row intent/winner
  → stop: execution lineage row intent/current binding
  → request response: request authority row → exact delivery consumption FK
```

정상 경로도 반드시 이 흐름을 탄다. “runner가 붙어 있으면 바로 보내고, 없으면 큐”라는 이중 경로를 두지 않는다. 차이는 bind와 소비까지 걸린 시간뿐이며, 외부 ACK는 항상 durable admission receipt다.

### C. 사용자 관측 위치

| 관측 위치 | 정상·재기동 공통 계약 | 숨겨야 할 내부 상태 |
| --- | --- | --- |
| 개입 API·MCP·cross-node ACK | `{ status: "received", deliveryId }` | attachment/recovery 원인, retry count |
| 채팅 출력 | at-least-once replay + semantic id effectively-once rendering | dispatcher reconnect, adopt, offline replay |
| 실행 중 에이전트의 host call | 같은 correlation id의 최종 응답 | host attachment 교체, 소켓 단절 |
| AskQuestion·approval 응답 | applied/already_applied/not_applied canonical receipt | 복구 전 소비 지연 |
| 세션 최종 상태 | 첫 terminal outcome 한 번 | 중복 terminal 신호, cleanup 실패 재시도 |

### D. 동시 갱신 점검표

| 변경 | 동시에 갱신할 정본 |
| --- | --- |
| projection 추가 | `execution_semantics.v2` schema 한 곳; 여기서 TS union·SQL view/check·transition fixture 생성 |
| 실행 identity 필드 추가 | 중앙 execution row, runner bootstrap witness, frame semantic validator, delivery attempt ref, test fixture factory |
| terminal outcome 추가 | runner witness, `PublicOutcome`, ingress receipt, terminal safety reducer |
| 새 입력 종류 추가 | caller identity, `DeliveryScope`, admission schema, assignment operation, runner inbox, resolution receipt |
| 새 cancel/stop control 추가 | stable delivery/lineage target, invocation receipt, binding/rebind lock order, public control fixture |
| 새 progress 종류 추가 | semantic progress classifier 한 곳, runner lifecycle witness, 중앙 progress projection, lease tests |
| attachment command 추가 | DB grant procedure, frame envelope, runner epoch journal, host dispatcher, stale-frame no-effect test |
| spawn identity 추가 | `RunnerAttempt`, attempt namespace, registration join, isolation receipt, cleanup obligation 참조 |
| replacement backend 추가 | continuity capability, checkpoint adapter, effect inventory hash, certificate DB CHECK, duplicate-effect test |

## 1급 타입 정의

다음은 구현 목표 시그니처다. 핵심은 상태 이름을 저장하는 것이 아니라 단조 증가하는 사실을 저장하고, 한 reducer가 화면·복구용 상태를 계산하는 것이다. `null`은 “아직 receipt가 없음”만 뜻하며 “해당 없음”이나 “치웠음”을 겸하지 않는다.

~~~ts
type ExecutionId = string & { readonly __brand: "ExecutionId" };
type ExecutionLineageId = string & { readonly __brand: "ExecutionLineageId" };
type DeliveryId = string & { readonly __brand: "DeliveryId" };
type ExecutionCommandId = string & { readonly __brand: "ExecutionCommandId" };
type ExternalRequestId = string & { readonly __brand: "ExternalRequestId" };
type SpawnAttemptId = string & { readonly __brand: "SpawnAttemptId" };
type ExecutionRetentionId = string & { readonly __brand: "ExecutionRetentionId" };
type AttachmentEpoch = number & { readonly __brand: "AttachmentEpoch" };
type RunnerCommandSequence = number & { readonly __brand: "RunnerCommandSequence" };
type IsoDateTime = string & { readonly __brand: "IsoDateTime" };

interface ExecutionKey {
  sessionId: string;
  lineageId: ExecutionLineageId;
  executionId: ExecutionId;
  ownershipGeneration: number;
  entryPath: "initial" | "auto_resume" | "adopt" | "replacement";
  createdAt: IsoDateTime;
}

interface ExecutionReservationReceipt {
  receiptId: string;
  key: ExecutionKey;
  semanticsVersion: 2;
  executorKind: "independent_runner";
  manifestId: string;
  runtimeEnvIdentity: string;
  committedAt: IsoDateTime;
}

interface SpawnedChildReceipt {
  receiptId: string;
  attemptId: SpawnAttemptId;
  registrationId: string;
  pid: number;
  startIdentity: string;
  executionCommandId: ExecutionCommandId;
  committedAt: IsoDateTime;
}

interface SpawnAttemptIsolationReceipt {
  receiptId: string;
  attemptId: SpawnAttemptId;
  capabilityEpoch: number;
  capabilityRevocationReceiptId: string;
  canonicalJoin: "excluded";
  isolatedAt: IsoDateTime;
}

interface ExactProcessAbsenceReceipt {
  receiptId: string;
  attemptId: SpawnAttemptId;
  spawnReceiptId: string;
  nodeId: string;
  pid: number;
  startIdentity: string;
  observedAt: IsoDateTime;
}

type PhysicalAbsenceReceipt =
  | {
      kind: "not_launched";
      receiptId: string;
      stableLaunchOperationId: string;
      finalClaimEpoch: number;
      committedAt: IsoDateTime;
    }
  | { kind: "process_absent"; receipt: ExactProcessAbsenceReceipt };

interface RunnerAttempt {
  attemptId: SpawnAttemptId;
  executionId: ExecutionId;
  nodeId: string;
  stateNamespace: string;
  stableLaunchOperationId: string;
  reservedAt: IsoDateTime;
  spawnReceipt: SpawnedChildReceipt | null;
  ownershipProof: { receiptId: string; committedAt: IsoDateTime } | null;
  activationReceipt: { receiptId: string; committedAt: IsoDateTime } | null;
  isolationReceipt: SpawnAttemptIsolationReceipt | null;
  physicalAbsenceReceipt: PhysicalAbsenceReceipt | null;
  cleanupObligationId: string | null;
}

type CleanupResource =
  | { kind: "attempt_child"; attemptId: SpawnAttemptId }
  | { kind: "attachment"; executionId: ExecutionId; grantId: string }
  | { kind: "writer"; executionId: ExecutionId; writerLeaseId: string }
  | { kind: "retention"; executionId: ExecutionId; retentionId: ExecutionRetentionId }
  | {
      kind: "auxiliary";
      executionId: ExecutionId;
      name: "temp_files" | "diagnostics" | "telemetry";
    };

interface CleanupObligation {
  obligationId: string;
  resource: CleanupResource;
  effectFenceReceiptId: string;
  stableOperationId: string;
  claimEpoch: number;
  leaseOwner: string | null;
  leaseExpiresAt: IsoDateTime | null;
  nextWakeAt: IsoDateTime | null;
  physicalResolutionReceiptId: string | null;
}

type DeliveryScope =
  | { kind: "session"; sessionId: string }
  | {
      kind: "execution";
      lineageId: ExecutionLineageId;
      executionId: ExecutionId;
      ownershipGeneration: number;
    }
  | {
      kind: "request";
      lineageId: ExecutionLineageId;
      requestId: ExternalRequestId;
      requestAuthorityEpoch: number;
    };

interface DurableDeliveryPayload {
  encoding: "canonical_jsonb";
  envelope: Readonly<Record<string, unknown>>;
}

interface DeliveryRecord {
  deliveryId: DeliveryId;
  scope: DeliveryScope;
  payload: DurableDeliveryPayload;
  payloadHash: string;
  enqueueSequence: bigint;
  admittedAt: IsoDateTime;
  cancelIntentReceiptId: string | null;
  resolutionReceiptId: string | null;
}

type DeliveryCancelIntentReceipt = OperationReceiptBase & {
  kind: "delivery_cancel_requested";
  store: "postgres";
  deliveryId: DeliveryId;
  invocationId: string;
};

interface OperationReceiptBase {
  receiptId: string;
  operationId: string;
  payloadHash: string;
  committedAt: IsoDateTime;
}

interface OperationClaim {
  claimEpoch: number;
  leaseOwner: string | null;
  leaseExpiresAt: IsoDateTime | null;
  nextWakeAt: IsoDateTime;
}

type ExternalRequestResolutionReceipt = OperationReceiptBase &
  (
    | {
        kind: "responded";
        store: "postgres";
        deliveryId: DeliveryId;
        requestAuthorityEpoch: number;
        admittedAt: IsoDateTime;
      }
    | {
        kind: "expired";
        store: "postgres";
        expiresAt: IsoDateTime;
      }
    | {
        kind: "cancelled";
        store: "postgres";
        reason: "request_owner" | "user";
      }
    | {
        kind: "cancelled";
        store: "postgres";
        reason: "execution_finished";
        terminalWitnessId: string;
      }
  );

type RunnerRequestResolutionReceipt = OperationReceiptBase &
  (
    | { kind: "input_request_expired"; store: "runner_sqlite"; centralResolutionReceiptId: string }
    | { kind: "input_request_cancelled"; store: "runner_sqlite"; centralResolutionReceiptId: string }
  );

type EngineRequestApplicationReceipt = OperationReceiptBase &
  (
    | {
        kind: "engine_applied_request_expiry";
        store: "runner_sqlite";
        runnerResolutionReceiptId: string;
        result: "not_applied";
      }
    | {
        kind: "engine_applied_request_cancellation";
        store: "runner_sqlite";
        runnerResolutionReceiptId: string;
        result: "not_applied";
      }
  );

interface RequestResponseApplicationReference {
  kind: "delivery_consumption";
  requestId: ExternalRequestId;
  requestAuthorityEpoch: number;
  deliveryId: DeliveryId;
  assignmentOperationId: string;
  runnerDispositionReceiptId: string;
  centralResolutionReceiptId: string;
  runnerInputSequence: number;
}

interface RequestTerminalNoEffectReference {
  kind: "terminal_witness_no_effect";
  executionId: ExecutionId;
  terminalWitnessId: string;
}

type RequestJournalReceipt = OperationReceiptBase & {
  kind: "request_journaled";
  store: "runner_sqlite";
};

type RequestRegistrationReceipt = OperationReceiptBase & {
  kind: "request_registered";
  store: "postgres";
};

type RequestPublicationReceipt = OperationReceiptBase & {
  kind: "request_published";
  store: "event_ingress";
  publishedAt: IsoDateTime;
  expiresAt: IsoDateTime | null;
};

type RequestResolutionChain =
  | {
      state: "unresolved";
      central: null;
      runner: null;
      engineApplication: null;
    }
  | {
      state: "central_committed";
      central: ExternalRequestResolutionReceipt;
      runner: null;
      engineApplication: null;
    }
  | {
      state: "runner_recorded";
      central: Extract<ExternalRequestResolutionReceipt, { kind: "expired" }>;
      runner: Extract<RunnerRequestResolutionReceipt, { kind: "input_request_expired" }>;
      engineApplication: null;
    }
  | {
      state: "runner_recorded";
      central: Extract<
        ExternalRequestResolutionReceipt,
        { kind: "cancelled"; reason: "request_owner" | "user" }
      >;
      runner: Extract<RunnerRequestResolutionReceipt, { kind: "input_request_cancelled" }>;
      engineApplication: null;
    }
  | {
      state: "applied";
      central: Extract<ExternalRequestResolutionReceipt, { kind: "responded" }>;
      runner: null;
      engineApplication: RequestResponseApplicationReference;
    }
  | {
      state: "applied";
      central: Extract<ExternalRequestResolutionReceipt, { kind: "expired" }>;
      runner: Extract<RunnerRequestResolutionReceipt, { kind: "input_request_expired" }>;
      engineApplication: Extract<
        EngineRequestApplicationReceipt,
        { kind: "engine_applied_request_expiry" }
      >;
    }
  | {
      state: "applied";
      central: Extract<
        ExternalRequestResolutionReceipt,
        { kind: "cancelled"; reason: "request_owner" | "user" }
      >;
      runner: Extract<RunnerRequestResolutionReceipt, { kind: "input_request_cancelled" }>;
      engineApplication: Extract<
        EngineRequestApplicationReceipt,
        { kind: "engine_applied_request_cancellation" }
      >;
    }
  | {
      state: "applied";
      central: Extract<
        ExternalRequestResolutionReceipt,
        { kind: "cancelled"; reason: "execution_finished" }
      >;
      runner: null;
      engineApplication: RequestTerminalNoEffectReference;
    };

type UnpublishedRequestResolutionChain =
  | Extract<RequestResolutionChain, { state: "unresolved" }>
  | {
      state: "central_committed";
      central: Extract<
        ExternalRequestResolutionReceipt,
        { kind: "cancelled"; reason: "request_owner" | "user" }
      >;
      runner: null;
      engineApplication: null;
    }
  | {
      state: "runner_recorded";
      central: Extract<
        ExternalRequestResolutionReceipt,
        { kind: "cancelled"; reason: "request_owner" | "user" }
      >;
      runner: Extract<RunnerRequestResolutionReceipt, { kind: "input_request_cancelled" }>;
      engineApplication: null;
    }
  | {
      state: "applied";
      central: Extract<
        ExternalRequestResolutionReceipt,
        { kind: "cancelled"; reason: "request_owner" | "user" }
      >;
      runner: Extract<RunnerRequestResolutionReceipt, { kind: "input_request_cancelled" }>;
      engineApplication: Extract<
        EngineRequestApplicationReceipt,
        { kind: "engine_applied_request_cancellation" }
      >;
    };

type ExternalRequestOperationReceipts =
  | {
      stage: "prepared";
      journal: null;
      registration: null;
      publication: null;
      resolution: Extract<RequestResolutionChain, { state: "unresolved" }>;
    }
  | {
      stage: "journaled";
      journal: RequestJournalReceipt;
      registration: null;
      publication: null;
      resolution: Extract<RequestResolutionChain, { state: "unresolved" }>;
    }
  | {
      stage: "registered";
      journal: RequestJournalReceipt;
      registration: RequestRegistrationReceipt;
      publication: null;
      resolution: UnpublishedRequestResolutionChain;
    }
  | {
      stage: "published";
      journal: RequestJournalReceipt;
      registration: RequestRegistrationReceipt;
      publication: RequestPublicationReceipt;
      resolution: RequestResolutionChain;
    };

interface ExternalRequestPublicationOperation {
  kind: "external_request_publication";
  operationId: string;
  idempotencyKey: string;
  payloadHash: string;
  payload: {
    requestId: ExternalRequestId;
    lineageId: ExecutionLineageId;
    authorityExecutionId: ExecutionId;
    authorityEpoch: number;
    semanticEventId: string;
  };
  claim: OperationClaim;
  receipts: ExternalRequestOperationReceipts;
}

type AssignmentDispositionWriter =
  | { kind: "attached_runner"; attachmentEpoch: AttachmentEpoch }
  | {
      kind: "certified_recovery";
      continuityCertificateId: string;
      assignmentCapabilityEpoch: number;
    };

type RunnerDeliveryDispositionReceipt = OperationReceiptBase &
  (
    | {
        kind: "consumed";
        store: "runner_sqlite";
        assignmentId: string;
        assignmentCapabilityEpoch: number;
        writer: AssignmentDispositionWriter;
        runnerInputSequence: number;
        engineEffectAdmission: "granted";
      }
    | {
        kind: "cancelled";
        store: "runner_sqlite";
        assignmentId: string;
        assignmentCapabilityEpoch: number;
        writer: AssignmentDispositionWriter;
        cancelInvocationId: string;
        engineObservationCount: 0;
      }
    | {
        kind: "target_terminal_released";
        store: "runner_sqlite";
        assignmentId: string;
        assignmentCapabilityEpoch: number;
        writer: AssignmentDispositionWriter;
        targetTerminalReceiptId: string;
        engineObservationCount: 0;
      }
  );

type AssignmentRegistrationFenceProof =
  | {
      kind: "runner_closed_before_registration";
      slotReceiptId: string;
      assignmentId: string;
      operationId: string;
      assignmentCapabilityEpoch: number;
      closeEpoch: number;
    }
  | {
      kind: "exact_runner_absence_and_capability_revoked";
      absence: ExactProcessAbsenceReceipt;
      assignmentId: string;
      operationId: string;
      revokedThroughCapabilityEpoch: number;
      capabilityRevocationReceiptId: string;
    };

type DeliveryAssignmentResolutionReceipt = OperationReceiptBase &
  (
    | {
        kind: "consumed";
        store: "postgres";
        runnerDispositionReceiptId: string;
        headAdvanceReceiptId: string;
      }
    | {
        kind: "cancelled";
        store: "postgres";
        deliveryCancelIntentReceiptId: string;
        runnerDispositionReceiptId: string;
        headAdvanceReceiptId: string;
      }
    | {
        kind: "cancelled_before_registration";
        store: "postgres";
        deliveryCancelIntentReceiptId: string;
        registrationFence: AssignmentRegistrationFenceProof;
        headAdvanceReceiptId: string;
      }
    | {
        kind: "no_effect_before_registration";
        store: "postgres";
        reason: "already_resolved" | "execution_finished";
        registrationFence: AssignmentRegistrationFenceProof;
        headAdvanceReceiptId: string;
      }
    | {
        kind: "no_effect_after_runner_release";
        store: "postgres";
        reason: "already_resolved" | "execution_finished";
        runnerDispositionReceiptId: string;
        headAdvanceReceiptId: string;
      }
    | {
        kind: "released_for_rebind_before_registration";
        store: "postgres";
        targetTerminalReceiptId: string;
        registrationFence: AssignmentRegistrationFenceProof;
      }
    | {
        kind: "released_for_rebind_after_runner_release";
        store: "postgres";
        targetTerminalReceiptId: string;
        runnerDispositionReceiptId: string;
      }
  );

type AssignmentIntentReceipt = OperationReceiptBase & {
  kind: "assignment_prepared";
  store: "postgres";
  assignmentId: string;
  claimEpoch: number;
  assignmentCapabilityEpoch: number;
};

type RunnerInboxReceipt = OperationReceiptBase & {
  kind: "runner_inbox_registered";
  store: "runner_sqlite";
  assignmentId: string;
  claimEpoch: number;
  assignmentCapabilityEpoch: number;
};

type RunnerAssignmentDispositionSlot =
  | {
      state: "open";
      assignmentId: string;
      operationId: string;
      assignmentCapabilityEpoch: number;
      highestClaimEpoch: number;
    }
  | {
      state: "registered";
      assignmentId: string;
      operationId: string;
      assignmentCapabilityEpoch: number;
      highestClaimEpoch: number;
      inbox: RunnerInboxReceipt;
    }
  | {
      state: "closed_before_registration";
      assignmentId: string;
      operationId: string;
      assignmentCapabilityEpoch: number;
      highestClaimEpoch: number;
      proof: AssignmentRegistrationFenceProof;
    }
  | {
      state: "disposed";
      assignmentId: string;
      operationId: string;
      assignmentCapabilityEpoch: number;
      highestClaimEpoch: number;
      inbox: RunnerInboxReceipt;
      disposition: RunnerDeliveryDispositionReceipt;
    };

type DeliveryAssignmentOperationReceipts =
  | {
      stage: "prepared";
      intent: AssignmentIntentReceipt;
      runnerInbox: null;
      deliveryCancelIntent: DeliveryCancelIntentReceipt | null;
      runnerDisposition: null;
      centralResolution: null;
    }
  | {
      stage: "registered";
      intent: AssignmentIntentReceipt;
      runnerInbox: RunnerInboxReceipt;
      deliveryCancelIntent: DeliveryCancelIntentReceipt | null;
      runnerDisposition: null;
      centralResolution: null;
    }
  | {
      stage: "runner_consumed";
      intent: AssignmentIntentReceipt;
      runnerInbox: RunnerInboxReceipt;
      deliveryCancelIntent: DeliveryCancelIntentReceipt | null;
      runnerDisposition: Extract<RunnerDeliveryDispositionReceipt, { kind: "consumed" }>;
      centralResolution: null;
    }
  | {
      stage: "runner_cancelled";
      intent: AssignmentIntentReceipt;
      runnerInbox: RunnerInboxReceipt;
      deliveryCancelIntent: DeliveryCancelIntentReceipt;
      runnerDisposition: Extract<RunnerDeliveryDispositionReceipt, { kind: "cancelled" }>;
      centralResolution: null;
    }
  | {
      stage: "runner_target_terminal_released";
      intent: AssignmentIntentReceipt;
      runnerInbox: RunnerInboxReceipt;
      deliveryCancelIntent: DeliveryCancelIntentReceipt | null;
      runnerDisposition: Extract<
        RunnerDeliveryDispositionReceipt,
        { kind: "target_terminal_released" }
      >;
      centralResolution: null;
    }
  | {
      stage: "resolved_consumed";
      intent: AssignmentIntentReceipt;
      runnerInbox: RunnerInboxReceipt;
      deliveryCancelIntent: DeliveryCancelIntentReceipt | null;
      runnerDisposition: Extract<RunnerDeliveryDispositionReceipt, { kind: "consumed" }>;
      centralResolution: Extract<DeliveryAssignmentResolutionReceipt, { kind: "consumed" }>;
    }
  | {
      stage: "resolved_cancelled";
      intent: AssignmentIntentReceipt;
      runnerInbox: RunnerInboxReceipt;
      deliveryCancelIntent: DeliveryCancelIntentReceipt;
      runnerDisposition: Extract<RunnerDeliveryDispositionReceipt, { kind: "cancelled" }>;
      centralResolution: Extract<DeliveryAssignmentResolutionReceipt, { kind: "cancelled" }>;
    }
  | {
      stage: "resolved_cancelled_before_registration";
      intent: AssignmentIntentReceipt;
      runnerInbox: null;
      deliveryCancelIntent: DeliveryCancelIntentReceipt;
      runnerDisposition: null;
      centralResolution: Extract<
        DeliveryAssignmentResolutionReceipt,
        { kind: "cancelled_before_registration" }
      >;
    }
  | {
      stage: "resolved_no_effect_before_registration";
      intent: AssignmentIntentReceipt;
      runnerInbox: null;
      deliveryCancelIntent: null;
      runnerDisposition: null;
      centralResolution: Extract<
        DeliveryAssignmentResolutionReceipt,
        { kind: "no_effect_before_registration" }
      >;
    }
  | {
      stage: "resolved_rebind_before_registration";
      intent: AssignmentIntentReceipt;
      runnerInbox: null;
      deliveryCancelIntent: null;
      runnerDisposition: null;
      centralResolution: Extract<
        DeliveryAssignmentResolutionReceipt,
        { kind: "released_for_rebind_before_registration" }
      >;
    }
  | {
      stage: "resolved_target_terminal_release_without_cancel";
      intent: AssignmentIntentReceipt;
      runnerInbox: RunnerInboxReceipt;
      deliveryCancelIntent: null;
      runnerDisposition: Extract<
        RunnerDeliveryDispositionReceipt,
        { kind: "target_terminal_released" }
      >;
      centralResolution: Extract<
        DeliveryAssignmentResolutionReceipt,
        {
          kind: "no_effect_after_runner_release" | "released_for_rebind_after_runner_release";
        }
      >;
    }
  | {
      stage: "resolved_cancelled_after_target_terminal_release";
      intent: AssignmentIntentReceipt;
      runnerInbox: RunnerInboxReceipt;
      deliveryCancelIntent: DeliveryCancelIntentReceipt;
      runnerDisposition: Extract<
        RunnerDeliveryDispositionReceipt,
        { kind: "target_terminal_released" }
      >;
      centralResolution: Extract<DeliveryAssignmentResolutionReceipt, { kind: "cancelled" }>;
    };

interface DeliveryAssignmentOperation {
  kind: "delivery_assignment";
  operationId: string;
  idempotencyKey: string;
  payloadHash: string;
  payload: {
    assignmentId: string;
    deliveryId: DeliveryId;
    executionId: ExecutionId;
    ownershipGeneration: number;
    executionCommandId: ExecutionCommandId;
    assignmentCapabilityEpoch: number;
  };
  claim: OperationClaim;
  receipts: DeliveryAssignmentOperationReceipts;
}

type IdempotentOperation =
  | ExternalRequestPublicationOperation
  | DeliveryAssignmentOperation;

interface DeliveryAssignment {
  assignmentId: string;
  deliveryId: DeliveryId;
  assignmentOrdinal: number;
  operationId: string;
  executionId: ExecutionId;
  ownershipGeneration: number;
  executionCommandId: ExecutionCommandId;
  resolutionReceiptId: string | null;
}

type ExternalRequestKind =
  | { kind: "tool_approval"; approvalId: string; toolName: string }
  | { kind: "ask_user_question"; inputRequestId: string };

interface ExternalRequestRecord {
  requestId: ExternalRequestId;
  lineageId: ExecutionLineageId;
  authorityExecutionId: ExecutionId;
  authorityEpoch: number;
  request: ExternalRequestKind;
  semanticEventId: string;
  operationId: string;
  requestedAt: IsoDateTime;
  publicationReceiptId: string | null;
  resolutionReceiptId: string | null;
  runnerResolutionReceiptId: string | null;
  applicationProofId: string | null;
}

type InputApplicationResult =
  | {
      kind: "applied";
      deliveryId: DeliveryId;
    }
  | {
      kind: "already_applied";
      deliveryId: DeliveryId;
    }
  | {
      kind: "not_applied";
      deliveryId: DeliveryId;
      reason: "expired" | "cancelled" | "execution_finished";
    };

interface StopInvocation {
  lineageId: ExecutionLineageId;
  invocationId: string;
  reason: "user_stop" | "policy" | "stalled";
  requestedAt: IsoDateTime;
}

interface TerminationIntentReceipt {
  intentId: string;
  invocationId: string;
  lineageId: ExecutionLineageId;
  executionId: ExecutionId;
  ownershipGeneration: number;
  bindingEpoch: number;
  reason: "user_stop" | "policy" | "stalled";
  requestedAt: IsoDateTime;
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

type RunnerHostCallSequence = number & { readonly __brand: "RunnerHostCallSequence" };
type RunnerHostOperationId = string & { readonly __brand: "RunnerHostOperationId" };

interface RunnerHostCallKey {
  executionId: ExecutionId;
  executionCommandId: ExecutionCommandId;
  attachmentEpoch: AttachmentEpoch;
  hostCallSequence: RunnerHostCallSequence;
}

interface RunnerHostCallEnvelope<TCall> extends RunnerHostCallKey {
  kind: "runner_host_call";
  requestReceiptId: string;
  attachmentGrantId: string;
  operationId: RunnerHostOperationId;
  payloadHash: string;
  call: TCall;
}

interface RunnerHostResponseEnvelope<TResult> extends RunnerHostCallKey {
  kind: "runner_host_response";
  attachmentGrantId: string;
  operationId: RunnerHostOperationId;
  requestPayloadHash: string;
  requestReceiptId: string;
  resultHash: string;
  result: TResult;
}

type RunnerAttachmentJournalEntry =
  | {
      kind: "attachment_epoch_accepted";
      executionId: ExecutionId;
      executionCommandId: ExecutionCommandId;
      attachmentEpoch: AttachmentEpoch;
      attachmentGrantId: string;
      barrierReceiptId: string;
      committedAt: IsoDateTime;
    }
  | {
      kind: "attachment_epoch_revoked";
      executionId: ExecutionId;
      executionCommandId: ExecutionCommandId;
      attachmentEpoch: AttachmentEpoch;
      attachmentGrantId: string;
      revocationReceiptId: string;
      committedAt: IsoDateTime;
    };

interface RunnerAttachmentJournal {
  executionId: ExecutionId;
  executionCommandId: ExecutionCommandId;
  entries: ReadonlyArray<RunnerAttachmentJournalEntry>;
}

interface RunnerCurrentAttachment {
  executionId: ExecutionId;
  executionCommandId: ExecutionCommandId;
  attachmentEpoch: AttachmentEpoch;
  attachmentGrantId: string;
  acceptedReceiptId: string;
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
  hostCallHighWatermark: RunnerHostCallSequence;
  committedAt: IsoDateTime;
}

interface LegacyDetachBarrierReceipt {
  receiptId: string;
  executionId: ExecutionId;
  executionCommandId: ExecutionCommandId;
  oldHostInstanceId: string;
  oldWriterLeaseId: string;
  acceptedThrough: RunnerCommandSequence;
  settledThrough: RunnerCommandSequence;
  inputHighWatermark: number;
  outboxHighWatermark: number;
  hostCallHighWatermark: RunnerHostCallSequence;
  commandDispositions: ReadonlyArray<RunnerCommandHandoffDisposition>;
  outstandingUnaccountedCommands: 0;
  oldWriterRevocationReceiptId: string;
  oldSocketCloseReceiptId: string;
  committedAt: IsoDateTime;
}

type PromotionHandoffFence =
  | {
      kind: "runner_epoch";
      receiptId: string;
      preparedGrant: PreparedAttachmentGrant;
      attachmentBarrier: RunnerAttachmentBarrierReceipt;
    }
  | {
      kind: "legacy_detach";
      receiptId: string;
      detachBarrier: LegacyDetachBarrierReceipt;
      v2PreparedGrant: PreparedAttachmentGrant;
    };

interface RetainedBackgroundTask {
  taskId: string;
  kind: "claude_background_tool" | "backend_background_operation";
  journalHighWatermark: number;
  effectOperationIds: ReadonlyArray<string>;
}

interface ExecutionRetentionReleaseReceipt {
  receiptId: string;
  retentionId: ExecutionRetentionId;
  authorityEpoch: number;
  ownerInstanceId: string;
  allTasksTerminalReceiptId: string;
  effectFenceReceiptId: string;
  resourceAbsenceReceiptId: string;
  releasedAt: IsoDateTime;
}

interface ExecutionRetention {
  retentionId: ExecutionRetentionId;
  sourceExecutionId: ExecutionId;
  sourceExecutionCommandId: ExecutionCommandId;
  ownerInstanceId: string;
  authorityEpoch: number;
  leaseExpiresAt: IsoDateTime;
  attachmentGrantId: string;
  writerLeaseId: string;
  eventRoute: {
    routeId: string;
    ingressStreamId: string;
    authorityEpoch: number;
  };
  backgroundTasks: ReadonlyArray<RetainedBackgroundTask>;
  authorityTransferReceiptId: string;
  cleanupObligationId: string;
  release: ExecutionRetentionReleaseReceipt | null;
}

type ExecutionProgressKind = "assistant_message" | "thinking" | "tool_result";

interface ExecutionProgress {
  lastSemantic:
    | { state: "not_observed"; leaseStartedAt: IsoDateTime }
    | {
        state: "observed";
        sequence: number;
        kind: ExecutionProgressKind;
        progressedAt: IsoDateTime;
      };
  progressLeaseExpiresAt: IsoDateTime;
  inFlightTools: ReadonlyArray<{
    toolUseId: string;
    startedAt: IsoDateTime;
    absoluteLeaseExpiresAt: IsoDateTime;
  }>;
}

type DurableEffectReceipt =
  | { operationId: string; state: "not_started"; receiptId: null }
  | {
      operationId: string;
      state: "committed";
      receiptId: string;
      atomicity:
        | { kind: "same_transaction"; transactionReceiptId: string }
        | {
            kind: "external_idempotency_lookup";
            providerOperationKey: string;
            lookupReceiptId: string;
          };
    }
  | {
      operationId: string;
      state: "compensated";
      receiptId: string;
      compensationOperationId: string;
    };

declare const executionContinuityCertificate: unique symbol;

interface ExecutionContinuityCertificate {
  readonly [executionContinuityCertificate]: true;
  certificateId: string;
  predecessorExecutionId: ExecutionId;
  predecessorCommandId: ExecutionCommandId;
  backend: "claude" | "codex_cli" | "codex_app_server" | "agents";
  continuityContractVersion: number;
  committedBoundarySequence: number;
  effectInventoryHash: string;
  engineCheckpoint: {
    resumeToken: string;
    committedEngineBoundary: number;
  };
  runnerInputConsumedThrough: number;
  runnerOutboxCommittedThrough: number;
  hostCallsSettledThrough: number;
  effects: ReadonlyArray<DurableEffectReceipt>;
  pendingExternalRequestIds: ReadonlyArray<ExternalRequestId>;
  deliveryHeadId: DeliveryId | null;
  issuedAt: IsoDateTime;
}

type ExecutionRecoveryProjection =
  | {
      kind: "attachment_missing";
      attempt: RunnerAttempt;
      lastLease: AttachmentGrant | null;
      evidence: { kind: "runner_alive"; registrationId: string };
      action: "attach_or_takeover";
    }
  | {
      kind: "identity_unresolved";
      attempt: RunnerAttempt;
      evidence: {
        kind: "registration_absent" | "registration_incomplete";
        observations: number;
      };
      action: "resolve_identity";
    }
  | {
      kind: "process_absent";
      attempt: RunnerAttempt;
      evidence: ExactProcessAbsenceReceipt;
      continuity: ExecutionContinuityCertificate;
      action: "replace_from_certificate";
    }
  | {
      kind: "continuity_invariant_breach";
      attempt: RunnerAttempt;
      evidence: ExactProcessAbsenceReceipt;
      missingBoundaryReceiptIds: ReadonlyArray<string>;
      incidentId: string;
      action: "hold_open_and_alert";
    };

type InternalTerminalDiagnostic =
  | { kind: "none" }
  | {
      kind: "failure";
      code: string;
      detailRef: string;
      incidentId: string;
    };

interface PublicOutcome {
  category: "completed" | "failed" | "stopped";
  safeMessage: string;
  incidentId: string | null;
  retrySafety: "not_needed" | "safe_same_delivery_id" | "unsafe";
}

interface RunnerTerminalWitness {
  kind: "runner";
  witnessId: string;
  executionId: ExecutionId;
  executionCommandId: ExecutionCommandId;
  lifecycleSequence: number;
  outboxHighWatermark: number;
  deliveryAdmissionCutoffSequence: bigint;
  publicOutcome: PublicOutcome;
  internalDiagnostic: InternalTerminalDiagnostic;
  durableAt: IsoDateTime;
}

interface PreactivationTerminalWitness {
  kind: "preactivation";
  witnessId: string;
  executionId: ExecutionId;
  attemptId: SpawnAttemptId;
  absence: PhysicalAbsenceReceipt;
  outboxHighWatermark: 0;
  deliveryAdmissionCutoffSequence: bigint;
  publicOutcome: PublicOutcome;
  internalDiagnostic: InternalTerminalDiagnostic;
  durableAt: IsoDateTime;
}

type ExecutionTerminalWitness =
  | RunnerTerminalWitness
  | PreactivationTerminalWitness;

interface TerminalIngressReceipt {
  witnessId: string;
  executionId: ExecutionId;
  receivedThroughOutboxSequence: number;
  basis: "event_ingress" | "no_runner_output";
  committedAt: IsoDateTime;
}

type EffectFenceReceipt =
  | {
      kind: "never_acquired";
      resource: "attachment" | "writer" | "attempt_child" | "retention";
      receiptId: string;
    }
  | {
      kind: "attachment_epoch_fenced";
      grantId: string;
      fencedThroughEpoch: AttachmentEpoch;
      databaseRevocationReceiptId: string;
      runnerReceiptId: string;
    }
  | {
      kind: "writer_lease_fenced";
      writerLeaseId: string;
      fencedThroughEpoch: number;
      databaseRevocationReceiptId: string;
    }
  | {
      kind: "attempt_capability_fenced";
      attemptId: SpawnAttemptId;
      capabilityEpoch: number;
      capabilityRevocationReceiptId: string;
      canonicalJoin: "excluded";
    }
  | {
      kind: "authority_transferred";
      resource: "attachment" | "writer" | "retention";
      resourceId: string;
      oldAuthorityRevocationReceiptId: string;
      transferReceiptId: string;
      newAuthorityId: string;
      newAuthorityEpoch: number;
    }
  | { kind: "process_absent"; receipt: ExactProcessAbsenceReceipt };

type AttachmentSafetyReceipt =
  | {
      disposition: "released";
      proof: Extract<EffectFenceReceipt, { kind: "never_acquired" }> & {
        resource: "attachment";
      };
      physicalReleaseReceiptId: null;
      cleanupObligationId: null;
    }
  | {
      disposition: "released";
      proof: Extract<EffectFenceReceipt, { kind: "attachment_epoch_fenced" }>;
      physicalReleaseReceiptId: string;
      cleanupObligationId: null;
    }
  | {
      disposition: "retained";
      proof: Extract<EffectFenceReceipt, { kind: "attachment_epoch_fenced" }>;
      physicalReleaseReceiptId: null;
      cleanupObligationId: string;
    }
  | {
      disposition: "transferred";
      proof: Extract<EffectFenceReceipt, { kind: "authority_transferred" }> & {
        resource: "attachment";
      };
      physicalReleaseReceiptId: null;
      cleanupObligationId: string;
    };

type WriterSafetyReceipt =
  | {
      disposition: "released";
      proof: Extract<EffectFenceReceipt, { kind: "never_acquired" }> & {
        resource: "writer";
      };
      physicalReleaseReceiptId: null;
      cleanupObligationId: null;
    }
  | {
      disposition: "released";
      proof: Extract<EffectFenceReceipt, { kind: "writer_lease_fenced" }>;
      physicalReleaseReceiptId: string;
      cleanupObligationId: null;
    }
  | {
      disposition: "retained";
      proof: Extract<EffectFenceReceipt, { kind: "writer_lease_fenced" }>;
      physicalReleaseReceiptId: null;
      cleanupObligationId: string;
    }
  | {
      disposition: "transferred";
      proof: Extract<EffectFenceReceipt, { kind: "authority_transferred" }> & {
        resource: "writer";
      };
      physicalReleaseReceiptId: null;
      cleanupObligationId: string;
    };

type ChildOrRetentionSafetyReceipt =
  | {
      disposition: "released";
      proof:
        | (Extract<EffectFenceReceipt, { kind: "never_acquired" }> & {
            resource: "attempt_child" | "retention";
          })
        | Extract<EffectFenceReceipt, { kind: "process_absent" }>;
      cleanupObligationId: null;
    }
  | {
      disposition: "retained";
      proof: Extract<EffectFenceReceipt, { kind: "attempt_capability_fenced" }>;
      cleanupObligationId: string;
    }
  | {
      disposition: "transferred";
      proof: Extract<EffectFenceReceipt, { kind: "authority_transferred" }> & {
        resource: "retention";
        newAuthorityId: ExecutionRetentionId;
      };
      cleanupObligationId: string;
    };

declare const terminalSafetyBarrier: unique symbol;

interface TerminalSafetyBarrier {
  readonly [terminalSafetyBarrier]: true;
  executionId: ExecutionId;
  witnessId: string;
  boundDeliverySettlementReceiptIds: ReadonlyArray<string>;
  externalRequestResolutionReceiptIds: ReadonlyArray<string>;
  streamSettledReceiptId: string;
  hostCallsSettledReceiptId: string;
  attachment: AttachmentSafetyReceipt;
  writer: WriterSafetyReceipt;
  childOrRetention: ChildOrRetentionSafetyReceipt;
  committedAt: IsoDateTime;
}

interface ExecutionTerminalRecord {
  key: ExecutionKey;
  terminationIntentId: string | null;
  witness: ExecutionTerminalWitness;
  ingress: TerminalIngressReceipt;
  safetyBarrier: TerminalSafetyBarrier;
  visibleAt: IsoDateTime;
}

interface ExternalRequestAuthorityTransfer {
  requestId: ExternalRequestId;
  lineageId: ExecutionLineageId;
  fromExecutionId: ExecutionId;
  toExecutionId: ExecutionId;
  fromAuthorityEpoch: number;
  toAuthorityEpoch: number;
  publicationOperationId: string;
  pendingResponseDeliveryIds: ReadonlyArray<DeliveryId>;
  transferReceiptId: string;
}

interface ExecutionSupersessionRecord {
  key: ExecutionKey;
  continuityCertificateId: string;
  successorExecutionId: ExecutionId;
  inputConsumedThrough: number;
  outboxCommittedThrough: number;
  hostCallsSettledThrough: number;
  effectInventoryHash: string;
  requestAuthorityTransfers: ReadonlyArray<ExternalRequestAuthorityTransfer>;
  oldAuthorityFenceReceiptIds: ReadonlyArray<string>;
  transferredAt: IsoDateTime;
  publicProjection: "lineage_only";
}

interface OpenLogicalExecution {
  state: "open";
  key: ExecutionKey;
  reservation: ExecutionReservationReceipt;
  currentAttemptId: SpawnAttemptId | null;
  attachment: AttachmentGrant | null;
  terminationIntentId: string | null;
  terminalWitness: ExecutionTerminalWitness | null;
  terminalIngress: TerminalIngressReceipt | null;
  terminalSafetyBarrier: TerminalSafetyBarrier | null;
  progress: ExecutionProgress | null;
  reconcileDueAt: IsoDateTime;
}

type TerminalLogicalExecution =
  | {
      state: "terminal";
      kind: "visible";
      record: ExecutionTerminalRecord;
    }
  | {
      state: "terminal";
      kind: "continuity_transfer";
      record: ExecutionSupersessionRecord;
    }
  | {
      state: "terminal";
      kind: "migration_archival";
      record: {
        key: ExecutionKey;
        supersededByExecutionId: ExecutionId;
        proofReceiptId: string;
        effectFenceReceiptIds: ReadonlyArray<string>;
        archivedAt: IsoDateTime;
        publicProjection: "forbidden";
      };
    };

type LogicalExecution = OpenLogicalExecution | TerminalLogicalExecution;

interface TaskExecutionProjection {
  logical:
    | { state: "idle" }
    | { state: "open"; execution: OpenLogicalExecution }
    | { state: "terminal"; execution: TerminalLogicalExecution };
  launch:
    | { state: "none" }
    | { state: "reserved"; attempt: RunnerAttempt }
    | { state: "provisional"; attempt: RunnerAttempt }
    | { state: "activating"; attempt: RunnerAttempt }
    | { state: "active"; attempt: RunnerAttempt; progress: ExecutionProgress | null };
  externalInput: {
    waitingForUserRequestIds: ReadonlyArray<ExternalRequestId>;
    applyingResponseRequestIds: ReadonlyArray<ExternalRequestId>;
    progressReaping: "running" | "suspended";
  };
  attachment:
    | { state: "not_applicable" }
    | { state: "attached"; grant: AttachmentGrant }
    | { state: "recovering"; recovery: ExecutionRecoveryProjection };
  retention:
    | { state: "none" }
    | { state: "active"; authority: ExecutionRetention };
  settlement:
    | { state: "none" }
    | {
      state: "settling";
        witness: ExecutionTerminalWitness | null;
        ingress: TerminalIngressReceipt | null;
        barrier: TerminalSafetyBarrier | null;
      }
    | { state: "finished"; record: ExecutionTerminalRecord };
}

type PublicExecutionAxis =
  | { state: "idle" }
  | {
      state: "open";
      activity: "not_running" | "running";
      externalInput: {
        waitingForYouRequestIds: ReadonlyArray<ExternalRequestId>;
        applyingResponseRequestIds: ReadonlyArray<ExternalRequestId>;
      };
      settlement: "none" | "settling";
    }
  | {
      state: "finished";
      outcome: PublicOutcome;
    };

type PublicDeliveryState =
  | "received"
  | "consumed"
  | "cancel_requested"
  | "cancelled"
  | "no_effect";

interface PublicDeliveryProjection {
  deliveryId: DeliveryId;
  state: PublicDeliveryState;
  application: InputApplicationResult | null;
}

type PublicAvailability =
  | { state: "normal" }
  | { state: "delayed"; incidentId: string | null }
  | {
      state: "blocked";
      reason: "continuity_guarantee_unproven";
      incidentId: string;
      automaticProgress: false;
      availableActions: readonly ["wait_for_manual_recovery", "contact_support"];
    };

interface PublicControls {
  stop:
    | { state: "available" }
    | { state: "requested"; intentId: string }
    | {
        state: "unavailable";
        reason: "idle" | "finished" | "continuity_guarantee_unproven";
      };
  cancellableDeliveryIds: ReadonlyArray<DeliveryId>;
}

interface PublicSessionProjection {
  lineageId: ExecutionLineageId;
  execution: PublicExecutionAxis;
  deliveries: ReadonlyArray<PublicDeliveryProjection>;
  availability: PublicAvailability;
  controls: PublicControls;
}

interface TaskExecutionController {
  readonly logical: LogicalExecution | null;
  readonly current: TaskExecutionProjection;
  readonly publicState: PublicSessionProjection;
  reserve(input: ExecutionReservationReceipt): Promise<void>;
  recordSpawn(receipt: SpawnedChildReceipt): Promise<void>;
  recordOwnershipProof(
    attemptId: SpawnAttemptId,
    receipt: { receiptId: string; committedAt: IsoDateTime },
  ): Promise<void>;
  recordActivation(
    attemptId: SpawnAttemptId,
    receipt: { receiptId: string; committedAt: IsoDateTime },
  ): Promise<void>;
  commitPromotionHandoff(fence: PromotionHandoffFence): Promise<void>;
  commitAttachment(grant: AttachmentGrant): Promise<void>;
  transferRetention(authority: ExecutionRetention): Promise<void>;
  admitDelivery(delivery: DeliveryRecord): Promise<void>;
  requestStop(invocation: StopInvocation): Promise<TerminationIntentReceipt>;
  recordTerminalWitness(witness: ExecutionTerminalWitness): Promise<void>;
  recordTerminalIngress(receipt: TerminalIngressReceipt): Promise<void>;
  commitTerminalSafety(barrier: TerminalSafetyBarrier): Promise<void>;
  commitVisibleTerminal(executionId: ExecutionId): Promise<ExecutionTerminalRecord>;
  commitContinuityTransfer(
    predecessor: ExecutionSupersessionRecord,
    successor: ExecutionReservationReceipt,
  ): Promise<void>;
}

interface Task {
  readonly execution: TaskExecutionController;
}
~~~

`LogicalExecution`의 writable 상태는 `open | terminal` 둘뿐이다. launch, external input, attachment, settlement는 서로 독립인 읽기 축이다. 공개된 미응답 request, 이미 접수되어 runner 적용을 기다리는 response, attachment 상실은 동시에 참일 수 있으므로 `externalInput.waitingForUserRequestIds`, `externalInput.applyingResponseRequestIds`, `attachment.recovering`을 각각 계산한다. terminal/stop 정산만 `settlement.settling`이고 response 적용 대기는 settlement로 위장하지 않는다. terminal witness가 있으면 `settlement.settling`, visible terminal 뒤에는 `logical.terminal + settlement.finished`가 계산된다.

`reserved/provisional/activating/active`는 `RunnerAttempt`의 reservation·spawn·ownership·activation receipt 조합에서 계산한다. 어느 projection도 별도 writer·CAS·DB 컬럼을 갖지 않는다. 하나의 declarative `execution_semantics.v2` schema가 internal/public projection, coupled recovery/operation 타입, SQL regular projection/invariant function과 transition fixture를 생성한다. 구현자가 projection이나 operation receipt를 추가할 때 타입·DB CHECK·테스트를 손으로 따로 수정하는 경로는 없다.

생성 경로는 구현 단위 1에서 다음으로 고정한다.

1. 손으로 쓰는 유일한 정본: `packages/execution-semantics/src/execution_semantics_v2.schema.ts`
2. 생성기: `packages/execution-semantics/scripts/generate.ts`
3. TypeScript 산출물: `packages/execution-semantics/generated/typescript/execution_semantics_v2.ts` — `TaskExecutionProjection`, coupled `ExecutionRecoveryProjection`, orthogonal `PublicSessionProjection`, kind별 coupled `IdempotentOperation`, delivery cancel·lineage stop·request authority transfer, `ExecutionRetention`, exhaustive reducer
4. runner wire/slot 산출물: `packages/execution-semantics/generated/typescript/runner_host_wire_v2.ts`, `packages/execution-semantics/generated/sqlite/runner_host_wire_v2.sql`, `packages/execution-semantics/generated/sqlite/runner_assignment_disposition_v2.sql` — call/response envelope, append-only `RunnerAttachmentJournal`, current-attachment projection, call identity PK·operation unique·payload hash/epoch trigger, assignment별 `RunnerAssignmentDispositionSlot`과 registration capability/claim fence. `frame_protocol.ts`와 runner SQLite는 이 생성물만 import/apply하고 같은 schema를 다시 선언하지 않는다.
5. SQL 산출물: `packages/db-schema/sql/generated/execution_semantics_v2.sql` — view predicate와 procedure가 호출하는 invariant function
6. 전이 산출물: `packages/execution-semantics/generated/fixtures/execution_semantics_v2.transitions.json` — receipt 조합과 projection/action 기대값

CI는 `pnpm --dir packages/execution-semantics generate` 뒤 모든 generated 경로의 `git diff --exit-code`와 transition/wire fixture consumer test를 실행한다. `soul-server-ts`는 generated TypeScript를 import하고 `ExecutionRecoveryProjection`이나 runner↔host envelope를 다시 선언하지 않는다. 생성 전후 diff가 있거나 SQL·wire·fixture 중 하나가 빠지면 merge를 막는다.

시간은 fact가 아니라 reducer 입력이다. 생성된 API는 `reduceExecutionSemantics(facts, observedAt)`이고 attachment TTL·due 여부를 transaction snapshot의 `observedAt`으로 계산한다. DB write 권위 판단은 `STABLE` SQL function 또는 regular view가 같은 transaction의 `statement_timestamp()`을 명시적으로 넘겨 수행한다. materialized projection은 대시보드 관측·비교용일 뿐 reserve, takeover, terminal, capability 판정의 권위가 아니다.

`RunnerAttempt`가 물리 lifecycle 정본이다. 별도 attempt phase·process permit row·cleanup job phase는 없다. attempt row가 만들어진 순간부터 `physicalAbsenceReceipt === null`인 동안 node process capacity를 점유하고, `isolationReceipt !== null && physicalAbsenceReceipt === null`이면 orphan quota도 점유한다. spawn 전에 취소된 attempt도 `not_launched` receipt가 생기기 전에는 capacity를 반납하지 않는다. cleanup worker의 claim epoch·lease·wake는 attempt가 참조하는 단일 `CleanupObligation`에만 있다. stable launch operation은 DB authorization과 OS spawn을 묶어 물리 child를 최대 하나만 만들며, claim expiry 뒤 늦은 launcher가 새 child를 만들 수 없는 primitive를 구현 단계에서 선택해야 한다.

`CleanupObligation`만 물리 회수 권한의 정본이다. attempt, terminal receipt, retention, post-terminal maintenance는 obligation id만 참조한다. 같은 exact child는 하나의 active obligation만 가질 수 있고, terminal procedure는 기존 preterminal obligation을 참조해야 하며 새 child obligation을 만들 수 없다. `TerminalSafetyBarrier`는 물리 삭제가 아니라 “더는 사용자-visible effect를 만들 수 없음”을 증명한다. 살아 있는 fenced child는 `retained + cleanupObligationId`, retention/attachment/writer의 authority handoff는 typed `transferred + new authority/epoch + cleanupObligationId`로 표현한다. child/retention의 `released`는 `never_acquired/process_absent`만 허용되고 attachment/writer의 fenced `released`는 별도 physical release receipt를 함께 요구한다.

`ExecutionRetention`은 cleanup의 두 번째 owner가 아니다. terminal 이후에도 semantic event를 만들 수 있는 background runtime의 **현재 권한 정본**이고, `CleanupObligation`은 그 물리 자원을 언젠가 회수할 책임만 가진다. source execution당 `release === null` retention은 하나이고 `(retentionId, authorityEpoch)` 하나만 lease renew, background task effect, semantic event route를 사용할 수 있다. transfer receipt가 old attachment/writer epoch를 revoke하고 이 current retention row를 만든 뒤에만 terminal safety의 `transferred(resource=retention)`이 성립한다. retention이 참조하는 cleanup obligation은 물리 종료 전까지 그대로 한 개다.

runner↔host call의 immutable identity key는 `(executionId, executionCommandId, attachmentEpoch, hostCallSequence)`다. `operationId`, `payloadHash`, canonical payload와 `attachmentGrantId`는 key가 아니라 그 row의 값이다. runner는 wire frame을 내보내기 **전에** generated procedure로 sequence를 할당하고 canonical call row를 commit하며, envelope는 그 `requestReceiptId`를 싣는다. 따라서 수신된 변조 frame이 canonical row보다 먼저 effect admission에 도달하는 경로가 없다. call table PK는 sequence가 operation/hash/payload를 함수적으로 고정하고, `UNIQUE(operationId)`는 같은 stable effect operation을 다른 sequence로 재사용하지 못하게 한다. insert procedure가 canonical payload hash를 계산하므로 caller가 hash만 맞바꿀 수도 없다. receiver는 receipt row를 먼저 읽어 envelope의 key·operation·hash·grant·payload를 전부 대조하며, 부재나 불일치는 effect 전에 거부한다. direct call DML과 receipt 없는 host effect entrypoint는 revoke한다.

`RunnerAttachmentJournal`은 runner-local accepted attachment epoch의 durable owner다. grant accept와 revoke를 append-only receipt로 기록하고 generated `RunnerCurrentAttachment` regular projection이 “가장 높은 accepted이고 revoke되지 않은 exact grant” 하나를 계산한다. call row는 `(executionId, executionCommandId, attachmentEpoch, attachmentGrantId)`로 accepted journal receipt를 참조한다. call insert와 effect admission trigger는 같은 SQLite transaction에서 current projection과 exact 일치를 재검사한다. higher epoch/revoke 뒤 늦은 call은 row/effect를 만들 수 없다. response는 call identity PK를 FK로 참조하고 operation id·request payload hash·grant가 call row와 같아야 하며, 이전 epoch request에 대한 늦은 response도 stale no-effect다. socket identity나 전체 tuple UNIQUE는 이 fence를 대신하지 않는다.

external request의 300초 deadline은 publication transaction이 operation-owned publication receipt에 고정한 immutable `expiresAt = publishedAt + 300초`다. runner가 요청을 journal에 쓴 시각이 아니라 사용자가 실제로 볼 수 있게 된 시각부터 센다. response admission은 request row, current request-authority epoch, 현재 lineage execution의 terminal prefix를 함께 잠근다. `db_now <= expiresAt`이고 witness가 없을 때만 `responded` winner와 request-scoped delivery를 한 transaction에 commit한다. witness가 먼저면 `cancelled(reason=execution_finished)`와 public `not_applied(execution_finished)`가 이기고 delivery를 만들지 않는다. response가 먼저면 뒤따른 witness는 기록할 수 있어도 그 exact delivery consumption/application이 끝날 때까지 terminal safety barrier가 닫힌다. `db_now > expiresAt`이고 winner가 비어 있으면 response transaction 자신이 `expired` winner를 commit한다. expiry worker 시각과 recovery 지연은 결과에 관여하지 않는다.

request response의 semantic application owner는 delivery assignment consumption chain 하나다. `responded` request operation은 별도 response engine receipt를 만들지 않고 exact consumed assignment composite FK를 참조한다. expiry와 user/owner cancellation은 request operation이 runner journal의 `input_request_expired|input_request_cancelled`와 engine controller application receipt를 소유한다. terminal witness가 먼저인 `execution_finished`는 engine이 더는 wait하지 않는다는 exact witness FK가 no-effect application proof이며 runner application을 요구하지 않는다. request row는 어느 경우든 owner receipt id만 참조하고 내용을 복제하지 않는다. public reducer는 responded 뒤 composite consumption 전을 `applyingResponseRequestIds`로 표시하고 terminal barrier는 각 kind의 exact proof까지 기다린다.

`DeliveryScope`는 재해석 범위를 고정한다. `session` delivery만 다음 유효 execution으로 넘어갈 수 있다. `execution` scope는 exact execution/generation에만, `request` scope는 stable request id와 current authority epoch에만 적용된다. certified replacement는 request row의 authority epoch를 올리는 typed transfer를 함께 commit하므로 공개된 질문은 재게시 없이 successor에 남고 새 response는 current epoch에 bind된다. 닫힌 request는 canonical `no_effect/not_applied`로 끝나며 다음 turn 입력으로 바뀌지 않는다.

assignment마다 runner-local `RunnerAssignmentDispositionSlot` 하나가 registration과 final disposition의 authority다. registration RPC는 operation id, claim epoch, assignment capability epoch를 싣는다. pre-registration 종료는 runner가 slot에 `closed_before_registration`을 commit한 ack 또는 exact process absence와 해당 capability epoch revoke를 묶은 typed proof만 허용한다. absence branch 뒤 새/recovered runner는 registration endpoint를 열기 전에 중앙 revoke watermark를 local close tombstone으로 동기화한다. 따라서 이미 전송됐던 낮은 epoch RPC도 SQLite insert 자체가 실패한다. inbox insert 뒤 process가 죽으면 complete continuity certificate를 가진 higher capability recovery writer만 같은 slot의 `consumed|cancelled|target_terminal_released`를 확정할 수 있다. 중앙 before-registration variant 셋은 이 fence proof와 delivery-level cancel intent의 exact 조합만 mirror한다. 등록 뒤 local cancel winner는 central `cancelled`만, target-terminal release winner는 scope에 따라 no-effect 또는 rebind만 허용한다.

stop은 delivery나 FIFO 입력이 아니다. invocation은 stable `ExecutionLineageId`를 대상으로 하고 lineage control row가 intent와 current binding의 유일한 owner다. `session_request_stop_v2`와 continuity transfer는 같은 lineage row와 current open execution을 잠근다. stop이 먼저면 current execution에 bind하고, transfer가 먼저면 successor에 bind하며, transfer 중 아직 witness가 없는 pending invocation은 binding epoch를 올려 successor로 원자 이동한다. stop witness가 먼저면 continuity transfer는 거부되고 terminal pipeline이 이긴다. 어느 interleaving에서도 invocation 하나는 predecessor 또는 successor 정확히 한 곳에만 붙는다. ACK는 언제나 canonical `stop_requested`이고 반복·late call은 같은 lineage invocation receipt를 재조회한다. 사용자-visible `stopped`는 bound execution의 witness, barrier, visible terminal 뒤에만 나온다.

`IdempotentOperation`은 kind별 payload, cross-store 단계 receipt, monotonic claim epoch, lease, next wake의 단일 owner다. external request와 append-only delivery assignment row는 operation id와 receipt FK만 참조하며 receipt 내용을 복사하지 않는다. request response application은 assignment consumption composite FK 하나, expiry/cancel application은 request operation receipt 하나만 owner다. delivery cancel intent와 winner는 stable delivery row에 있고 assignment는 그 intent FK만 읽는다. generated schema는 request receipt에 runner SQLite→Postgres→event ingress 순서만, assignment receipt에 Postgres→runner disposition slot→Postgres resolution 순서만 허용한다. wrong-store·wrong-stage·다른 operation receipt 결합은 타입과 composite FK가 함께 거부한다.

`ExecutionRecoveryProjection`은 context·method·evidence·handle을 독립 필드로 조합하지 않는다. 각 variant가 유효한 evidence와 유일한 action을 함께 가진다. `continuity_invariant_breach`는 정상적인 장기 recovery 상태가 아니다. v2 runner는 모든 engine/tool effect boundary에서 다음 boundary로 넘어가기 전에 certificate를 durable하게 갱신해야 한다. 죽은 process 뒤 certificate가 빠졌다면 replacement·새 context 실행을 금지하고 execution activity `not_running`과 availability `blocked`를 투영한다. 이 경우 완전 투명성 보장은 깨졌다고 명시하며, `running`이나 자동 failed/stopped를 만들어 숨기지 않는다.

기존 12개 optional 필드는 삭제된다. runner·ownership·reservation은 `RunnerAttempt`와 attachment lease receipt로, terminal fact는 witness·ingress·barrier로, pending terminal id는 ingress watermark로, interrupt는 execution-scoped delivery 또는 stop intent로 이동한다. activation/terminal promise와 request lifetime controller는 durable fact를 구독하는 in-memory waiter projection일 뿐 Task의 정본 필드가 아니다.

### 실행 identity의 단위

`executionId`는 **모델의 한 turn이 아니라 현재 `execute` command가 감싸는 multi-turn loop 전체**의 identity다. 한 실행 안에서 최초 prompt, intervention, AskUserQuestion 응답, tool approval 응답이 차례로 여러 model turn을 만들 수 있다.

```text
session 1
  → executionLineageId 1              public 실행 계보. replacement도 보존
    → executionId N                   물리 연속성이 증명되는 실행 수명. replacement는 새 ID
      → executionCommandId 1          runner execute command. provisional spawn에서 확정
        → runnerInputSequence N       최초 입력·개입·응답마다 단조 증가
          → provider/model turn N     내부 구현 단위, execution identity가 아님
```

정상·pure adopt·attachment takeover는 `executionId`와 `executionCommandId`를 모두 보존한다. runner process가 사라진 경우에는 complete continuity certificate가 있을 때만 predecessor를 증명·정산하고 같은 `executionLineageId` 아래 새 execution/command를 만든다. checkpoint-resume이나 effect receipt가 없으면 replacement하지 않는다. public stop은 lineage, delivery cancel은 delivery, response는 request를 대상으로 하며, binder만 순간 execution/assignment에 연결한다. `deliveryId` 하나는 정확히 한 `runnerInputSequence` consumption receipt와 결합하고 provider model turn에는 직접 bind하지 않는다.

## 정본 mutation과 projection

상태 전이는 phase 문자열의 교체가 아니라 receipt의 단조 추가다. 다음 표의 mutation만 writable하다.

| 계기 | 원자적 durable mutation | reducer projection | 금지 |
| --- | --- | --- | --- |
| 최초 session-scoped delivery가 실행을 요구 | `LogicalExecution(open)`과 reservation receipt 생성 | `reserved` | admission 전 실행, `in_process` fallback |
| 독립 runner capacity 대기 | `reconcile_due_at`만 갱신 | `reserved + delayed` | 503·호출자 재시도 요구 |
| child spawn receipt | current `RunnerAttempt.spawnReceipt` CAS | `provisional` | child 부재로 취급 |
| ownership proof | 같은 attempt의 `ownershipProof` CAS | `activating` | 다른 attempt proof 혼합 |
| activation receipt + attachment lease | 같은 attempt의 `activationReceipt`와 fenced grant CAS | `active` | delivery 선할당 |
| active-v1 in-place promotion | detach/epoch barrier와 v2 grant를 묶은 `PromotionHandoffFence` CAS | 동일 execution·command의 `active` | old socket·writer와 v2 writer 동시 유효 |
| external request publish receipt | request ledger와 event ingress receipt 연결 | `externalInput.waitingForUserRequestIds` | projection 직접 쓰기, 동일 request 재게시 |
| attachment lease 상실 | 새 fact 없음. 기존 lease 만료를 reducer가 관측 | `recovering` | stream 실패·execution terminal |
| stop 요청 | lineage intent를 current execution에 bind하는 CAS | `settlement.settling` | 순간 execution id를 public target으로 사용, FIFO 뒤 배치, ACK를 `stopped`로 반환 |
| runner terminal witness | immutable witness와 delivery admission cutoff CAS | `terminating` | process absence·host intent를 outcome으로 승격, cutoff 뒤 session admission 차단 |
| terminal ingress receipt | witness의 outbox watermark 수신을 CAS | `terminating` | output drain 전 barrier |
| `TerminalSafetyBarrier` | 모든 의미 정산과 effect fence 검증 뒤 CAS | `settlement.settling` | 물리 삭제 완료를 요구, stale effect 허용 |
| visible terminal commit | witness→ingress→barrier FK를 묶어 `LogicalExecution(terminal)`로 CAS | `terminal/finished` | first-signal 덮기, barrier 전 공개 |
| terminal 이후 background retention | old attachment/writer revoke와 current `ExecutionRetention` 생성 CAS | `retention.active` | current owner 없는 background effect·복수 event route |
| certified replacement | predecessor `continuity_transfer`와 successor reservation을 한 transaction에 commit | lineage의 successor `reserved`, session stream은 계속 open | 중간 idle, certificate 없는 실행, predecessor open 잔존 |
| attempt 격리 | isolation receipt와 하나의 cleanup obligation을 commit | execution은 `recovering` 또는 successor `reserved` | canonical PID 후보 유지, obligation 중복 |
| delivery bind·rebind | append-only assignment ordinal + kind별 operation | delivery별 received/consumed projection | mutable current pointer, scoped input 오재해석 |
| delivery cancel 요청 | stable delivery row의 intent CAS | delivery별 `cancel_requested` | assignment 부재 시 취소 불가, release 뒤 cancel 유실 |
| delivery consume·cancel·no-effect | runner disposition winner 뒤 operation receipt와 delivery resolution FK CAS | delivery별 public state | 중앙 cancel이 미반영 runner consume를 덮기, pending cancel delivery rebind |

projection reducer의 입력은 `LogicalExecution`, current `RunnerAttempt`, attachment/retention lease, append-only assignment/operation receipt, delivery/request ledger, terminal receipts와 명시적 `observedAt`뿐이다.

| 축 | projection | declarative predicate |
| --- | --- | --- |
| logical | `idle/open/terminal` | open logical row 부재 / open row / terminal record |
| launch | `none/reserved/provisional/activating/active` | current attempt와 spawn·ownership·activation receipt 조합 |
| external input | waiting/applying request id 집합 | published unresolved request / responded이고 exact delivery consumption 전. 둘 다 0이면 foreground |
| attachment | `not_applicable/attached/recovering` | open launch 해당 없음 / valid lease / open인데 valid lease 없음 |
| retention | `none/active` | current unreleased retention authority 부재 / lease·epoch·event route가 유효한 authority 하나 |
| settlement | `none/settling/finished` | intent·witness 없음 / intent 또는 witness 있고 visible terminal 전 / terminal record |

축은 동시에 참일 수 있다. `launch.active + waitingForUserRequestIds≠[] + applyingResponseRequestIds≠[] + attachment.recovering + settlement.none`도 유효하다. 이 reducer의 declarative schema가 TypeScript projection, SQL regular view/invariant function과 transition fixture를 생성한다. writable `phase` 컬럼, phase별 CAS, memory phase↔DB phase 수동 동형 표는 삭제한다.

### 외부 입력 수명 정책

Claude `AskUserQuestion`의 300,000ms UX는 유지하되 publication transaction이 operation receipt에 immutable `publishedAt`과 `expiresAt=publishedAt+300_000`을 함께 쓴다. request가 runner journal에만 있고 아직 공개되지 않았다면 publication receipt가 없고 timer는 시작하지 않는다. response admission은 request row와 operation publication receipt를 잠근 transaction의 DB 시각이 `expiresAt` 이내일 때만 central `responded` receipt를 commit한다. deadline 뒤 winner가 비어 있으면 같은 transaction이 `expired`를 먼저 commit하므로 expiry worker 실행 시각은 결과에 관여하지 않는다.

late response는 새 input이 아니다. canonical result는 `applied`, `already_applied`, `not_applied(expired|cancelled|execution_finished)` 중 하나다. Agents approval처럼 backend에 timeout이 없으면 publication 뒤에도 deadline을 만들지 않는다. 이 publication/admission 기준을 구현할 수 없는 backend에는 restart-transparent capability를 발급하지 않는다.

복수 request는 request id unique ledger로 표현한다. 하나가 응답·만료·취소되어도 다른 row는 변하지 않는다. response가 deadline·terminal-prefix lock을 이기면 public `waitingForYou`에서 빠지고 `applyingResponseRequestIds`에 들어가며 exact delivery consumption receipt가 생길 때까지 그대로다. expiry와 user/owner cancel은 runner journal+engine application까지, witness-first execution-finished는 exact witness no-effect FK까지 있어야 끝난다. 이 prefix를 terminal/stop의 `settling`으로 표시하지 않는다. 모든 request application이 끝난 순간 새 foreground progress lease를 시작할 수 있고, execution terminal은 그 뒤에만 barrier로 진행한다.

## 획득과 해제의 대칭

### 획득 경계

`reserveExecution()`은 session별 open unique를 잠그고 `LogicalExecution(open)`, reservation receipt, 첫 `RunnerAttempt`, reconcile due time을 한 transaction에 만든다. activation/terminal promise와 mutex는 이 row를 구독하는 메모리 projection일 뿐 durable authority가 아니다. v2 사용자-visible admission은 `executor_kind=independent_runner`만 허용한다. capacity가 없으면 승인된 delivery와 open execution이 durable하게 기다리며 실패·503·`in_process` fallback을 만들지 않는다.

spawn 단위는 `(executionId, attemptId)`다. attempt마다 `runner-state/{sessionHash}/{executionId}/{attemptId}` namespace와 stable launch operation id가 하나씩 있다. launcher는 같은 operation id로 재진입할 수 있지만 물리 child는 최대 하나만 만들 수 있다. child bootstrap, registration, PID evidence, lifecycle, socket은 attempt id를 필수로 가지고 다른 namespace의 PID를 후보로 합치지 않는다. activation grant 전 child는 execute나 host call effect를 낼 수 없다.

rollback이 exact child absence를 증명하지 못하면 한 transaction이 다음 사실만 추가한다.

1. attempt capability와 attachment epoch를 revoke한 isolation receipt
2. current attempt pointer 해제
3. exact child에 대한 하나의 `cleanup_obligation`
4. successor placement wake

격리된 attempt는 canonical registration/PID join과 current-attempt unique에서 빠지므로 successor namespace가 즉시 열리지만, 물리 child는 node capacity 안에서만 spawn된다. 이전 child는 살아 있어도 revoked attempt/epoch로 effect를 만들 수 없다.

node capacity도 별도 permit 상태 기계가 아니다. `physicalAbsenceReceipt == null`인 attempt 수가 물리 capacity 점유이고, 그중 `isolationReceipt != null`인 수가 orphan quota 점유다. 필수 설정 `physicalProcessLimit`과 `isolatedProcessLimit`에 닿으면 해당 node의 cleanup obligation을 우선 claim하고 exact TERM→force-reap을 수행하며, 새 placement만 다른 eligible node로 넘기거나 durable wait시킨다. 기존 execution과 다른 node는 멈추지 않는다. N회 rollback 검증은 OS의 exact child 수가 spawn receipt를 가진 unresolved attempt 수와 일치하고, 모든 unresolved attempt count가 capacity 이내인지 검사한다.

### 해제 경계와 TerminalSafetyBarrier

host의 종료 의도, runner의 terminal outcome, 사용자-visible terminal은 서로 다른 사실이다. 순서는 고정된다.

1. stop/policy 요청이면 stable lineage intent를 current execution/generation에 bind하는 CAS를 한다. intent는 outcome이 아니다.
2. runner가 존재하면 마지막 engine event와 outbox를 먼저 durable하게 쓰고 `RunnerTerminalWitness`를 commit한다. 아직 물리 child가 없거나 exact absence가 증명된 preactivation 실행은 outbox 0과 absence receipt를 가진 `PreactivationTerminalWitness`를 commit한다.
3. 비정본 `execution_ended` frame은 host를 깨우기만 한다.
4. host/reconciler는 witness high-watermark까지 event ingress에 replay하고 `TerminalIngressReceipt`를 commit한다.
5. witness의 `deliveryAdmissionCutoffSequence` 이하에서 현재 execution에 bind된 assignment와 execution/request-scoped delivery를 canonical receipt로 정산한다. cutoff 뒤 또는 아직 unassigned인 session delivery는 barrier를 막지 않고 FIFO에 남긴다. 닫히는 execution에 bind됐지만 미소비인 session delivery는 assignment만 `released_for_rebind`로 닫는다.
6. 모든 external request를 정산한다. response는 exact request-scoped delivery consumption composite FK, expiry와 user/owner cancel은 runner journal+engine application, execution-finished no-effect는 exact terminal witness FK가 필요하다.
7. stream과 durable host-call journal을 정산한다.
8. attachment, writer, child/retention 각각에 stale authority가 사용자-visible effect를 낼 수 없다는 `ResourceSafetyReceipt`를 만든다.
9. 고정된 의미 receipt와 세 effect-fence receipt를 `TerminalSafetyBarrier`로 commit한다. barrier는 cutoff 값을 복사하지 않고 exact `witnessId`만 가진다. logical execution은 아직 open이다.
10. 별도 `commitVisibleTerminal` transaction이 witness→ingress→barrier FK를 다시 검증하고 `LogicalExecution(terminal)`을 공개한다.

물리 회수 완료는 barrier의 일반 조건이 아니다. 살아 있는 fenced child는 `retained`와 정확히 하나의 `cleanupObligationId`를 가져야 한다. child/retention의 `released`는 `never_acquired` 또는 exact `process_absent`만 허용되고, attachment/writer acquired 뒤 `released`는 physical release receipt가 있어야 한다. `transferred`는 old revocation과 new authority/epoch를 증명한다. exact child의 preterminal obligation이 이미 있으면 terminal receipt는 그 obligation을 가리키며 같은 attempt의 새 post-terminal child obligation 생성은 procedure가 거부한다. attachment·writer·retention·보조 자원도 같은 `cleanup_obligations` relation을 쓰며 별도 post-terminal maintenance authority를 만들지 않는다.

procedure `session_commit_terminal_safety_v2(...)`는 다음을 한 transaction에서 검증한다.

- 모든 external request가 response delivery consumption, expiry/user cancel runner journal→engine application, execution-finished terminal witness FK 중 자기 kind의 유일한 chain으로 정산됨
- barrier의 `(executionId, witnessId)` FK가 open row의 첫 witness와 같고, 그 witness에서 읽은 cutoff 이하의 current-execution assignment와 execution/request-scoped delivery가 정산됨. cutoff 뒤 또는 unassigned session delivery는 검사 대상에서 제외됨
- witness outbox watermark 이하 semantic event가 ingress receipt에 포함됨
- 세 physical slot의 effect fence가 현재 attachment epoch·writer lease·attempt capability와 일치함
- `released` attachment/writer가 실제 acquire 뒤 fence만 들고 있으면 physical release receipt를 요구하고, `transferred`는 old authority revocation과 new authority id/epoch를 모두 요구함
- child는 `retained+attempt_capability_fenced`만, retention transfer는 `transferred+authority_transferred(resource=retention)`만 허용함
- retention transfer의 `(newAuthorityId, newAuthorityEpoch, transferReceiptId)`가 exact current `execution_retentions` row의 `(retentionId, authorityEpoch, authorityTransferReceiptId)`와 composite FK로 일치함
- 살아 있는 exact child의 obligation id가 attempt의 기존 `cleanup_obligation_id`와 같음
- `UNIQUE(resource_kind, resource_id) WHERE physical_resolution_receipt_id IS NULL`로 active cleanup owner가 하나뿐임
- 같은 attempt에 새 child obligation을 만들지 않음

검증 실패는 terminal을 지연시키고 obligation/reconcile wake를 유지한다. 재시도 소진으로 barrier를 우회하는 variant는 없다. barrier commit과 visible terminal commit은 별도 transaction이므로 그 사이 crash prefix는 open row의 non-null witness·ingress·barrier로 내구화된다. 반대로 barrier가 commit되면 stale effect는 불가능하므로 물리 삭제가 늦어도 별도 visible terminal CAS를 안전하게 재개할 수 있다.

첫 terminal witness slot은 `(execution_id, execution_command_id)`당 하나다. `finish→fail`, `fail→finish`, `fail→fail` 모두 첫 witness만 outcome이며 late signal은 internal diagnostic이다. host intent나 process absence는 witness가 아니며 사용자-visible failed/stopped를 만들 수 없다.

`deliveryAdmissionCutoffSequence`의 writable owner는 witness 하나다. 값은 witness transaction snapshot에서 이미 admission된 가장 큰 session enqueue sequence이고 `TerminalSafetyBarrier`는 `(executionId, witnessId)` FK를 통해서만 이를 읽는다. barrier에 별도 cutoff column을 두지 않으므로 두 값의 불일치 상태를 만들 수 없다. witness 뒤 binder는 새 assignment를 그 execution에 만들 수 없다. cutoff 이하라도 아직 unassigned인 session delivery는 successor 몫이고, cutoff 뒤 admission도 그대로 FIFO에 남는다. 따라서 terminal barrier는 현재 execution이 실제로 얻은 assignment만 닫으며 session head 존재 자체를 terminal 조건으로 쓰지 않는다.

host shutdown이나 adoption handoff는 execution termination이 아니다. `detachAttachment()`가 higher epoch barrier를 만들고 logical execution과 stream은 open으로 유지한다. `close`, rollback, reconnect exhaustion, `execution_ended`, offline replay는 직접 stream terminal을 쓰지 않으며 위 receipt pipeline을 호출하거나 recovery projection만 바꾼다.

## 자력 회수

### attachment의 fenced lease

attachment는 socket 존재가 아니라 중앙 DB와 runner journal이 같은 epoch로 승인한 lease다.

1. `session_prepare_runner_attachment_v2(...)`가 higher `PreparedAttachmentGrant`를 만들고 old DB writer를 freeze한다.
2. runner recovery endpoint가 grant를 받아 journal을 `quiescing`으로 CAS하고 이전 epoch command admission을 닫는다.
3. runner는 `settledThrough..acceptedThrough`의 모든 command를 `settled(resultReceiptId)` 또는 `transferred(journalEntryId, resumeAtEpoch)`로 처분한 `RunnerAttachmentBarrierReceipt`를 commit한다.
4. `session_commit_attachment_grant_v2(...)`가 barrier의 빈 구간·중복·누락을 검사하고 새 DB writer lease를 연다.
5. 모든 command와 runner↔host call은 execution/command/attachment epoch·monotonic sequence key를 가진다. host call은 pre-send canonical receipt가 sequence→operation/hash/payload를 고정하고 response는 같은 call key를 FK로 참조한다. `RunnerAttachmentJournal` current epoch/grant와 다르거나 receipt 값이 다른 frame은 effect 수행 전에 no-effect 처리된다.

old host detach는 정확성 전제가 아니다. prepare 전에는 old epoch 하나, quiesce 중에는 writer 0개, commit 뒤에는 new epoch 하나만 effect 권한을 가진다. host는 5초마다 renew하고 TTL은 15초다. runner는 TTL이 지나면 engine을 실패시키지 않고 self-quiesce하여 input/outbox/pending host call을 journal에 보존한다. 기존 30초 host-call timeout은 v2에서 lifecycle failure가 아니라 reconcile wake다.

### inventory와 회수 reducer

회수의 시작점은 등록 디렉터리가 아니라 중앙의 모든 open `LogicalExecution`이다. maintenance tick은 open execution, current/all attempt, attachment lease, runner registration·SQLite witness, delivery/request ledger를 `executionId/attemptId`로 full outer join한다. 메모리 controller는 불일치 탐지에만 쓴다.

`ExecutionRecoveryProjection`의 네 variant만 허용된다.

- live runner + invalid/missing attachment → higher epoch takeover
- registration identity 불완전 → 같은 attempt identity 보강
- exact process absence + complete continuity certificate → certified replacement
- exact process absence + boundary certificate 결손 → invariant breach

recovery는 별도 saga phase를 쓰지 않는다. takeover와 cross-store handoff는 stable operation id와 claim epoch를 가진 receipt CAS로 재진입하며, terminal witness가 먼저 commit되면 모든 nonterminal operation predicate가 거부된다. cleanup scheduling과 권한은 `cleanup_obligation` lease 하나가 맡는다. 새 메시지·재시작·ping은 wake 가속일 뿐 회수 전제가 아니다.

terminal 이후 retention은 open-execution scan의 대상이 아니므로 별도 **조회 축**으로 빠뜨리지 않는다. 같은 maintenance tick이 `release IS NULL`인 `execution_retentions`를 lease 시각으로 스캔한다. lease가 유효하면 exact owner/epoch만 renew하거나, 모든 background task가 terminal이고 exact resource absence/effect fence가 있을 때 typed release receipt를 commit할 수 있다. 만료됐으면 eligible host가 row를 잠그고 `expectedAuthorityEpoch` CAS로 owner를 바꾸며 epoch를 정확히 1 올리고 lease와 `eventRoute.authorityEpoch`를 한 transaction에 갱신한다. background task inventory, route id, authority transfer provenance와 cleanup obligation id는 보존한다. takeover owner도 같은 exact-epoch release CAS만 쓴다. release receipt는 retention/epoch/owner/tasks/effect-fence/absence를 모두 묶으며, release 뒤 renew/takeover/event/effect는 거부된다. 별도 retention phase·takeover row는 만들지 않는다.

등록 디렉터리가 0개여도 open execution이 있으면 due scan이 회수를 시작한다. 반대로 중앙 execution 없이 registration/PID만 있으면 attempt namespace로 식별해 isolation receipt와 cleanup obligation을 만든다. 실패한 attempt의 잔재는 다음 attempt의 identity 입력에 합쳐지지 않는다.

운영 수치는 다음과 같다. 이는 저장소 가용성과 fair scheduling 아래의 SLO이며 무제한 worker fail-stop을 포함한 hard correctness bound라고 주장하지 않는다.

| 수치 | 값 | 의미 |
| --- | ---: | --- |
| `EXECUTION_RECONCILE_SCAN_MS` | 5,000ms | due open execution scan 간격 |
| `CLEANUP_OBLIGATION_LEASE_MS` | 15,000ms | cleanup claim 재취득 상한 |
| `ATTACHMENT_RENEW_MS` | 5,000ms | lease 갱신 간격 |
| `ATTACHMENT_TTL_MS` | 15,000ms | runner self-quiesce 시각 |
| `ATTACHMENT_TAKEOVER_HANDSHAKE_MS` | 10,000ms | higher epoch barrier 목표 |
| `PROCESS_ABSENCE_GRACE_MS` | 15,000ms | 마지막 positive liveness 뒤 grace |
| `PROCESS_ABSENCE_SECOND_SCAN_MS` | 5,000ms | 독립 두 absence 관측 간격 |

E5는 continuity/effect certificate가 완전한 복구 가능 실행에 대한 `eventual settle + availability delayed + internal receipt progress`다. scheduler는 cleanup/recovery queue에 aging을 적용하고 같은 key가 무한히 뒤로 밀리지 않는 no-starvation contract를 제공해야 한다. 구체 queue discipline은 구현에서 정하되 backlog fixture는 필수다. certificate 결손 breach는 이 보장의 대상이 아니며 즉시 blocked로 분리한다.

### owner-null과 continuity

owner-null open row는 idle·interrupted·가짜 visible terminal로 바꾸지 않는다. stable identity를 찾으면 같은 execution에 backfill하고 higher epoch로 adopt한다. exact process absence가 확인되면 complete `ExecutionContinuityCertificate`가 있을 때만 predecessor의 non-public `ExecutionSupersessionRecord(kind=continuity_transfer)`와 successor reservation을 한 transaction에 commit한다. 이 transaction은 같은 `ExecutionLineageId`를 보존하고 predecessor open unique를 닫으며 successor open을 만든다. 또한 pending request마다 `ExternalRequestAuthorityTransfer`를 기록해 authority execution/epoch와 이미 admitted된 response delivery scope를 옮기고, lineage stop invocation이 있으면 같은 row lock 안에서 binding을 successor로 이동한다. response admission과 replacement는 lineage row 뒤 request id 정렬 순으로 같은 lock을 얻으므로 한쪽의 old epoch write가 남지 않는다. 둘이 동시에 open이거나 둘 다 없는 prefix, 질문은 보이는데 답변 authority는 predecessor인 prefix, stop invocation이 두 execution에 붙는 prefix가 없다.

v2 eligibility는 모든 engine/tool effect boundary에서 다음 effect 전에 continuity certificate를 durable하게 갱신하는 capability test를 요구한다. external non-idempotent effect는 stable operation id로 provider 결과를 재조회할 수 있거나 effect와 local committed receipt가 같은 transaction에 들어가는 경우만 허용한다. `effect committed → certificate commit` 사이 crash 뒤에도 stable operation lookup 또는 same-transaction receipt로 결과를 복원할 수 있어야 한다. certificate에는 checkpoint, consumed input/outbox/host-call watermark, pending request ids, delivery head, 모든 effect의 `not_started/committed/compensated` receipt와 atomicity proof가 있어야 한다. 이 조건을 못 지키는 backend는 v2 replacement capability를 받지 못하고 in-place attachment takeover만 허용된다.

v2-capable process가 certificate 없이 사라지는 경우는 지원 상태가 아니라 P0 invariant breach다. replacement·새 context 실행·가짜 terminal을 금지하고 public availability를 `blocked`로, activity를 `not_running`으로 유지하며 incident id를 노출한다. 운영 종착지는 수동 증거 복구뿐이고, 그 실행에는 완전 transparency 보장을 주장하지 않는다. 죽은 process가 더는 만들 수 없는 certificate를 기다리는 정상 recovery state는 없다.

### progress와 process liveness

semantic `assistant_message`, `thinking`, `tool_result`만 foreground progress lease를 갱신한다. Claude raw `text`는 adapter 경계에서 `assistant_message`로 정규화하고 Codex 두 모드와 Agents도 같은 semantic union을 반환한다. `tool_start`는 progress가 아니라 1,800,000ms 비갱신 absolute lease를 열며 tool result/cancel/terminal이 닫는다. heartbeat·socket·PID·등록 존재는 process liveness일 뿐 progress가 아니다.

foreground gap도 `SOUL_RUNNER_LEASE_TIMEOUT_MS=1,800,000ms`를 쓴다. progress gap과 tool absolute lease가 모두 지났고 terminal witness가 없으며 두 scan에서 sequence가 같을 때만 stalled termination intent를 만든다. unresolved published external request가 있으면 foreground reaping은 정지하지만 process liveness와 request deadline은 계속 감시한다.

| backend | raw event | semantic fact |
| --- | --- | --- |
| Claude SDK | `text` / `thinking` / `tool_result` | `assistant_message` / `thinking` / `tool_result` |
| Codex CLI·app-server | completed agent/reasoning/tool item | 같은 semantic union |
| OpenAI Agents | completed output/tool result | `assistant_message` / `tool_result` |
| 모든 backend | question/approval requested | progress가 아닌 external request ledger |

adapter 반환은 `ExecutionProgressKind | ExternalRequestKind | NonProgressEvent` exhaustive union이다. 새 raw event가 어느 variant에도 없으면 compile/test가 실패한다.

## delivery와 실행의 연결

### caller identity와 DeliveryScope

exactly-once admission의 시작점은 첫 network send 전 caller가 만든 stable delivery id다.

| caller·동작 | v2 identity | scope |
| --- | --- | --- |
| soul-ui/soul-app prompt·intervention | action UUID | `session` |
| Slack intervention | `UUIDv5(channelId, messageEventId)` | `session` |
| completion/runtime followup | 기존 deterministic delivery id | `session` |
| AskUserQuestion response | `UUIDv5(sessionId, "respond", requestId)` | stable request id + current authority epoch |
| approval/reject | `UUIDv5(sessionId, "approval", approvalId)`, decision은 payload hash에 포함 | `request` |
| interrupt command | invocation마다 새 UUID | `execution` |
| Cogito MCP 모든 입력 | required `delivery_id` | 동작에 맞는 scope |
| orch·cross-node | caller id와 scope를 Python→TS 전 구간 그대로 관통 | 동일 |

누락 ID를 payload hash로 생성하는 서버 fallback은 없다. 같은 문장의 별도 action을 합칠 수 있기 때문이다. 동일 ID에 다른 payload가 오면 durable identity-conflict proof 뒤에만 거부한다. caller capability가 stable ID와 scope를 모두 제공하기 전에는 v2 ingress를 켜지 않는다.

`session` scope의 prompt/intervention만 현재 execution이 닫힌 뒤 다음 유효 execution으로 이동할 수 있다. `execution` scope interrupt는 exact execution id+generation에만 적용된다. `request` response/approval은 stable request id를 대상으로 admission transaction이 current request-authority epoch를 읽어 bind하며, certified replacement는 같은 request row의 epoch를 원자 이전한다. request가 이미 끝났으면 canonical `no_effect/not_applied`를 반환하고 다음 turn 입력으로 재해석하지 않는다.

stop은 delivery가 아니다. caller는 public projection의 stable lineage id와 invocation id를 보내고, DB가 current open execution을 잠가 binding한다. continuity transfer도 같은 lineage control row를 잠그므로 동일 invocation은 predecessor 또는 successor 정확히 한 곳에만 존재한다. stop ACK는 `stop_requested`이고 bound execution의 runner witness 뒤에만 public outcome이 `stopped`다. reserved/provisional/activating에서도 intent가 먼저 이기면 launcher/activation이 effect를 시작하지 않고 같은 terminal pipeline으로 수렴한다. late/repeated stop은 새 intent를 만들지 않고 canonical lineage receipt를 반환한다.

### 공통 IdempotentOperation

Postgres, runner SQLite, event ingress는 한 transaction이 아니다. 두 흐름은 같은 생성 schema에서 나온 kind별 `IdempotentOperation`을 쓰며 receipt 내용의 writable owner는 operation 하나다.

| operation kind | receipt의 단일 owner | prepared | registered | published/disposition | resolved |
| --- | --- | --- | --- | --- | --- |
| external request publication | `ExternalRequestPublicationOperation` | runner request journal | 중앙 request ledger | event ingress publication receipt | response는 delivery consumption FK, expiry/cancel은 runner journal→engine application |
| delivery assignment | `DeliveryAssignmentOperation` | 중앙 assignment intent | runner inbox receipt | runner-local consumed/cancelled/target-terminal-release winner | 중앙 mirror+head advance 또는 target-terminal rebind release |

두 operation variant는 서로 다른 typed payload와 exact-store receipt union을 가진다. request/assignment domain row에는 operation id와 stage receipt FK만 있고 receipt 내용을 복사하지 않는다. `claimEpoch`은 재청구마다 단조 증가하며 lease owner·expiry와 `nextWakeAt`을 원자적으로 갱신한다. unresolved operation의 `nextWakeAt`은 항상 존재한다. due scanner는 operation의 final receipt 부재와 wake를 읽고, open execution/head scan은 wake를 앞당기는 가속 경로일 뿐 correctness 정본이 아니다. final receipt 뒤에도 operation과 wake 이력은 삭제하지 않는다.

각 stage mutation은 `(operation_id, payload_hash, expected previous receipt)` CAS이고 이미 실행된 effect는 receipt 단일 owner에서 같은 receipt를 재조회한다. claim lease가 바뀌어도 stable operation id는 바뀌지 않는다.

external request publication의 crash prefix 네 개를 모두 복구한다.

1. journal 뒤 중앙 등록 전: 같은 operation이 ledger 등록을 재개한다.
2. 등록 뒤 publish 전: 같은 semantic event id로 ingress publish를 재개한다.
3. publish 뒤 receipt 전: ingress unique id를 재조회해 published receipt를 채운다.
4. response admission과 expiry 경합: publication transaction의 immutable `expiresAt`과 response transaction의 DB 시각으로 winner를 정한다. `db_now > expiresAt`이면 expiry worker가 아직 실행되지 않았어도 response는 `expired`를 돌려받는다.

delivery assignment도 assignment intent 뒤 node call 결과를 추측하지 않는다. `DeliveryRecord`에는 mutable current-assignment pointer가 없다. 각 시도는 같은 delivery id 아래 ordinal이 증가하는 append-only assignment이고 unresolved row는 delivery당 최대 하나다. assignment operation/claim/capability epoch를 가진 registration RPC만 runner-local `RunnerAssignmentDispositionSlot`을 열 수 있다. slot은 `open→registered→disposed` 또는 `open→closed_before_registration` 한 경로만 허용한다. 중앙 final은 slot receipt를 mirror하면서 delivery resolution, assignment resolution, FIFO head advance를 한 transaction에 commit한다.

session-scoped target execution이 consumption 전에 닫히면 current assignment만 release하고 delivery resolution은 null로 보존한다. inbox 전이면 runner close ack 또는 exact absence+assignment capability revoke인 typed registration fence, inbox 뒤면 local `target_terminal_released(engineObservationCount=0)`가 먼저 필요하다. 다만 delivery-level cancel intent가 있으면 rebind transaction이 delivery row를 잠가 cancel과 consume winner를 다시 판정한다. consume가 먼저 이긴 경우 외에는 cancel이 delivery final을 차지하고 successor assignment를 만들지 않는다. cancel이 없을 때만 ordinal을 올려 rebind한다. execution scope는 no-effect로 끝나고 request scope는 current request authority가 successor로 transfer된 경우에만 새 authority epoch로 rebind한다. current unresolved assignment는 마지막 이력의 projection이며 partial unique가 강제한다.

cancel intent와 final winner는 assignment가 아니라 stable delivery row가 소유한다. 따라서 capacity wait로 assignment가 없어도 취소할 수 있고, intent는 모든 ordinal을 관통한다. inbox 전 cancel은 typed registration fence 뒤 delivery `cancelled`로 끝난다. inbox 뒤에는 public `cancel_requested`만 반환하고 local slot의 consume/cancel disposition을 기다린다. local consume가 먼저면 final은 consumed, local cancel이 먼저면 central cancelled뿐이다. target-terminal release가 먼저여도 pending cancel을 지울 수 없고 rebind 직전 delivery lock에서 다시 경합한다. 같은 invocation retry는 delivery-level canonical intent/winner를 반환한다.

request response application은 별도 semantic chain을 만들지 않는다. request operation의 `responded` branch가 가리키는 composite FK는 exact request-scoped delivery의 consumed runner disposition, central mirror, runner input sequence를 모두 묶는다. response admission과 terminal witness는 request+lineage terminal-prefix lock을 같은 순서로 얻는다. witness first는 `not_applied(execution_finished)`, response first는 exact application이 끝날 때까지 terminal barrier를 통과하지 못한다. certified replacement는 pending request authority와 response delivery scope epoch를 successor로 함께 이전하므로 `waiting_for_you → replacement → answer`가 같은 request/event로 이어진다.

### admission과 public receipt

orch는 node WebSocket 호출 전 delivery와 idempotency receipt를 Postgres에 commit하고 즉시 binder를 깨운다. node 단절·host-call timeout·assignment CAS miss는 API 실패가 아니라 내부 지연이다. CAS false면 stable id로 canonical row를 재조회한다. row가 있으면 접수 성공이고 node를 다시 직접 호출하지 않는다. 260823 두 사고의 “큐 등재 성공 + 503”은 이 경계로 구성 불가능하다.

admission transaction은 payload hash만 남기지 않는다. 현행 JSONB envelope를 canonical key ordering으로 정규화해 immutable `session_deliveries.payload`에 저장하고 DB가 그 값의 hash와 `payloadHash` 일치를 검사한다. assignment와 재기동 replay는 caller memory나 원 요청 객체가 아니라 이 durable payload만 읽는다. payload schema version도 envelope 안에 포함해 reader가 바뀌어도 같은 semantic input을 복원한다.

public admission은 assignment operation의 여러 receipt prefix를 하나의 false success로 뭉개지 않는다.

~~~ts
interface ReceivedInput {
  status: "received";
  deliveryId: DeliveryId;
  payloadHash: string;
  meaning: "durably_received_may_not_be_running";
  controls: "read_public_delivery_projection";
}

type ProvenAdmissionRejection = {
  status: "not_received";
  proofId: string;
  reason: "payload_identity_conflict" | "authorization_denied";
};

type AdmissionResult = ReceivedInput | ProvenAdmissionRejection;

type DeliveryCancelResult =
  | { status: "cancel_requested"; deliveryId: DeliveryId; intentReceiptId: string }
  | {
      status: "cancelled";
      deliveryId: DeliveryId;
      proof:
        | { kind: "closed_before_registration"; registrationFenceReceiptId: string }
        | { kind: "runner_cancelled"; runnerDispositionReceiptId: string };
      engineObservationCount: 0;
    }
  | {
      status: "not_cancelled";
      deliveryId: DeliveryId;
      reason: "already_consumed" | "already_resolved";
      canonicalReceiptId: string;
    };
~~~

`received`는 안전하게 접수됐다는 뜻만 가진다. 실행이 시작됐다는 뜻은 execution activity와 delivery consumption receipt가 말한다. 호출자 재전송은 요구하지 않는다. 취소 가능 여부는 시점에 따라 달라지므로 admission ACK가 약속하지 않고 delivery별 public control projection을 읽는다. transport가 응답 전에 끊기면 caller는 같은 delivery id로 자동 재조회해 동일 receipt를 받는다.

request-scoped 응답·approval의 결과는 `applied | already_applied | not_applied(expired|cancelled|execution_finished)`다. deadline 판정은 locked request row의 immutable `expiresAt`과 DB 시각으로 한다. response admission 뒤에는 별도 application 정본을 만들지 않고 exact delivery consumption composite FK가 결과를 확정한다. expiry/cancel만 request operation의 runner journal·engine application chain을 재개한다. raw failure는 internal diagnostic에만 남고 외부에는 `PublicOutcome`만 투영한다.

## 재기동 투명성과 public semantic projection

성공 기준은 다음 문장이다.

> **재시작 유무가 입력 승인 의미·출력·최종 결과·필요한 사용자 조작을 바꾸지 않는다.**

대시보드 연결 단절과 지연은 허용되지만, 재전송 요구·503·turn 중단·응답 유실·중복·context 유실은 허용되지 않는다. 내부 원인을 숨기는 것과 보장 단계를 숨기는 것은 다르다. public projection도 내부 lifecycle처럼 독립 축을 보존한다.

| public 축 | 값 | 근거·의미 |
| --- | --- | --- |
| execution lifecycle | `idle | open | finished` | session lineage의 logical execution과 visible terminal |
| execution activity | `not_running | running` | current runner consumption/effect authority. receipt 없이 running 금지 |
| external input | `waitingForYouRequestIds[] + applyingResponseRequestIds[]` | published unresolved request / responded이고 exact delivery consumption 전. 두 집합은 동시에 non-empty 가능 |
| settlement | `none | settling` | stop 또는 terminal prefix만. response 적용 대기를 이 축으로 숨기지 않음 |
| deliveries | delivery별 `received | consumed | cancel_requested | cancelled | no_effect` | admission·operation-owned runner disposition·central mirror receipt |
| availability | `normal | delayed | blocked` | SLO 지연 또는 자동 진전 보장 상실. 원인 phase는 노출하지 않음 |
| controls | stop 상태 + cancellable delivery id 집합 | 현재 구조가 실제로 완결할 수 있는 control만 노출 |

축은 동시에 참일 수 있다. execution A가 running인 동안 delivery B는 received일 수 있고, 질문 Q1을 기다리면서 Q2 답변은 `applyingResponseRequestIds`에 있을 수 있다. stop/terminal prefix가 없다면 이때 settlement는 `none`이다. 우선순위로 한쪽을 숨기지 않는다.

`continuity_invariant_breach`는 `execution.open/activity.not_running + availability.blocked { incidentId, automaticProgress:false }`다. `running+delayed`나 `finished`로 거짓 투영하지 않는다. 죽은 process가 witness를 만들 수 없는 동안 execution stop은 `unavailable(continuity_guarantee_unproven)`이고, 아직 소비되지 않아 실제 cancel proof를 만들 수 있는 delivery id만 `cancellableDeliveryIds`에 남는다. 가능한 action은 수동 증거 복구 대기와 지원 요청뿐이다. 이는 완전 transparency가 이미 깨진 P0 상태를 정직하게 표시하되 재전송이나 완료 불가능한 control을 요구하지 않는 계약이다.

### durable fact와 복구 창

| 사실 | durable 위치 |
| --- | --- |
| logical execution open/terminal과 reservation | 중앙 execution ledger |
| runner physical lifecycle | `runner_attempts` monotonic receipts |
| attachment writer authority | 중앙 lease + runner epoch journal |
| user input과 scope/FIFO | delivery ledger + head |
| cross-store assignment/publication | `idempotent_operations` receipts |
| pending request/publication/resolution | request ledger |
| input/outbox/host call/effect checkpoint | runner journal + continuity certificate |
| terminal ordering | witness + ingress receipt + `TerminalSafetyBarrier` |
| physical cleanup responsibility | `cleanup_obligations` |
| progress/process liveness | runner journal + central monotonic projection |

복구 전 입력도 정상과 같은 순서를 탄다: caller admission → `received` → session head 대기 → open execution/attachment 복원 → assignment operation → runner inbox → consumption receipt → `running`. request response는 exact request ledger에 admission되고 deadline 전 admission이면 복구가 300초 뒤 끝나도 적용된다. stop은 FIFO를 건너 termination intent를 기록한다.

output transport는 exactly-once가 아니다. runner outbox와 event ingress는 at-least-once replay하고, 모든 semantic event가 stable semantic event id를 가진다. web·app reducer는 그 id로 dedupe하여 effectively-once rendering을 만든다. dashboard reconnect는 마지막 ingress cursor 다음부터 요청하되 겹친 replay도 같은 reducer가 제거한다.

| 내부 사건 | public 표현 | 금지 |
| --- | --- | --- |
| node WebSocket 단절 | delivery `received` + availability `delayed` | 503, retry 요구 |
| attachment 상실 | execution activity는 receipt대로 유지 + availability `delayed` | stream error, 근거 없는 running |
| 독립 runner capacity 대기 | delivery `received` + execution activity `not_running` + `delayed` | accepted를 running으로 표시 |
| published external request | `waitingForYouRequestIds`에 stable request id | 재기동 뒤 같은 질문 재게시 |
| stop intent | settlement `settling`, ACK `stop_requested` | witness 전 `stopped` |
| continuity invariant breach | activity `not_running` + availability `blocked` | `running+delayed`, 완료 불가 stop 노출 |
| terminal 경합 | 첫 witness 결과 한 번 | late failure로 덮기 |
| stale request/interrupt | canonical no-effect | 다음 turn 재해석 |

v2 user-visible 진입은 durable admission 뒤 독립 runner가 준비될 때까지 기다린다. `semantics_version=2 AND executor_kind <> independent_runner`는 DB가 거부한다. 과거 v1 `legacy_in_process` 실행은 restart transparency 대상이 아니며 신규 생성은 v2 admission fence 전부터 차단한다. 그 제한을 투명성 달성으로 포장하지 않는다.

## 불변식에서 구조로의 매핑

### 실행 불변식 16개

| ID | 불변식 | 새 구조에서 위반이 불가능한 이유 | 강제 수단 |
| ---: | --- | --- | --- |
| E1 | session당 open execution 최대 1, identity 일치 | session open unique와 모든 receipt의 execution FK가 같은 key를 요구한다. | DB unique/FK |
| E2 | lifecycle 의미가 하나의 계약에서 나온다 | writable lifecycle은 `open|terminal`뿐이고 세부 phase는 한 declarative reducer가 receipts에서 생성한다. | generated TS/SQL/test |
| E3 | provisional spawn도 실행이다 | child는 open execution의 `RunnerAttempt.spawnReceipt`로만 생기며 attempt가 execution FK 없이 존재할 수 없다. | FK + receipt CAS |
| E4 | 새 identity가 옛 자원과 격리된다 | attempt namespace, attachment epoch, operation id가 effect 경계마다 검사된다. | DB/runner fence |
| E5 | 복구 가능한 소실 뒤 waiter가 책임과 진행을 잃지 않는다 | continuity certificate와 effect capability가 유효한 open row·operation은 due time을 잃지 않고 public delayed/internal receipt progress로 eventual settle을 관측한다. invariant breach는 적용 도메인 밖이며 E11·X2가 맡는다. | durable scan + no-starvation fixture |
| E6 | 회수는 restart·reserve·message와 독립이다 | 중앙 open execution scan이 유일한 시작점이고 모든 분기에는 due wake 또는 terminal record가 있다. | periodic scan + NOT NULL due |
| E7 | reference clear는 종료가 아니다 | witness, ingress, request engine application, cutoff-bound delivery resolution, 세 effect fence를 가진 `TerminalSafetyBarrier` 없이는 terminal CAS가 거부된다. | fixed record + procedure/FK |
| E8 | terminal은 멱등이고 visible 결과는 하나다 | open row가 monotonic witness→ingress→barrier prefix를 보유하고 별도 visible terminal CAS가 첫 outcome만 허용한다. | prefix CHECK + unique/CAS |
| E9 | active operation 관측은 실행과 함께 끝난다 | active operation set은 open execution·attempt·lease에서 계산되며 별도 mutable set이 없다. | projection |
| E10 | activation 실패는 같은 execution의 재시도 또는 exact 격리다 | attempt isolation, current pointer 해제, 하나의 cleanup obligation이 한 transaction이다. 격리 attempt는 다른 namespace와 effect fence를 가진다. | transaction + attempt/obligation unique |
| E11 | live child·open execution·unreachable host의 제3상태를 잃지 않는다 | coupled `ExecutionRecoveryProjection`이 attachment missing, identity unresolved, process absent, invariant breach를 각각 유효한 evidence와 묶는다. | discriminated union + reducer |
| E12 | rollback은 exact child를 대상으로 한다 | absence/isolation/cleanup receipt가 attempt id+spawn receipt FK+pid+start identity를 요구한다. latest sidecar 값은 입력이 아니다. | typed receipt + composite FK |
| E13 | retry 또는 명시적 책임이 남는다 | open execution에는 due time, physical resource에는 유일 `cleanup_obligation`이 있고 resolution 전 삭제할 수 없다. | NOT NULL/partial unique/FK |
| E14 | execution inventory는 registration과 독립이다 | open execution을 먼저 읽어 full outer join하므로 registration 0건도 회수 대상 0건으로 바뀌지 않는다. | query contract + fixture |
| E15 | acquire/release가 대칭이다 | attempt·attachment·writer·request를 만든 receipt마다 terminal safety 또는 cleanup obligation의 대응 receipt가 필요하다. exact child cleanup owner와 terminal 이후 current retention authority는 각각 하나뿐이다. | receipt matrix + procedure/unique |
| E16 | durable/process/memory 불일치는 한 의미 계약으로 분류된다 | declarative reducer가 facts를 projection/recovery variant로 바꾸고 메모리는 그 결과를 소비만 한다. | generated exhaustive reducer |

E5는 원문의 유한 settle을 무제한 worker fail-stop까지 보장하지 않는다. 정확한 적용 도메인은 continuity/effect certificate가 완전하고 recovery operation이 자동 실행 가능한 open execution이다. 그 안에서 fair scheduling·저장소 가용성 아래 eventual settle, public `delayed`, 내부 receipt의 단조 진행을 보장한다. `continuity_invariant_breach`는 eventual settle 대상이 아니며 즉시 `blocked`와 durable incident를 투영하고 수동 증거 복구 전 자동 effect를 금지한다. 구현은 continuous backlog에서도 ready key가 무한 추월당하지 않는 queue discipline을 선택하고 필수 backlog fixture로 고정한다.

### delivery 불변식 10개

| ID | 불변식 | 새 구조에서 위반이 불가능한 이유 | 강제 수단 |
| ---: | --- | --- | --- |
| D1 | 승인된 session input은 재전송 없이 다음 유효 execution에 도달 | witness cutoff 뒤 admission과 unassigned session input은 terminal barrier를 막지 않는다. 닫힌 target assignment만 release하고 pending delivery cancel이 없을 때만 append-only successor assignment를 만든다. request response는 stable request authority transfer를 따른다. | scope type + cutoff + delivery lock + durable head/wake |
| D2 | assignment는 concrete execution 또는 명시적 unassigned | append-only assignment history 각 row가 exact execution/generation/command payload를 갖고 unresolved row 0개가 unassigned다. current pointer는 projection이다. | partial unique + typed operation payload |
| D3 | consumption 최대 1, durable tombstone | assignment-local slot이 registration close/consume/cancel/target-terminal-release를 직렬화한다. delayed RPC는 capability/close epoch에 막히고 process death 뒤 certified recovery만 같은 slot을 완결한다. | runner slot unique/CAS + capability fence + coupled central FK |
| D4 | unknown assignment reconcile 전 재할당 금지 | 기존 history의 unresolved assignment가 있으면 새 ordinal 생성 procedure가 거부된다. `released_for_rebind` 뒤 session scope만 다음 ordinal을 허용한다. | partial unique + append-only ordinal |
| D5 | session FIFO skip 금지 | stored procedure만 head를 읽고 resolved receipt와 같은 transaction에서 다음 head로 전진한다. direct DML은 revoke된다. | head pointer + privilege fence |
| D6 | attachment/activation이 delivery를 다시 깨운다 | open execution reducer 변화가 due assignment scan의 wake를 갱신한다. ping은 전제가 아니다. | trigger/procedure |
| D7 | retry budget은 책임 종착지가 아니다 | operation은 resolved receipt 전 삭제되지 않고 다음 wake를 가진다. | FK + due CHECK |
| D8 | durable admission 또는 같은 receipt만 success ACK다 | route는 node 결과가 아니라 delivery/idempotency row의 `ReceivedInput`만 반환하며 CAS miss는 canonical reread한다. | generated API union + reread fixture |
| D9 | failure/no-effect 의미가 증명된다 | admission rejection은 durable proof, pre-registration no-effect는 typed close/revoke fence, cancel/consume는 runner disposition+central mirror, internal failure는 public outcome과 분리된다. | proof FK + coupled operation union |
| D10 | 판정은 exact assigned execution receipt만 쓴다 | consumption receipt에 delivery, execution, generation, command, assignment operation/capability, input sequence가 모두 필요하다. request application은 이 exact composite FK만 읽는다. | operation payload + composite receipt join |

### 축소 감사에서 복원·추가한 보장

불변식 26개만으로 r2→r3 삭제를 감사했을 때 다음 보장이 목록 밖이라 누락됐다. 이후 정본 삭제 검토는 이 항목과 r2 원문까지 함께 대조한다.

| ID | 보장 | 구조적 강제 |
| ---: | --- | --- |
| X1 | terminal witness 뒤 admission이 terminal과 교착하지 않는다 | witness cutoff, cutoff-bound barrier, unassigned session delivery 보존, append-only rebind fixture |
| X2 | certified replacement는 predecessor를 증명 가능하게 닫고 동일 public session lineage를 잇는다 | `continuity_transfer` record와 successor reservation의 단일 transaction, predecessor open→terminal CHECK |
| X3 | external request expiry/cancel이 runner engine까지 전달된다 | operation-owned central winner→runner `input_request_expired|cancelled` journal→engine application receipt, barrier FK |
| X4 | stale·변조 runner↔host request/response가 effect를 내지 않는다 | pre-send call receipt, sequence identity PK→operation/hash/payload 함수 종속, stable operation unique, attachment journal FK/current-epoch trigger |
| X5 | active-v1 cutover에 old/new writer가 동시에 유효하지 않다 | `PromotionHandoffFence`, command 전량 처분, old writer revoke·socket close, v2 grant의 단일 commit |
| X6 | terminal 이후 background semantic authority와 event route는 하나다 | source execution current `ExecutionRetention` partial unique, retention epoch lease·route unique, expired same-row higher-epoch takeover와 exact release CAS |
| X7 | pre-registration 종료 뒤 늦은 assignment write가 effect를 만들지 않는다 | assignment-local slot의 close/capability epoch, runner ack 또는 exact absence+revoke proof, stale registration trigger |
| X8 | request response의 application owner와 replacement authority가 하나다 | consumed assignment composite FK, request+terminal-prefix lock, continuity transfer의 request authority epoch CAS |
| X9 | public cancel/stop은 순간 assignment/execution이 아니라 stable 대상에 적용된다 | delivery-level cancel intent/winner, lineage-level stop binding, rebind/continuity transfer와 같은 row lock |

r5 구현 전 최소 게이트는 각각 X4의 runner-local accepted attachment epoch, X7의 assignment-local future-write fence/disposition slot, X8의 request application 단일 receipt chain, X9의 delivery-level cancel+lineage-level stop, X6의 retention takeover/release receipt다. 다섯 항목은 새 execution phase가 아니라 기존 stable fact owner와 composite proof로만 표현한다.

### 정본 축소와 사라지는 것

| 이전 설계·현행 | 최종 구조 | 변화 |
| --- | --- | ---: |
| Task optional 실행 필드 12개 | `TaskExecutionController`가 읽는 fact ledger | 12 writable → 0 |
| writable 9-phase execution union/DB phase | `LogicalExecution(open|terminal)` + generated projection | 9 writable → 2 logical states |
| spawn attempt phase + process permit + cleanup job + permit-cleanup 연결 | `RunnerAttempt` receipts와 derived capacity | 물리 lifecycle 4표현 → 1 |
| cleanup owner/job/permit owner/physical receipt owner/post-terminal maintenance | `cleanup_obligation` 하나, 나머지는 obligation id 참조 | cleanup authority 5 → 1 |
| `ExecutionCleanupBarrier` | `TerminalSafetyBarrier` | 물리 삭제가 아닌 effect safety로 의미 교정 |
| recovery saga phase·recovery context의 독립 필드 | coupled recovery projection + receipt operation | writable recovery phase 1 → 0 |
| delivery queued/assigned/reconciling/retry_paused/consumed 상태기계 | immutable delivery + append-only assignment + kind별 operation receipt | writable 상태 5+ → 단조 이력 |
| assignment별 cancel request/winner | delivery-level cancel intent + canonical delivery resolution | cancel authority N ordinal → delivery 1 |
| execution별 stop target | lineage-level stop invocation + movable binding epoch | replacement 경합 target N → lineage 1 |
| request response engine receipt + delivery consumption | exact consumed assignment composite FK | semantic application owner 2 → 1 |
| request publication 전용 saga + assignment 전용 흐름 | 공통 생성 schema의 coupled `IdempotentOperation` variants | cross-store 절차 2 → primitive 1 |
| runner↔host 식별자 prose·socket 신뢰 | generated call/response envelope + SQLite composite FK | stale wire 판정 경로 1 |
| active-v1 cutover 운영 순서 | `PromotionHandoffFence` receipt FK | writer 공존 가능 경로 1 → 0 |
| terminal 이후 “retention responsibility” 서술 | current `ExecutionRetention` authority + 기존 cleanup obligation | semantic owner 0 → 1, physical owner 추가 0 |
| stop/interrupt를 ordinary FIFO input으로 처리 | termination intent CAS / execution-scoped interrupt | scope 누출 1 → 0 |
| output exactly-once 주장 | at-least-once transport + semantic-id dedupe | 과장 제거 |
| raw 내부 failure를 외부 반환 | internal diagnostic + `PublicOutcome` | 의미 경계 1 |
| dispatcher `closed`, stream `ended/error` | witness→ingress→barrier→terminal | 분산 terminal writer N → 1 |
| user-visible in-process fallback | durable independent-runner placement wait | fallback 1 → 0 |
| owner-null→interrupted, proof 없는 replacement | identity projection + certificate-only replacement | 사용자-visible 손실 경로 2 → 0 |
| session-scoped PID 후보 병합 | attempt namespace | 이전 잔재 입력 경로 1 → 0 |

직접 field clear, phase assignment, dispatcher stream finish/fail, permit/job lifecycle mutation, recovery saga phase mutation은 삭제 대상이다. 관측용 화면에 phase가 필요하면 generated projection이나 materialized 관측 cache만 읽고, 권위 판단은 `observedAt`을 받은 reducer/SQL function으로 수행한다.

## 적용 순서

각 단위는 독립 커밋·review가 가능하고 capability gate 전에는 제품 의미를 바꾸지 않는다.

| 단위 | 변경 | 종료 시 관측 가능한 결과 | 호환 |
| --- | --- | --- | --- |
| 0. RED 기준선 | 정상 3종, 사고 2종, delivery 4종, #818 기준을 고정 | 제품 변화 없음 | 테스트 세션 |
| 1. declarative semantics | `execution_semantics.v2`에서 TS projection·runner↔host wire/SQLite schema·SQL invariant·transition fixture 생성 | 기존 fact를 shadow projection했을 때 현행 inspector와 비교 가능 | writable phase 미사용 |
| 2. caller identity·scope | stable delivery id와 `DeliveryScope`를 모든 caller에서 shadow 기록 | 동일 action 재시도 identity와 scope가 보임 | v2 ingress off |
| 3. additive fact schema | logical execution, attempt receipts, cleanup obligation, request/delivery ledger, operation receipts, terminal safety, attachment fence 추가 | v1 동작 동일, v2 procedure 호출 가능 | row별 semantics write fence |
| 4. 신규 legacy 차단 | v1도 durable admission을 먼저 쓰고 cutoff 뒤 신규 `legacy_in_process` 생성 거부 | 신규 legacy row 0, capacity 부재는 durable wait | 기존 active legacy만 grandfather |
| 5. runner fact·attachment | attempt namespace, stable launch, epoch command/host-call envelope fence, cleanup obligation을 shadow 검증 | split-brain·late response와 rollback이 receipt로 탐지됨 | v2 capability off |
| 6. cross-store operation | request publication·delivery assignment를 공통 operation으로 구동하고 scope/stop/expiry 계약 연결 | 모든 crash prefix가 같은 receipt로 재개됨 | route는 아직 v1 projection |
| 7. terminal·public semantics | witness→ingress→`TerminalSafetyBarrier`, current retention authority와 public projection·event dedupe 완성 | shadow에서 restart 전후 public trace가 동일 | v2 capability off |
| 8. active v1 promotion | eligible 독립 runner를 `PromotionHandoffFence`로 같은 PID·command·context의 v2 fact ledger에 승격 | old writer/socket 정산 뒤 현재 command에 새 scoped input bind | fence/certificate 없는 실행 제외 |
| 9. 단일 cutover | caller, DB, runner, attachment, operation, terminal, public reducer capability를 한 transaction에서 활성 | v2 session이 end-to-end 투명 경로 사용 | downgrade 금지, durable wait |
| 10. 구 writer 제거 | Task optional fields, phase writers, permit/job/saga, v1 delivery 상태 제거 | writable authority 축소 완료 | rollback window 종료 뒤 |

단위 5~7은 gate 뒤에서 함께 완성하고 단위 9에서 한 번만 활성화한다. ingress ACK가 attachment 투명화보다 먼저 v2 의미로 노출되는 창은 없다. shared fixture 하나를 fact-ledger factory로 바꾸면 adoption 계약 8개가 따라오고 옛 shape를 기대한 구조 화석 1개만 제거한다.

## DB 마이그레이션과 구·신 호환

DB 변경은 필요하지만 이 설계에서는 파일을 만들거나 적용하지 않는다. migration 이름은 `073_execution_turn_state_machine.sql`로 유지하고 다음 세 정본을 같은 구현 커밋에서 갱신한다.

1. `packages/db-schema/sql/migrations/073_execution_turn_state_machine.sql`
2. `packages/db-schema/migration-manifest.json`의 checksum·rollback compatibility
3. `packages/db-schema/sql/schema.sql`의 bootstrap 동형 정의

### 최종 중앙 스키마

`session_execution_ownerships`는 이름을 rolling 동안 유지하되 logical execution ledger 역할을 한다.

- `execution_id` unique, `semantics_version`, `executor_kind`
- `logical_state IN ('open','terminal')`. 세부 phase 컬럼 없음
- reservation receipt, `current_attempt_id`, attachment grant/epoch/lease
- lineage-owned termination intent FK, terminal witness, ingress receipt, terminal safety barrier
- progress receipt, `reconcile_due_at`
- session별 `WHERE logical_state='open'` unique
- v2면 `executor_kind='independent_runner'`
- open row는 monotonic terminal prefix를 허용한다: witness null이면 ingress·barrier도 null, ingress non-null이면 witness 필수, barrier non-null이면 witness·ingress 필수다. barrier 뒤에도 별도 visible commit 전까지 logical state는 open이다
- terminal safety barrier는 cutoff 값을 복제하지 않고 `(execution_id, witness_id)` composite FK만 저장한다. delivery cutoff는 witness row에서 파생한다
- visible terminal이면 witness·ingress·barrier FK가 모두 non-null이다. `continuity_transfer` terminal이면 certificate, successor execution, input/outbox/host-call watermark, effect inventory, old authority fence가 모두 non-null이고 public reducer는 successor lineage를 따른다. migration archival terminal이면 successor FK·proof receipt·effect-fence receipts가 non-null이고 public projection이 금지된다
- `execution_semantics_v2_projection` generated regular view/SQL function은 declarative reducer가 만든다. transaction `observedAt`을 입력받는 권위 판정이며 application writer 권한이 없다. materialized copy는 관측용으로만 허용한다

별도 durable relation은 다음 축뿐이다.

- `runner_attempts`: reservation, spawn, ownership, activation, isolation, physical absence receipt와 cleanup obligation FK. mutable phase·cleanup lease 없음
- `cleanup_obligations`: resource unique, effect-fence receipt, lease/claim/wake, physical resolution. cleanup 권한 정본 하나
- `session_deliveries`: stable id, immutable canonical JSONB payload+hash, `DeliveryScope` columns, enqueue/admission 시각, delivery-level cancel intent와 canonical resolution receipt FK. mutable current-assignment pointer와 assignment-level cancel owner 없음
- `session_delivery_assignments`: delivery별 append-only ordinal, exact execution/generation/command, operation FK, final assignment receipt FK. delivery당 unresolved row partial unique
- `session_delivery_heads`: session FIFO head. head 변경은 consumption/cancel/no-effect resolution과 같은 procedure transaction
- `external_requests`: stable request/lineage identity, current authority execution+epoch, semantic event id, operation FK와 owner publication/resolution/application proof FK. proof 본문·시각 copy 없음
- `idempotent_operations`: kind별 typed payload, operation id/payload hash, claim epoch/lease/next wake, exact-store stage receipt의 단일 owner
- `execution_promotion_handoff_receipts`: active-v1 accepted command 전량 처분, old writer revoke, old socket close와 exact v2 prepared grant. `session_execution_semantics`는 receipt FK만 보유
- `execution_retentions`: terminal 이후 semantic authority의 current owner/epoch/lease, background task inventory, 유일 event route, authority transfer/release receipt와 기존 cleanup obligation FK. expired row는 같은 row의 higher-epoch CAS로 takeover하며 physical cleanup authority는 보유하지 않음

runner SQLite에는 generated `runner_attachment_journal_v2`, `runner_host_calls_v2`, `runner_host_responses_v2`, `runner_assignment_disposition_slots_v2`와 `runner_current_attachment_v2` regular projection이 생긴다.

- journal은 epoch accept/revoke receipt의 append-only owner다. `(execution_id, execution_command_id, attachment_epoch, attachment_grant_id, receipt_kind)` key와 monotonic epoch trigger를 가진다.
- call PK는 `(execution_id, execution_command_id, attachment_epoch, host_call_sequence)`이고 `request_receipt_id`와 `operation_id`는 각각 immutable unique다. `operation_id`, canonical payload/hash, grant는 PK row의 값이다. UPDATE/DELETE와 direct INSERT는 금지한다.
- call은 wire send 전 generated insert procedure가 canonical payload hash를 계산해 commit한다. call의 epoch/grant는 accepted journal receipt FK를 가져야 하고 insert/effect trigger는 `runner_current_attachment_v2`와 exact equality를 요구한다.
- response는 call PK와 `request_receipt_id`를 FK로 참조한다. operation id·request payload hash·grant 불일치는 trigger가 거부하며 response result hash는 별도 값이다.
- assignment slot은 `(assignment_id, operation_id)` PK, monotonic `assignment_capability_epoch/highest_claim_epoch`, nullable inbox receipt와 exactly-one final disposition/close receipt를 가진다. generated registration procedure는 stale claim/capability와 `closed_before_registration` 뒤 insert를 거부한다. exact-absence central revoke watermark는 runner endpoint open 전 local close tombstone으로 import해야 하며, recovery writer는 exact continuity certificate+higher capability composite FK가 있을 때만 기존 registered slot을 dispose할 수 있다.

이 relation은 중앙 execution row의 복사본이 아니라 runner-local attachment/call effect admission journal이다. 중앙 host-call settlement는 이 receipt watermark만 참조한다.

capability와 continuity를 위한 기존 계획 relation은 남는다.

- `execution_continuity_certificates`: effect boundary sequence, checkpoint, input/outbox/host-call watermark, request/head, effect receipts
- `execution_host_capabilities`, `execution_runner_capabilities`, `execution_ingress_capabilities`
- `session_execution_semantics`와 `execution_semantics_control`: stable lineage id, current open execution pointer, lineage stop invocation/binding epoch의 단일 owner
- terminal event ingress receipt와 semantic event id unique

삭제되는 계획 table은 `execution_reconcile_jobs`의 saga phase, `execution_runner_process_permits`, `execution_spawn_cleanup_jobs`, `execution_post_terminal_maintenance`다. reconcile scheduling은 open execution의 `reconcile_due_at`, 물리 cleanup의 claim·lease·wake와 책임은 `cleanup_obligations`에만 있다. node capacity는 `runner_node_process_capacity`의 limit 설정과 attempt receipt count를 잠그는 procedure로 계산한다.

application role의 execution, attempt, cleanup, delivery/head, request, operation direct DML은 revoke한다. procedure가 강제하는 핵심 제약은 다음과 같다.

- `session_reserve_execution_v2`: session open unique, capability, independent executor
- `session_record_runner_attempt_*_v2`: receipt는 null→value만, stable launch operation당 child 최대 1
- `session_isolate_attempt_v2`: isolation+current pointer 해제+단일 cleanup obligation+successor wake
- `session_claim_cleanup_obligation_v2`: monotonic claim epoch와 stable physical operation
- `session_prepare/commit_attachment_grant_v2`: higher epoch와 gap-free accepted command disposition
- `session_promote_execution_v2`: native epoch barrier 또는 legacy detach barrier의 command 전량 처분·old writer revoke·old socket close를 검증하고 v2 writer grant와 cutover를 원자 commit
- `session_transfer/renew_execution_retention_v2`: old attachment/writer revoke 뒤 source execution당 current retention 하나와 unique event route를 만든다. unexpired row는 exact epoch owner만 renew하고, expired row는 `expectedAuthorityEpoch → +1` owner/lease/route-epoch 단일 CAS로 eligible successor가 takeover한다. exact epoch owner 또는 certified cleanup만 release receipt+releasedAt을 함께 commit한다
- `session_accept_input_v2`: stable id/payload/scope admission
- `session_prepare/resolve_operation_v2`: kind별 payload, exact-store receipt 순서, operation/payload composite FK, monotonic claim
- `session_publish_external_request_v2`: publication receipt와 immutable `publishedAt/expiresAt`을 한 commit에 기록
- `session_resolve_external_request_v2`: request authority+deadline+lineage terminal prefix를 같은 lock order로 잡는다. witness first는 witness FK를 가진 execution_finished no-effect, response first는 request-scoped delivery+exact consumed assignment composite FK다. expiry와 user/owner cancel은 runner journal·engine application receipt를 검증한다
- `session_create_delivery_assignment_v2`: delivery cancel intent를 먼저 잠그고 append-only ordinal, unresolved partial unique, assignment operation/claim/capability epoch를 만든다. witness cutoff 뒤 current target assignment와 pending cancel delivery rebind를 금지한다
- `session_request_delivery_cancel_v2`: stable delivery row에 invocation을 CAS한다. assignment 유무·ordinal과 무관하며 final winner가 없으면 rebind보다 우선한다
- `session_resolve_delivery_v2`: runner slot disposition 또는 typed close-before-registration/exact-absence+capability-revoke proof를 검증하고 scoped no-effect/rebind와 head advance를 commit한다. consume가 먼저인 경우 외 pending delivery cancel은 central cancelled이고 rebind 금지다
- `session_request_stop_v2`: stable lineage/invocation intent를 current open execution에 bind한다. continuity transfer와 같은 lineage lock을 사용하고 binding epoch 하나만 허용한다
- `session_record_terminal_witness_v2`: first witness와 현재 delivery admission cutoff를 한 CAS로 기록
- `session_commit_terminal_safety_v2`: barrier의 witness FK에서 cutoff를 읽고 witness watermark, request/delivery/stream/host-call resolution, effect-fence, retention authority, cleanup owner 검증
- `session_commit_execution_terminal_v2`: witness→ingress→barrier 뒤 first visible terminal
- `session_replace_execution_v2`: predecessor `continuity_transfer`, successor reservation, pending request authority epoch transfer, lineage stop binding을 원자 commit한다. complete continuity certificate required

같은 exact child의 active cleanup obligation은 partial unique 하나다. terminal barrier가 live fenced child를 참조하면 기존 obligation id와 같아야 하고 새 post-terminal child obligation insert는 procedure가 거부한다. child/retention의 `released`는 never-acquired/exact absence만, live fenced child는 retained+obligation만 허용한다. attachment/writer의 acquired 뒤 `released`는 fence와 physical release receipt를 모두 요구한다. 모든 `transferred`는 old revocation, transfer receipt, new authority id/epoch, 기존 obligation FK를 함께 요구한다.

retention/background runtime은 terminal 뒤에도 attachment를 유지할 수 있지만 authority가 모호하지 않다. barrier 전에 old execution attachment/writer epoch를 revoke하고 `execution_retentions` current row를 authority transfer receipt와 함께 commit한다. `UNIQUE(source_execution_id) WHERE released_at IS NULL`과 `UNIQUE(event_route_id) WHERE released_at IS NULL`이 current owner와 semantic event route를 각각 하나로 고정한다. 모든 background event/effect는 `(retention_id, authority_epoch)`를 가지고, unexpired current lease와 task inventory에 모두 들어 있을 때만 ingress가 받는다. terminal safety의 transferred receipt는 이 row의 id/epoch와 기존 cleanup obligation FK를 함께 가리킨다.

retention maintenance scan은 terminal logical row와 무관하게 unreleased current row를 읽는다. owner fail-stop으로 lease가 만료되면 takeover branch가 row lock+expected epoch CAS로 owner/epoch/lease/event-route epoch만 교체한다. task inventory, route id, transfer provenance, cleanup obligation은 보존한다. 두 host 중 하나만 `+1`에 성공한다. 모든 task 종료와 exact effect fence/absence가 증명되면 current epoch owner 또는 certified cleanup worker가 같은 row에 typed `ExecutionRetentionReleaseReceipt`를 commit하고 event route를 닫는다. release와 takeover/renew가 경합해도 row lock의 한 winner만 남고 release 뒤 higher epoch 취득은 불가능하다.

### migration 073의 라이브 데이터 순서

2026-08-23 실측 기준 기존 row는 6,319개다: active 2, identity_proven 2, reserved 1, failed 5,804, terminal 510. 새 세 컬럼은 없다. 구현 직전 같은 query를 다시 실행한다.

1. `execution_id`, `semantics_version`, `executor_kind`, logical/receipt/lease/due 필드를 nullable로 추가한다. 새 table과 NOT VALID 제약을 만든다.
2. v1 writer를 compatibility procedure로 감싸 신규 row도 즉시 version/executor/deterministic execution id를 받게 하고 direct DML을 revoke한다.
3. 기존 row를 bounded batch backfill한다. open v1 row는 `logical_state='open'`과 non-null `reconcile_due_at`, terminal/failed는 proof-bearing terminal/archival form으로 채운다.
4. open row의 runner/sidecar 증거에서 initial `RunnerAttempt`를 backfill한다. unresolved physical resource에는 하나의 cleanup obligation을 만든다.
5. session별 duplicate open row는 canonical current 하나만 open으로 보존한다. predecessor를 다른 open projection인 recovering/terminating으로 옮기지 않는다. effect-fence·terminal/absence proof가 있으면 `TerminalLogicalExecution(kind="migration_archival")`로 옮기고 successor FK·proof receipt·effect-fence receipts를 채운다. 이 branch는 current pointer와 public projection 대상이 될 수 없다. proof가 없으면 migration을 중단해 수동 증거 복구 후 재실행한다. migration 전용 writable phase나 quarantine table은 만들지 않는다.
6. null, duplicate id/open row, open without due, terminal without visible trio·continuity transfer proof·migration archival proof 중 정확히 한 branch, attempt receipt shape, duplicate cleanup owner를 각각 0건으로 확인한다.
7. version별 CHECK를 validate한 뒤 `execution_id/semantics_version/executor_kind/logical_state`를 NOT NULL로 전환하고 unique/partial unique를 건다.
8. migration transaction 바깥에서 generated reducer 결과와 legacy read projection을 전수 비교한다.

기존 6,319행 때문에 nullable→backfill→validate→NOT NULL 순서를 바꿀 수 없다. active open 5개 같은 실측 숫자를 migration logic에 하드코딩하지 않는다.

### active v1 실행의 in-place 승격

eligible active v1 independent runner는 drain이나 replacement 없이 같은 execution id, PID/start identity, command id, manifest, engine context, input/outbox watermark를 보존해 승격한다.

1. host가 runner bootstrap·journal을 shadow-read해 attachment fence, deterministic input/outbox/host call, effect-boundary continuity capability를 증명한다.
2. native epoch runner는 higher epoch `RunnerAttachmentBarrierReceipt`를 준비한다. additive legacy runner는 accepted sequence `1..acceptedThrough` 각각을 정확히 한 번 settled/transferred로 열거하고 `outstandingUnaccountedCommands=0`, old writer revoke, old socket close receipt를 가진 `LegacyDetachBarrierReceipt`를 준비한다.
3. `PromotionHandoffFence`가 native barrier 또는 legacy detach barrier를 exact v2 prepared grant와 묶는다. DB는 fence receipt와 execution/attempt/attachment/request/delivery facts, session semantics cutover epoch를 한 transaction에 commit한다. v2 writer lease는 이 commit 전에는 유효하지 않다.
4. current session head가 있으면 같은 command를 대상으로 assignment operation을 prepare한다. activating이면 activation receipt 뒤 wake만 남긴다.
5. commit 후 새 attachment만 command writer가 된다. old writer/socket에서 뒤늦게 들어온 command·host response는 generated envelope epoch가 fence보다 낮아 effect 전 stale no-effect가 된다.

`execution_promotion_handoff_receipts`가 receipt 본문의 단일 owner이고 `session_execution_semantics.promotion_handoff_receipt_id`는 FK만 가진다. `session_promote_execution_v2`만 이 relation을 쓸 수 있으며, legacy branch는 command disposition의 gap·duplicate, `outstandingUnaccountedCommands <> 0`, old writer revoke 누락, old socket close 누락 중 하나라도 있으면 cutover를 거부한다. deferred constraint가 같은 execution에 v1 writer-valid row와 v2 attachment-valid row가 동시에 commit되는 것을 금지한다.

exact identity, complete promotion fence, continuity certificate 중 하나라도 없으면 승격·replacement를 하지 않는다. 기존 `legacy_in_process`는 host와 운명을 같이하므로 완전 투명성 대상이 아니다. 신규 생성은 단위 4에서 차단하고 기존 row가 끝날 때까지 그 node/session의 계획 restart capability를 열지 않는다. 이 제한을 투명한 handoff라고 부르지 않는다.

### rolling coexistence

`semantics_version`은 DB write fence다. v1 procedure는 v2 row를 reserve/activate/terminate하지 못하고 v2 procedure는 live host/runner/caller capability를 요구한다. v1 binary의 늦은 재접속·rollback·부분 배포도 DB에서 거부된다. legacy `state/aggregate_state`는 v2 row에 대해 generated read projection일 뿐 v1 writer가 수정할 수 없다.

orch는 unexpired v2 capability를 가진 host/runner에만 v2 session을 보낸다. 없으면 admission된 input이 durable wait하며 v1로 downgrade하거나 실패하지 않는다. session cutover는 모든 capability와 `PromotionHandoffFence` FK를 한 transaction에서 확인한다. legacy 승격이면 `outstandingUnaccountedCommands=0`, old writer revoke, old socket close가 모두 증명되지 않는 한 v2 writer를 열지 않는다. rollback은 이미 열린 v2 execution을 v2 host가 계속 맡으며 v1 binary로 강제 인계하지 않는다.

## 검증자가 확인할 구현 결정

구조는 동결하되 두 구현 primitive는 선택이 남아 있다.

1. no-starvation scheduler: continuous 신규 backlog에서도 ready reconcile/cleanup key가 무한 추월당하지 않아야 한다. aging/queue discipline과 최대 추월 metric은 구현에서 정하고 backlog fixture를 반드시 통과한다.
2. one-shot launcher: DB authorization 뒤 OS spawn 직전 fail-stop과 claim expiry가 겹쳐도 stable launch operation 하나가 물리 child를 최대 하나만 만들어야 한다. pidfd helper, 전용 launcher 등 구현은 선택할 수 있지만 두 process가 생기는 방식은 설계 위반이다.

capability cutover 단위를 session 또는 node 중 어디에 둘지는 운영 선택이지만 정확성 조건은 같다. DB cutover CAS가 unexpired caller/host/runner/continuity capability를 모두 검사해야 한다.

## 설계 검증 및 3단계 RED 조건

- declarative schema 하나에서 `TaskExecutionProjection`, coupled `ExecutionRecoveryProjection`, orthogonal `PublicSessionProjection`, kind별 coupled `IdempotentOperation`, delivery cancel/lineage stop/request authority transfer, runner assignment disposition slot, `reduce(facts, observedAt)`, SQL regular view/invariant function, transition fixture가 생성되고 writable phase 컬럼이 없어야 한다. generation 뒤 diff CI가 깨끗해야 한다.
- projection receipt 조합 전수에서 reserved/provisional/activating/active, waiting/applying request 집합, recovering, settlement, terminal이 서로의 독립 사실을 숨기지 않고 계산되어야 한다.
- 기존 #818 기준을 재현한다: `origin/test/runner-execution-invariants`의 `docs/runner-execution-invariants.md` 명령, `e5d66742` 기준 runner recovery targeted suite. 2-1 shared fixture 한 곳 변경으로 8계약 유지·구조 화석 1개 제거, 2-2 기존 green 파단 0, 2-3 decision table 37 passed를 기준선으로 삼는다.
- 정상 steady-state, pure adopt, restart-intervention-window가 같은 orthogonal public projection 변화와 semantic event 순서를 보여야 한다. execution A running과 delivery B received, waitingForYou와 applyingResponse, terminal settlement가 서로를 가리지 않아야 한다. 현재 503·intervention/context event 소실은 RED다.
- request publication failpoint를 journal 후/central register 후/event publish 후/central winner 후와 response-vs-expiry에 둔다. responded는 exact delivery consumption composite FK 하나, expiry/cancel은 runner journal→engine application chain 하나로만 완결되어야 한다.
- delivery assignment failpoint를 assignment intent 후, **registration RPC send→central close/revoke final→delayed SQLite insert**, runner inbox 후 process death→certified recovery disposition, runner consume commit 직후, 중앙 resolve 직전 cancel, head advance 직전에 둔다. stale claim/capability insert는 effect 전에 거부되고 같은 delivery id는 한 input sequence에만 소비되어야 한다.
- `target terminal release vs delivery-level user cancel vs runner disposition` 3자 경합을 모든 commit 순서로 고정한다. runner cancel이 이기면 central cancelled 하나뿐이고 successor assignment는 0개다. target release가 먼저여도 pending cancel이 있으면 rebind 전 delivery lock에서 cancel이 이기며, consume가 먼저일 때만 cancel/release가 canonical consumed를 재조회한다.
- pre-registration fixture는 cancel/no-effect/rebind exact variant와 typed registration fence만 허용한다. cancel intent+no-effect/rebind, cancel intent 없는 cancelled, 다른 assignment/operation/capability의 close ack, revoke 없는 absence proof, close epoch 뒤 delayed insert는 generated type·SQLite/central invariant에서 RED여야 한다.
- publication transaction이 `publishedAt/expiresAt`을 함께 쓰는지 검증한다. deadline 전 response를 admission하고 consumer를 300초 뒤 재개해도 `applied`여야 한다. expiry worker를 멈춘 채 deadline 뒤 response를 먼저 보내도 `not_applied(expired)`여야 하며 request 공개 전 clock은 진행하지 않는다.
- session/execution/request scope 각각 closed target을 시험한다. session input만 다음 execution으로 이동하고 interrupt는 canonical no-effect다. pending request는 certified replacement의 typed authority transfer 뒤 같은 request id/current epoch answer가 exact 한 번 적용되어야 한다.
- stop을 reserved/provisional/activating/active에 주입하고 ACK는 항상 `stop_requested`, public stopped는 witness+barrier+visible commit 뒤 한 번이어야 한다. `public control read → continuity transfer → same lineage stop invocation`의 모든 lock order에서 predecessor/successor 중 한 binding만 남아야 한다.
- unassigned/capacity-wait, registered, target-release 직후와 `public control read → continuity transfer/rebind` 사이 각각에서 같은 delivery cancel invocation을 보낸다. consume가 먼저인 경우 외에는 delivery final이 cancelled이고 successor assignment가 0개여야 한다.
- `waiting_for_you → process absence → certified replacement → answer`를 고정한다. request authority epoch transfer, response delivery scope, consumed assignment composite FK가 같은 successor를 가리키고 질문 재게시·not_applied(execution_finished)·중복 input sequence가 없어야 한다.
- witness/response 경합의 모든 commit order를 고정한다. witness first면 `not_applied(execution_finished)`와 response delivery 0개, response first면 witness가 뒤따라도 application receipt 전 terminal safety barrier가 거부되고 application 뒤 visible terminal로 진행해야 한다.
- `witness commit → session input admission → current barrier/visible terminal → successor reserve/bind → same delivery exactly-once consume`를 고정한다. witness cutoff 뒤 delivery와 unassigned session delivery는 predecessor barrier를 막지 않고, predecessor assignment는 release history를 남겨야 한다.
- output transport에 동일 semantic event를 중복 replay하고 web/app reducer가 effectively-once 렌더링하는지 검증한다.
- terminal failpoint는 witness commit, ingress watermark, 각 의미 resolution, 세 effect fence, barrier, visible terminal 사이에 둔다. 어느 prefix에서도 출력 유실·false terminal·중복 terminal이 없어야 한다.
- terminal prefix fixture는 open row의 `witness only`, `witness+ingress`, `witness+ingress+barrier`를 모두 허용하고 역순·누락 prefix를 거부한다. controller의 safety commit은 visible terminal을 만들지 않고 별도 visible commit만 finished를 투영해야 한다.
- resource safety fixture는 exact child의 `released+attempt_capability_fenced`, 다른 obligation id, 같은 child의 post-terminal obligation을 거부한다. attachment/writer `released+fence`에는 physical release receipt가 필수이고, 모든 transferred에는 old revocation+new authority/epoch+obligation이 필수여야 한다.
- N회 rollback은 OS exact process 수가 unresolved spawned attempt 수와 같고 node limits 이하인지 확인한다. isolated attempt는 다음 attempt identity/effect 후보가 아니며 cleanup obligation은 exact child당 하나다.
- attachment quiesce 직전 accepted command 전량이 settled/transferred로 처분되고 higher epoch 뒤 old intervention/interrupt/close/host response가 effect 전 no-effect 되는지 검증한다.
- generated runner↔host wire fixture는 pre-send canonical call row 뒤 같은 identity key의 operation id·payload/hash·grant를 하나씩 바꾼 INSERT/frame을 모두 거부한다. 같은 stable operation id를 다른 sequence에 넣는 경우, receipt 없는 frame이 먼저 host effect entrypoint에 도착하는 경우도 RED다. request effect 직전 journal revoke/higher epoch와 old request에 대한 late response는 current-attachment projection·call FK에서 stale no-effect여야 한다.
- active-v1 promotion fixture는 accepted sequence 전량 처분, `outstandingUnaccountedCommands=0`, old writer revoke, old socket close와 v2 prepared grant가 한 `PromotionHandoffFence`에 있을 때만 통과한다. 각 receipt 하나를 제거하거나 cutover commit 직전 old command를 주입하면 v2 writer가 열리지 않아야 한다.
- live attachment/background retention terminal은 old execution authority revoke→current `ExecutionRetention` transfer→successor new epoch 순서를 지켜야 한다. owner fail-stop 뒤 expired same-row takeover와 exact release를 경합시켜 한 CAS만 이기게 한다. takeover는 task/route/obligation을 보존하고 release는 receipt+releasedAt을 함께 쓰며 이후 renew/takeover/event/effect를 모두 거부해야 한다.
- runner process absence replacement은 every-effect-boundary certificate가 완전할 때만 통과한다. predecessor `continuity_transfer`와 successor reservation은 원자적이고 public lineage는 끊기지 않아야 한다. receipt 하나를 제거하면 activity not_running+availability blocked가 되고 replacement·false terminal·완료 불가 stop control이 없어야 한다.
- external effect commit 직후 certificate commit 전 failpoint를 둔다. same-transaction receipt 또는 stable provider operation lookup으로 결과를 복원하지 못하는 backend는 replacement capability 발급 자체가 실패해야 한다.
- 같은 facts에 `observedAt`만 TTL 전/후로 바꿔 reducer와 SQL function 결과가 함께 바뀌는지 검증한다. stale materialized projection을 authority로 사용하면 RED다.
- admission 뒤 source memory를 비우고 durable canonical JSONB payload만으로 runner inbox replay를 재구성해 payload hash와 semantic input이 같아야 한다.
- duplicate open migration fixture는 canonical 하나만 open이고 predecessor는 proof-bearing archival terminal로 이동한다. proof가 없으면 migration 자체가 실패하며 open unique를 우회하지 않는다.
- 6,319행 fixture로 nullable→backfill→validate→NOT NULL을 dry-run하고 concurrent v1 insert도 null row를 만들지 않아야 한다.
- no-starvation backlog와 one-shot launcher TOCTOU fixture는 구현 primitive 선택과 무관하게 필수다.
- 제품 코드 구현 전에 migration forward/rollback compatibility, direct DML revoke, v1→v2 write 거부, capability routing을 별도 검토한다.

## 중간 결론

재기동 투명성은 recovery 상태를 더 촘촘히 이름 붙여 얻지 않는다. logical execution, attempt receipt, attachment lease, scoped delivery/request, terminal safety라는 적은 수의 durable fact를 남기고 나머지를 한 reducer의 projection으로 만들 때 정본이 하나가 된다.

정상과 재기동은 같은 admission·assignment·output·terminal receipt를 통과한다. 따라서 재시작 유무가 입력 승인 의미, 출력, 최종 결과, 필요한 사용자 조작을 바꾸지 않는다.
