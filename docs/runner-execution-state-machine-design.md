# 실행 턴 1급 상태기계 재설계

기준 커밋: `e5d66742` (2026-08-23, PR #819 포함)

상태: 설계 13차 범위 분리·오펀 spawn 실사고 보정본. 1단계 구현 대상인 **Core v2**는 delivery 종착, live-runner host-restart 창, 새 runner 진입을 영구 차단하는 failed-attempt residue를 다룬다. dead-runner execution inheritance, terminal background retention, active-v1 promotion은 기존 설계를 보존하되 Core reducer 밖의 optional capability로 내렸다. 제품 코드, DB 마이그레이션, 배포는 이 문서의 범위가 아니다.

## 판정 기준

이 설계의 성공 조건은 하나다.

> **재시작 유무가 입력 승인 의미·출력·최종 결과·필요한 사용자 조작을 바꾸지 않는다.**

따라서 “실패를 정직하게 알렸다”, “큐에 넣었다고 알려 줬다”, “다시 보내면 된다”는 수용되지 않는다. 정상 경로와 재기동 경로가 같은 입력 승인 계약, 같은 출력 스트림, 같은 최종 결과를 사용해야 한다.

이 transparency 판정은 **runner가 살아 있고 command plane이 응답하는 host restart**에 적용한다. exact runner death 또는 bounded command-plane probe가 증명한 무응답은 같은 실행의 성공을 가장하지 않고 distinct `runner_lost`로 정산하는 failure boundary다. 다만 그 전후 어느 경우에도 durable admission된 delivery를 삭제하거나 `uncertain`으로 종결할 수는 없다.

## 구현 범위와 capability 경계

랩에서 `restart-adopt`가 GREEN이었다. 살아 있는 runner가 같은 execution·command를 계속 실행하는 기본 재부착은 이미 성립한다. 7일 라이브 DB에서는 사용자 메시지 200건 중 20건(10%)이 소비되지 않았고, 우리 노드 runner death는 5건이었다. 반면 `pid evidence disagrees`는 30건이었고 260824 세 번째 라이브 고착에서 activation rollback이 남긴 오펀 child가 같은 결함을 다시 만들었다. 따라서 1단계는 process replacement가 아니라 **접수된 delivery를 소비 또는 증명 가능한 종결로 수렴시키고, failed attempt의 잔재가 그 수렴에 필요한 다음 runner를 영구 차단하지 못하게 하는 일**이다.

| 구획 | 보장 범위 | 현재 상태 | 구현 진입 gate |
| --- | --- | --- | --- |
| **Core v2** | delivery의 consumed/no-effect 수렴, live runner same-execution adopt, failed-attempt child 격리·회수, runner absence/무응답의 `runner_lost` 정산과 unconsumed session delivery 보존 | **1단계 구현 대상** | 아래 Core 8 fixtures와 runner-lost 경계 fixture GREEN |
| **Capability A — certified runner replacement** | 죽은 runner의 in-flight execution·request·effect를 successor가 이어받음 | 설계 보존, Core 밖 | every-effect-boundary certificate, stable external effect lookup, pending request authority transfer, replacement failpoints |
| **Capability B — terminal background retention** | visible terminal 뒤 background task authority takeover·release | 설계 보존, Core 밖 | retention lease/route unique, task별 terminal proof, takeover/release fixtures |
| **Migration — active-v1 promotion** | 실행 중 v1 writer를 same execution/command v2 writer로 승격 | 설계 보존, Core 밖 | promotion handoff fence, command 전량 정산, old writer/socket revoke, rolling capability fence |

Core v2의 단일 목표는 다음 문장이다.

> **접수된 delivery가 확실히 소비되거나, 소비될 수 없으면 증명 가능한 이유로 정직하게 종결된다.**

Core v2는 이를 위해 다음 일곱 사용자 관측과 하나의 runner 진입 불변식을 보장한다. delivery 경계 세 개를 먼저 둔다.

1. 재부착 중 들어온 input은 durable admission 뒤 기다리고 같은 runner input sequence로 정확히 한 번 소비된다.
2. 공개된 질문·approval과 `waiting_for_you`가 restart를 관통하며 같은 request 답변이 적용된다.
3. terminal witness와 outbox 전송 사이 restart에도 completion delivery와 final outcome이 각각 한 번 종결된다.
4. 실행 중 host가 재시작되어도 live runner의 `executionId`, `executionCommandId`, process identity가 유지된다.
5. runner outbox는 watermark부터 replay되고 semantic event id로 effectively-once 렌더링된다.
6. current-execution stop intent는 restart 중에도 durable하고 같은 execution에 적용된다.
7. 위 경계를 연속 N회 통과해도 사용자 재전송·재클릭이 없다.
8. activation rollback이 child 종료에 실패해도 그 attempt는 즉시 canonical join에서 격리되고 durable cleanup 책임을 남긴다. 잔재 PID는 다음 attempt의 identity 입력이 될 수 없다.

canonical runner process의 exact absence 또는 exact attempt에 대한 bounded command-plane 무응답이 증명되면 Core v2는 현재 in-flight execution을 canonical `runner_lost` outcome으로 정산한다. 무응답은 assistant/tool progress의 부재가 아니라 IPC reconnect와 health probe의 bounded 소진으로만 판정하며 `waiting_for_you`의 정상 정지를 포함하지 않는다. host의 in-memory execute promise는 IPC 오류로 reject하지 않고 durable logical execution의 terminal projection을 구독해 `runner_lost`에서 한 번 settle한다. 이미 consumed인 delivery는 그 receipt를 중앙에 mirror하고, 미소비 session-scoped delivery는 delivery resolution을 닫지 않은 채 assignment만 release해 FIFO에 보존한다. 그런 뒤 **새 runner·새 execution**이 평상시 admission 경로에서 그 delivery를 받는다. execution/request-scoped delivery는 exact `no_effect(reason=runner_lost)`로 끝난다. stable identity가 아직 불명확하면 그때만 `blocked(reason=runner_identity_unresolved)`이고, 가짜 `running`·completed·failed로 꾸미지 않는다. 죽은 runner의 context·pending request·external effect를 successor에게 상속하는 자동 replacement는 Capability A가 열리기 전에는 금지한다.

### Core v2 durable fact 판정

외부 제안의 여섯 fact는 뼈대로 옳지만 Core fixtures 4~6을 판정하기에는 세 축이 부족하다. 최종 Core 정본은 다음 아홉 묶음이다.

1. `CoreLogicalExecution(open|terminal)`과 단조 terminal prefix
2. `(executionId, executionCommandId, attemptId, pid, startIdentity)`를 묶은 stable `RunnerAttempt`, attempt별 state namespace, exact absence/무응답 proof, rollback isolation과 단일 cleanup obligation
3. 중앙 prepared/committed attachment grant와 runner-local accepted epoch journal
4. durable delivery payload·assignment inbox·runner input sequence·delivery-level cancel receipt
5. external request publication/resolution/application ledger와 request-keyed `InputApplicationResult`
6. current execution에 bind된 durable lineage termination intent
7. durable runner outbox와 중앙 event ingress cursor·semantic event id unique
8. runner-origin/preactivation/runner-lost terminal witness→ingress receipt→Core `TerminalSafetyBarrier`→visible terminal CAS
9. restart를 가로지를 수 있는 **Core 지원 tool/host-call**의 stable semantic operation/result receipt

9번은 arbitrary provider exactly-once를 뜻하지 않는다. Core는 host DB와 같은 transaction에서 effect+result를 commit할 수 있거나 effect가 없는 read/replay operation만 허용한다. fixture 2를 이 ledger 지원 tool로 실행할지 runner-local/effect-free tool로 제한할지는 구현 결정 C다. 어느 쪽이든 fixture가 선택하지 않은 arbitrary provider effect에는 Core 보장을 주장하지 않는다. `stable_provider_lookup`과 process replacement를 위한 전 effect inventory는 Capability A gate다.

기존 구조 항목의 Core/이관 판정은 다음과 같다.

| 구조 항목 | Core v2 | Optional capability |
| --- | --- | --- |
| host semantic operation/result | live runner가 higher epoch에서 pending call/result를 이어받는 stable ledger | runner 사망 뒤 arbitrary provider effect 복원은 Capability A |
| request-keyed application | 같은 execution의 AskUserQuestion 응답·expiry·terminal 경합 | successor request authority transfer는 Capability A |
| assignment/inbox/payload/FIFO | durable payload, future-write fence, live consume mirror와 runner-lost release/no-effect | dead execution의 context/request를 잇는 disposition writer는 Capability A |
| stop | durable invocation을 current execution에 bind | replacement와 stop binding 이전은 Capability A |
| terminal prefix/output ingress | witness→ingress→Core barrier→visible terminal | background retention은 Capability B |
| retention task terminal proof | 없음 | 전부 Capability B |
| runner absence/무응답 | exact unavailability proof로 current execution을 `runner_lost` 정산하고 unconsumed session delivery를 보존 | context/checkpoint/effect/request inheritance는 Capability A |
| failed-attempt child cleanup | rollback 실패를 canonical join에서 격리하고 단일 cleanup obligation·node orphan accounting으로 회수 | 죽은 execution의 context를 successor가 잇는 replacement만 Capability A |
| legacy cutoff/backfill/promotion | 없음 | 전부 Migration |

### Core v2 restart flow

```text
1  host start → 중앙 DB의 open Core execution scan
2  live runner의 execution/attempt/command/PID/start identity와 input/outbox/host-call watermark 검증
3  중앙 DB에서 higher AttachmentEpoch prepare + old DB writer freeze
4  runner가 old admission을 닫고 accepted epoch·command disposition·watermark barrier를 durable commit
5  중앙 DB가 exact runner receipt를 검증하고 new writer grant commit
6  durable delivery inbox에서 누락 input을 같은 delivery ID/input sequence로 replay
7  runner outbox를 semantic event ID로 overlap replay·dedupe
8  same execution / same command 계속
```

3~5는 하나의 commit이 아니라 prepared→runner barrier→committed의 2단계 fence다. prepare 전, prepare 뒤, runner barrier 뒤, 중앙 commit 직전 어느 곳에서 host가 다시 죽어도 같은 attachment operation id와 expected epoch로 재진입한다. prepared grant와 barrier receipt는 단조 fact라 새 operation이나 새 execution을 만들지 않는다.

open scan은 live runner 재부착만 자동 수행한다. identity가 정확하고 runner process가 살아 있다는 proof가 없으면 attachment를 열지 않고 `blocked`로 멈춘다. ping·새 메시지·사용자 재전송은 wake 가속일 수는 있어도 복구 전제가 아니다.

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

### 260824 세 번째 고착 — failed attempt residue가 다음 spawn을 차단

표본 `/home/eias/incident-260823-6ba8ec7b-stall/repro-3/`의 사고 시각은 2026-08-23 15:04:52 UTC, 즉 2026-08-24 00:04:52 KST다. 예약 CAS에서 진 경로가 이미 spawn한 PID 3235909를 rollback하려 했으나 `execution ownership rollback left the spawned child live`로 끝났다. child는 canonical ownership을 얻지 못했지만 session-scoped `runner.pid`와 `runner-identity.json` 후보에는 남았고, 뒤따른 spawn은 `runner pid evidence disagrees`에서 영구 차단됐다. 15:27:51 UTC에 PID 3235909를 SIGKILL한 뒤에야 차단이 풀렸다.

이 표본은 7일 계측의 우리 노드 1위인 `pid evidence disagrees` 30건이 단순 로그 잡음이 아님을 확증한다. runner death 5건과는 다른 축이다. 전자는 **새 runner를 열 수 없게 하는 failed-attempt residue**이고, 후자는 죽은 실행을 이어받을지의 문제다. 따라서 residue 격리·회수는 Core, dead-runner context/effect inheritance는 계속 Capability A다.

Core는 이 사고를 다음 세 불변식으로 고정한다.

| ID | Core 불변식 | 구조적 강제 |
| --- | --- | --- |
| A | activation rollback의 child 종료 실패는 종착지가 아니다. | rollback transaction은 exact attempt를 effect-fence·canonical-join 제외한 뒤 `ExactProcessAbsenceReceipt` 또는 단일 `CleanupObligation` 중 하나를 반드시 commit한다. 후자면 node cleanup lane이 finite `cleanupDeadlineAt` 안에서 재시도하고 claim 실패 뒤에도 obligation owner·`nextWakeAt`을 잃지 않는다. |
| B | PID 증거 불일치는 진단이지 spawn 종착지가 아니다. | 등록·PID·identity 파일은 `(executionId, executionCommandId, attemptId)` namespace 안에서만 증거다. non-current attempt의 live PID는 그 attempt cleanup을 깨우되 새 attempt의 identity 후보가 될 수 없다. session-level 파일은 관측 projection일 뿐 reserve/spawn 판정 입력이 아니다. |
| C | canonical runner가 죽거나 command plane이 무응답이어도 host execute waiter는 남지 않는다. | exact absence 또는 bounded IPC reconnect·health-probe 소진이 같은 `RunnerUnavailabilityProof`를 만들고 기존 `runner_lost` terminal pipeline을 깨운다. foreground output 정지나 외부 입력 대기는 proof가 아니다. waiter는 IPC error가 아니라 durable terminal projection으로 한 번 settle한다. |

CAS 패자 child의 cleanup과 canonical execution의 `runner_lost`는 같은 Core attempt/cleanup primitive를 사용하지만 같은 outcome은 아니다. 전자는 winning execution에 붙을 권한이 없는 child를 격리·회수하는 일이고, 후자는 current canonical execution을 정직하게 닫는 일이다. 어느 쪽도 죽은 실행의 context·pending request·provider effect를 successor에게 상속하지 않는다.

### 7일 라이브 DB 계측 (2026-08-24)

Core 우선순위는 synthetic fault 빈도가 아니라 다음 라이브 실측으로 정한다.

| 노드 | 실패 사유 | 7일 건수 | 범위 판정 |
| --- | --- | ---: | --- |
| `eias-linegames` (Windows) | `writer lock already held` | 5,752 | 이 재설계 밖의 별도 Windows 결함 |
| `eiaserinnys` | `pid evidence disagrees` | 30 | Core failed-attempt namespace·cleanup과 직접 관련; 260824 라이브 고착 재현 |
| `eiaserinnys` | `manifest mismatch` | 6 | Migration/cutover 별도 gate |
| `eiaserinnys` | runner death | 5 | Core `runner_lost` 정산, transparent inheritance는 Capability A |
| `eias-linegames-wsl` | runner death | 1 | 같은 경계 |

전체 실패의 99%는 Windows writer-lock 결함이다. 빈도는 압도적이지만 이 문서의 delivery/host-restart 재설계로 해결하지 않는다. 별도 업무가 추적해야 하며 Core fixture·수용 기준에 섞지 않는다. 우리 노드에서는 failed-attempt residue가 유발하는 `pid evidence disagrees`가 30건으로 1위이고 세 번째 라이브 고착에서 같은 사슬이 재현됐다. runner death는 7일 5건이며, 앞선 260823 실사고 2건 중 process death는 1건뿐이다. `runner-death-live-host`는 SIGTERM으로 만든 합성 회수 fault라 빈도 근거가 아니다.

| delivery 종착 | 전체 748건 | 비율 |
| --- | ---: | ---: |
| `consumed` | 632 | 84.49% |
| `superseded` | 45 | 6.02% |
| `delivered` | 39 | 5.21% |
| `uncertain` | 28 | 3.74% |
| `queued` | 3 | 0.40% |
| `claimed` | 1 | 0.13% |

`delivered + uncertain + queued + claimed` 71건, 즉 전체의 9.5%가 증명 가능한 소비·종결에 도달하지 못했다. 사용자 메시지만 보면 `consumed=180`, `delivered=10`, `uncertain=6`, `queued=3`, `claimed=1`로 **20/200=10%가 미소비**다. runner death 5건보다 네 배 많다.

`durable_next_turn`의 `uncertain`은 최대 2,173회, `completion_notification`의 `uncertain`은 최대 499회 재시도했다. retry 횟수는 종착 증거가 아니며 `uncertain`은 final state가 될 수 없다. Core v2 delivery final은 `consumed | cancelled | no_effect(proof)`뿐이다. `received/delivered/queued/claimed`는 미종결 projection이고 반드시 `nextWakeAt`과 책임 owner를 가진다. `superseded`는 proof-bearing `no_effect`로 정규화한다.

### 이 재설계가 다루지 않는 것

- **Windows `writer lock already held` 5,752건**: 전체 실행 실패의 99%지만 `eias-linegames` 한 노드에 집중된 별개 writer-lock 결함이다. 별도 업무에서 lock acquisition/release와 프로세스 잔존을 진단해야 하며 Core delivery/attachment 설계에 흡수하지 않는다.
- **manifest mismatch 6건과 active-v1 promotion**: Migration gate 소관이다.
- **죽은 runner의 context/checkpoint/provider effect inheritance**: Capability A 소관이며 7일 빈도와 backend capability 계측 뒤 우선순위를 결정한다.
- **terminal background task takeover**: Capability B 소관이다.

### 읽은 입력 정본

| 입력 | 이 문서에서 사용한 계약 |
| --- | --- |
| `.local/artifacts/260822-runner-subsystem-review.md` | 일곱 부분 표현, optional 12개, 해제 9곳, P0 5건, 재설계 2-1·2-2·2-3 |
| `origin/test/runner-execution-invariants:docs/runner-execution-invariants.md` | 실행 불변식 16개, runner-death·activation rollback 영구 RED |
| `744ea525:docs/delivery-execution-invariants.md` | delivery 불변식 10개, `result_unknown`과 retry cadence 소진의 분리 |
| 업무 항목 `02fe8079`, `7bdd378c`, `d38daa1d`, `d211daf4` | 실행 규율, 260823 실사고, P0 5건, reserve에 편재한 회수 트리거 |
| 260823 사고 표본 | host DB ownership, runner lifecycle·journal, delivery snapshot, 시간순 로그의 상호 불일치 |
| 260824 repro-3 표본 | rollback kill 실패→오펀 PID 잔존→session-scoped PID evidence 충돌→후속 spawn 영구 차단 |
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
| attempt budget 소진 | `uncertain` 또는 `dead_letter` | v2에서는 final 전이가 아니다. operation owner와 `nextWakeAt`이 남거나 proof-bearing `cancelled/no_effect`로 끝난다. |
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

별도 `runner-death-live-host`는 SIGTERM으로 만든 합성 경계 fault이며 빈도 증거가 아니다. runner 종료 뒤 후속 요청에 HTTP 503 `runner registration identity incomplete`를 노출하는 계약 결함은 `runner_lost` 정산 fixture로 남기되 transparent replacement 요구로 승격하지 않는다. 재시작 자체의 기본 adopt 경로는 이미 투명하고, 재설계의 직접 공략 표면은 **복구 완료 전 delivery 입력 창과 terminal/completion delivery 종착 경계**다.

### 새 구조의 예상 행 단위 trace

위 표는 PR #819가 고정한 **현재 구현의 실측**이다. 다음 표는 v2 구조가 세 시나리오 모두에서 만들어야 하는 **동일한 외부 계약**이다. 내부 host phase만 다르고 caller ACK와 semantic event 열은 같아야 한다.

| 순서 | 관측 경계 | ① steady-state | ② restart-adopt | ③ restart-intervention-window |
| ---: | --- | --- | --- | --- |
| 1 | caller identity | 첫 send 전에 action UUID를 생성하고 payload hash와 고정 | 같은 action UUID를 생성 | 같은 action UUID를 생성 |
| 2 | durable admission | `session_accept_input_v2`가 delivery와 idempotency receipt commit | 동일 | host 복구 전이라도 동일하게 commit |
| 3 | caller ACK | `{ status: "received", deliveryId, meaning: "durably_received_may_not_be_running" }` | 동일 | 동일. 503·retry 요구 없음 |
| 4 | execution bind | assignment operation을 현재 `executionId/executionCommandId`에 prepare | adopt가 보존한 같은 execution/command와 higher attachment epoch에 prepare | attachment 복원 전 prepared 상태; runner barrier 직후 **같은 열린 command**의 runner inbox에 register |
| 5 | runner input | `runnerInputSequence=N` inbox receipt 뒤 consume | 동일 | 복구 대기만 늘고 동일 receipt |
| 6 | semantic event | `user_message → tool_start → intervention_sent → tool_result → 개입이 반영된 단일 assistant_message` | 동일 순서·event id dedupe | 동일 순서·event id dedupe. `intervention_demand/context_reply` 소실 없음 |
| 7 | delivery 정산 | `consumed`, attempt와 input receipt가 동일 execution을 가리킴 | 동일 | 동일. `queued/pending` 영구 잔류 없음 |
| 8 | caller 재조회·재전송 | 같은 delivery receipt를 반환 | 동일 | admission 응답 전에 orch가 죽어도 같은 stable ID로 동일 receipt 반환 |

③의 Core 내부 trace는 `received → assignment prepared → higher-epoch attachment barrier → runner inbox registered → consumed → head advanced`다. exact runner absence/무응답이 끼면 current execution은 `runner_lost`로 정산하고 미소비 session delivery의 assignment만 release한 뒤 새 execution의 새 assignment가 같은 delivery id를 소비한다. continuity inheritance나 active-v1 promotion은 이 trace에 없다. 내부 원인은 숨겨도 delivery received/consumed/no-effect, execution activity, availability의 보장 축은 숨기지 않는다. 이 표의 행 3·6·7이 PR #819 transparency oracle의 비교 대상이고, 세 열의 값이 다르면 v2 cutover를 열지 않는다.

검증 라운드별 폐쇄표는 삭제했다. 같은 계약을 이력별로 반복하면 장치가 늘어난 것처럼 보이고 정본이 갈린다. 현행 Core 정본은 아래 fact schema·projection reducer·불변식 매핑뿐이다. attempt 격리와 continuity certificate는 Capability A에 보존하고, Core는 attachment command fence, delivery 종착, terminal ordering, admission cutoff만 사용한다.

## 시스템 그림

### A. 진입 경로 매트릭스

| # | 진입 | 현재 조립 위치 | 새 구조의 첫 호출 | 실행 identity |
| ---: | --- | --- | --- | --- |
| 1 | 최초 턴 | `task_executor.ts:374` | reservation receipt commit | 생성한 `executionId` |
| 2 | 자동 재개 | `task_auto_resume_transition.ts:67` | session-scoped delivery admission 뒤 open execution reserve | 새 `executionId` |
| 3 | live runner adopt | `task_executor.ts:723` | higher attachment epoch receipt | 중앙 open execution의 기존 `executionId` |
| 4 | offline terminal replay | `task_executor.ts:788` | witness/outbox ingress reconciliation | runner witness가 가리키는 기존 `executionId` |
| 5 | runner lost Core default | `task_executor.ts:1030` process absence와 dispatcher reconnect exhaustion branch | exact absence/무응답→runner-lost witness→delivery disposition 정산 | 기존 execution은 runner_lost terminal, 보존 delivery는 평상시 새 `executionId` |
| 6 | **[Capability A]** certified replacement | `task_executor.ts:1030` | process-absence proof와 continuity certificate를 successor reservation에 commit | 앞 실행과 다른 새 `executionId`; certificate 없으면 진입 불가 |
| 7 | 주기 회수 | `runner_recovery_coordinator.ts:161` | open facts·unresolved delivery를 reducer에 넣고 due receipt operation 실행 | 중앙 open row/delivery의 stable id |
| 8 | 개입·응답·interrupt | `task_intervention_route.ts:136`, `sessions.py:370` | scope-bearing delivery admission 또는 stop intent CAS | scope가 지정한 session/execution/request |

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
// Core v2 fact model. Optional capability extensions are marked below.
type ExecutionId = string & { readonly __brand: "ExecutionId" };
type ExecutionLineageId = string & { readonly __brand: "ExecutionLineageId" };
type DeliveryId = string & { readonly __brand: "DeliveryId" };
type ExecutionCommandId = string & { readonly __brand: "ExecutionCommandId" };
type ExternalRequestId = string & { readonly __brand: "ExternalRequestId" };
type SpawnAttemptId = string & { readonly __brand: "SpawnAttemptId" };
type RunnerAttemptStateNamespace = string & { readonly __brand: "RunnerAttemptStateNamespace" };
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

interface RunnerCommandPlaneProbeReceipt {
  receiptId: string;
  attemptId: SpawnAttemptId;
  spawnReceiptId: string;
  pid: number;
  startIdentity: string;
  result: "unreachable";
  observedInputHighWatermark: number;
  observedOutboxHighWatermark: number;
  observedAt: IsoDateTime;
}

interface ExactRunnerNonresponsiveReceipt {
  receiptId: string;
  attemptId: SpawnAttemptId;
  spawnReceiptId: string;
  executionCommandId: ExecutionCommandId;
  pid: number;
  startIdentity: string;
  reconnectBudgetExhaustedReceiptId: string;
  probes: readonly [RunnerCommandPlaneProbeReceipt, RunnerCommandPlaneProbeReceipt];
  decisionDeadlineAt: IsoDateTime;
  attachmentRevocationReceiptId: string;
  writerRevocationReceiptId: string;
  eventIngressRevocationReceiptId: string;
  committedAt: IsoDateTime;
}

type RunnerUnavailabilityProof =
  | { kind: "process_absent"; receipt: ExactProcessAbsenceReceipt }
  | { kind: "command_plane_nonresponsive"; receipt: ExactRunnerNonresponsiveReceipt };

type PhysicalAbsenceReceipt =
  | {
      kind: "not_launched";
      receiptId: string;
      stableLaunchOperationId: string;
      finalClaimEpoch: number;
      committedAt: IsoDateTime;
    }
  | { kind: "process_absent"; receipt: ExactProcessAbsenceReceipt };

type AttemptCleanupState =
  | {
      state: "not_required";
      isolationReceipt: null;
      physicalAbsenceReceipt: null;
      cleanupObligationId: null;
    }
  | {
      state: "released";
      isolationReceipt: null;
      physicalAbsenceReceipt: PhysicalAbsenceReceipt;
      cleanupObligationId: null;
    }
  | {
      state: "isolated_pending_cleanup";
      isolationReceipt: SpawnAttemptIsolationReceipt;
      physicalAbsenceReceipt: null;
      cleanupObligationId: string;
    }
  | {
      state: "isolated_released";
      isolationReceipt: SpawnAttemptIsolationReceipt;
      physicalAbsenceReceipt: PhysicalAbsenceReceipt;
      cleanupObligationId: string;
    };

interface RunnerAttempt {
  attemptId: SpawnAttemptId;
  executionId: ExecutionId;
  nodeId: string;
  stateNamespace: RunnerAttemptStateNamespace;
  stableLaunchOperationId: string;
  reservedAt: IsoDateTime;
  spawnReceipt: SpawnedChildReceipt | null;
  ownershipProof: { receiptId: string; committedAt: IsoDateTime } | null;
  activationReceipt: { receiptId: string; committedAt: IsoDateTime } | null;
  cleanup: AttemptCleanupState;
}

type RunnerPidEvidenceResolution =
  | {
      kind: "current_attempt";
      attemptId: SpawnAttemptId;
      spawnReceiptId: string;
      pid: number;
      startIdentity: string;
    }
  | {
      kind: "known_non_current_attempt";
      ownerAttemptId: SpawnAttemptId;
      cleanupObligationId: string;
      action: "wake_cleanup_and_exclude_from_join";
    }
  | {
      kind: "unknown_external_process";
      pid: number;
      startIdentity: string;
      incidentId: string;
      action: "diagnose_without_blocking_attempt_namespace";
    }
  | { kind: "absent"; attemptId: SpawnAttemptId };

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
  lane: "core_attempt_cleanup" | "terminal_resource_cleanup";
  homeNodeId: string;
  effectFenceReceiptId: string;
  stableOperationId: string;
  createdAt: IsoDateTime;
  cleanupDeadlineAt: IsoDateTime;
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
    | {
        kind: "cancelled";
        store: "postgres";
        reason: "runner_lost";
        runnerLostWitnessId: string;
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
        reason: "already_resolved" | "execution_finished" | "runner_lost";
        registrationFence: AssignmentRegistrationFenceProof;
        headAdvanceReceiptId: string;
      }
    | {
        kind: "no_effect_after_runner_release";
        store: "postgres";
        reason: "already_resolved" | "execution_finished" | "runner_lost";
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
      requestId: ExternalRequestId;
      deliveryId: DeliveryId;
    }
  | {
      kind: "already_applied";
      requestId: ExternalRequestId;
      deliveryId: DeliveryId;
    }
  | {
      kind: "not_applied";
      requestId: ExternalRequestId;
      reason: "expired" | "cancelled" | "execution_finished" | "runner_lost";
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
  // Stable semantic identity. A higher attachment epoch may retry it.
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
  semanticResultReceiptId: string;
  resultHash: string;
  result: TResult;
}

type HostSemanticEffectProof =
  | {
      kind: "same_transaction";
      transactionReceiptId: string;
    }
  // Capability A only. Core eligibility excludes this branch.
  | {
      kind: "stable_provider_lookup";
      providerOperationId: string;
      lookupReceiptId: string;
    };

interface HostSemanticResultReceipt<TResult> {
  receiptId: string;
  operationId: RunnerHostOperationId;
  requestPayloadHash: string;
  resultHash: string;
  result: TResult;
  effectProof: HostSemanticEffectProof;
  committedAt: IsoDateTime;
}

type HostSemanticOperationRecord<TCall, TResult> =
  | {
      state: "prepared";
      operationId: RunnerHostOperationId;
      requestPayloadHash: string;
      canonicalCall: TCall;
      resultReceipt: null;
      preparedAt: IsoDateTime;
    }
  | {
      state: "resolved";
      operationId: RunnerHostOperationId;
      requestPayloadHash: string;
      canonicalCall: TCall;
      resultReceipt: HostSemanticResultReceipt<TResult>;
      preparedAt: IsoDateTime;
    };

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

// Migration capability: active-v1 in-place promotion.
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

// Capability B: terminal background retention.
interface RetainedBackgroundTaskIdentity {
  taskId: string;
  kind: "claude_background_tool" | "backend_background_operation";
  journalHighWatermark: number;
  effectOperationIds: ReadonlyArray<string>;
}

interface RetainedBackgroundTaskTerminalReceipt {
  receiptId: string;
  retentionId: ExecutionRetentionId;
  taskId: string;
  authorityEpoch: number;
  outcome: "completed" | "cancelled" | "failed";
  finalJournalHighWatermark: number;
  effectInventoryHash: string;
  committedAt: IsoDateTime;
}

type RetainedBackgroundTask = RetainedBackgroundTaskIdentity &
  (
    | {
        state: "running";
        terminalReceipt: null;
      }
    | {
        state: "terminal";
        terminalReceipt: RetainedBackgroundTaskTerminalReceipt;
      }
  );

interface ExecutionRetentionTaskTerminalReference {
  retentionId: ExecutionRetentionId;
  taskId: string;
  terminalReceiptId: string;
}

interface ExecutionRetentionReleaseReceipt {
  receiptId: string;
  retentionId: ExecutionRetentionId;
  authorityEpoch: number;
  ownerInstanceId: string;
  taskTerminalReceipts: ReadonlyArray<ExecutionRetentionTaskTerminalReference>;
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

// Capability A: certified runner replacement.
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

type CoreAttachmentProjection =
  | { state: "not_applicable" }
  | { state: "attached"; grant: AttachmentGrant }
  | {
      state: "reconnecting";
      attempt: RunnerAttempt;
      lastLease: AttachmentGrant | null;
      evidence: { kind: "runner_alive"; registrationId: string };
      action: "attach_same_execution";
    }
  | {
      state: "runner_lost";
      attempt: RunnerAttempt;
      unavailability: RunnerUnavailabilityProof;
      terminalizationOperationId: string;
      action: "settle_runner_lost";
    }
  | {
      state: "blocked";
      attempt: RunnerAttempt;
      reason: "runner_identity_unresolved";
      incidentId: string;
      action: "preserve_facts_and_wait";
    };

// Capability A may replace the default runner_lost settlement only after its
// continuity gate passes. Core never consumes these variants.
type ExecutionRecoveryProjection =
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
  category: "completed" | "failed" | "stopped" | "runner_lost";
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

interface RunnerLostTerminalWitness {
  kind: "runner_lost";
  witnessId: string;
  executionId: ExecutionId;
  executionCommandId: ExecutionCommandId;
  attemptId: SpawnAttemptId;
  unavailability: RunnerUnavailabilityProof;
  lastCentralIngressHighWatermark: number;
  deliveryAdmissionCutoffSequence: bigint;
  publicOutcome: PublicOutcome & {
    category: "runner_lost";
    retrySafety: "not_needed";
  };
  internalDiagnostic: InternalTerminalDiagnostic;
  durableAt: IsoDateTime;
}

type ExecutionTerminalWitness =
  | RunnerTerminalWitness
  | PreactivationTerminalWitness
  | RunnerLostTerminalWitness;

interface TerminalIngressReceipt {
  witnessId: string;
  executionId: ExecutionId;
  receivedThroughOutboxSequence: number;
  basis: "event_ingress" | "no_runner_output" | "runner_lost_boundary";
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

interface CoreTerminalSafetyBarrier {
  readonly [terminalSafetyBarrier]: true;
  executionId: ExecutionId;
  witnessId: string;
  boundDeliverySettlementReceiptIds: ReadonlyArray<string>;
  externalRequestResolutionReceiptIds: ReadonlyArray<string>;
  streamSettledReceiptId: string;
  hostCallsSettledReceiptId: string;
  attachment: AttachmentSafetyReceipt;
  writer: WriterSafetyReceipt;
  committedAt: IsoDateTime;
}

type TerminalSafetyBarrier = CoreTerminalSafetyBarrier;

// Capability B extends, but never changes, the Core visible-terminal proof.
interface TerminalRetentionSafetyExtension {
  coreBarrier: { executionId: ExecutionId; witnessId: string };
  retention: Extract<ChildOrRetentionSafetyReceipt, { disposition: "transferred" }>;
  retentionAuthorityId: ExecutionRetentionId;
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

type CoreTerminalLogicalExecution = {
  state: "terminal";
  kind: "visible";
  record: ExecutionTerminalRecord;
};

type CapabilityTerminalLogicalExecution =
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

type TerminalLogicalExecution =
  | CoreTerminalLogicalExecution
  | CapabilityTerminalLogicalExecution;

type CoreLogicalExecution =
  | OpenLogicalExecution
  | CoreTerminalLogicalExecution;

type LogicalExecution =
  | CoreLogicalExecution
  | CapabilityTerminalLogicalExecution;

interface CoreTaskExecutionProjection {
  logical:
    | { state: "idle" }
    | { state: "open"; execution: OpenLogicalExecution }
    | { state: "terminal"; execution: CoreTerminalLogicalExecution };
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
  attachment: CoreAttachmentProjection;
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

type TaskExecutionProjection = CoreTaskExecutionProjection;

interface OptionalCapabilityProjection {
  runnerReplacement:
    | { state: "disabled" }
    | { state: "enabled"; recovery: ExecutionRecoveryProjection | null };
  terminalRetention:
    | { state: "disabled" }
    | { state: "enabled"; authority: ExecutionRetention | null };
  activeV1Promotion:
    | { state: "disabled" }
    | { state: "enabled"; lastFence: PromotionHandoffFence | null };
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
      reason:
        | "runner_identity_unresolved"
        | "continuity_guarantee_unproven";
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
        reason:
          | "idle"
          | "finished"
          | "runner_lost_settling"
          | "runner_identity_unresolved"
          | "continuity_guarantee_unproven";
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
  readonly logical: CoreLogicalExecution | null;
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
  recordAttemptRollback(
    attemptId: SpawnAttemptId,
    cleanup: Exclude<AttemptCleanupState, { state: "not_required" }>,
  ): Promise<void>;
  commitAttachment(grant: AttachmentGrant): Promise<void>;
  admitDelivery(delivery: DeliveryRecord): Promise<void>;
  requestStop(invocation: StopInvocation): Promise<TerminationIntentReceipt>;
  recordTerminalWitness(witness: ExecutionTerminalWitness): Promise<void>;
  recordTerminalIngress(receipt: TerminalIngressReceipt): Promise<void>;
  commitTerminalSafety(barrier: TerminalSafetyBarrier): Promise<void>;
  commitVisibleTerminal(executionId: ExecutionId): Promise<ExecutionTerminalRecord>;
}

interface CoreAttemptCleanupWorker {
  claimDue(input: {
    homeNodeId: string;
    obligationId: string;
    expectedClaimEpoch: number;
    observedAt: IsoDateTime;
  }): Promise<CleanupObligation>;
  completeExactAbsence(input: {
    obligationId: string;
    expectedClaimEpoch: number;
    absence: ExactProcessAbsenceReceipt;
  }): Promise<void>;
}

interface RunnerReplacementCapabilityController {
  readonly projection: ExecutionRecoveryProjection | null;
  commitContinuityTransfer(
    predecessor: ExecutionSupersessionRecord,
    successor: ExecutionReservationReceipt,
  ): Promise<void>;
}

interface TerminalRetentionCapabilityController {
  readonly authority: ExecutionRetention | null;
  transferRetention(authority: ExecutionRetention): Promise<void>;
}

interface ActiveV1PromotionCapabilityController {
  readonly lastFence: PromotionHandoffFence | null;
  commitPromotionHandoff(fence: PromotionHandoffFence): Promise<void>;
}

interface Task {
  readonly execution: TaskExecutionController;
  readonly capabilities: {
    runnerReplacement: RunnerReplacementCapabilityController | null;
    terminalRetention: TerminalRetentionCapabilityController | null;
    activeV1Promotion: ActiveV1PromotionCapabilityController | null;
  };
}
~~~

Core reducer가 읽는 writable lifecycle은 `CoreLogicalExecution(open|visible terminal)` 둘뿐이다. launch, external input, attachment, settlement는 서로 독립인 읽기 축이다. 공개된 미응답 request, 이미 접수되어 runner 적용을 기다리는 response, live runner 재부착은 동시에 참일 수 있으므로 `externalInput.waitingForUserRequestIds`, `externalInput.applyingResponseRequestIds`, `attachment.reconnecting`을 각각 계산한다. exact process absence나 command-plane nonresponse는 `attachment.runner_lost`와 `settlement.settling`을 계산해 canonical terminal pipeline을 자동 재개한다. current attempt identity가 불명확할 때만 `attachment.blocked`와 public `availability.blocked`다. non-current attempt residue는 `orphan_cleanup_due`이고 attachment state가 아니다. response 적용 대기는 settlement로 위장하지 않는다. terminal witness가 있으면 `settlement.settling`, visible terminal 뒤에는 `logical.terminal + settlement.finished`가 계산된다.

`ExecutionRecoveryProjection`, `ExecutionSupersessionRecord`, `ExecutionRetention`, `PromotionHandoffFence`는 각각 Capability A, Capability B, Migration reducer의 입력이다. `OptionalCapabilityProjection`은 enabled capability의 결과를 모아 보여 주는 읽기 표면일 뿐 Core reducer의 입력·DB CHECK·완료 gate가 아니다. Core controller에도 promotion, retention, continuity-transfer mutation method가 없다.

`reserved/provisional/activating/active`는 `RunnerAttempt`의 reservation·spawn·ownership·activation receipt 조합에서 계산한다. 어느 projection도 별도 writer·CAS·DB 컬럼을 갖지 않는다. 하나의 declarative `execution_semantics.v2` schema가 internal/public projection, coupled recovery/operation 타입, SQL regular projection/invariant function과 transition fixture를 생성한다. 구현자가 projection이나 operation receipt를 추가할 때 타입·DB CHECK·테스트를 손으로 따로 수정하는 경로는 없다.

생성 경로는 구현 단위 1에서 다음으로 고정한다.

1. 손으로 쓰는 유일한 정본: `packages/execution-semantics/src/execution_semantics_v2.schema.ts`
2. 생성기: `packages/execution-semantics/scripts/generate.ts`
3. Core TypeScript 산출물: `packages/execution-semantics/generated/typescript/execution_semantics_v2.ts` — `CoreLogicalExecution`, `TaskExecutionProjection`, orthogonal `PublicSessionProjection`, kind별 coupled `IdempotentOperation`, delivery cancel·lineage stop, Core host semantic operation/result, exhaustive Core reducer
4. runner wire/slot/attempt 산출물: `packages/execution-semantics/generated/typescript/runner_host_wire_v2.ts`, `packages/execution-semantics/generated/typescript/runner_attempt_registration_v2.ts`, `packages/execution-semantics/generated/sqlite/runner_host_wire_v2.sql`, `packages/execution-semantics/generated/sqlite/runner_attempt_registration_v2.sql`, `packages/execution-semantics/generated/sqlite/runner_assignment_disposition_v2.sql` — epoch-scoped call/response transport envelope, append-only `RunnerAttachmentJournal`, current-attachment projection, call identity PK·epoch-scoped operation unique·payload hash/epoch trigger, attempt namespace와 `RunnerPidEvidenceResolution`, assignment별 `RunnerAssignmentDispositionSlot`과 registration capability/claim fence. `frame_protocol.ts`, runner registration, runner SQLite는 이 생성물만 import/apply하고 같은 schema를 다시 선언하지 않는다.
5. Core SQL 산출물: `packages/db-schema/sql/generated/execution_semantics_v2.sql` — Core host semantic operation/result ledger, view predicate와 procedure가 호출하는 invariant function
6. Core 전이 산출물: `packages/execution-semantics/generated/fixtures/execution_semantics_v2.transitions.json` — Core receipt 조합과 projection/action 기대값
7. optional capability 산출물: `packages/execution-semantics/generated/capabilities/{runner-replacement,terminal-retention,active-v1-promotion}/` — 각 gate가 켜질 때만 생성·적용하는 타입, SQL, fixture. Core generated 파일을 덮어쓰거나 Core reducer에 branch를 추가하지 않는다

CI는 `pnpm --dir packages/execution-semantics generate` 뒤 Core generated 경로의 `git diff --exit-code`와 transition/wire fixture consumer test를 실행한다. `soul-server-ts`는 generated TypeScript를 import하고 Core projection이나 runner↔host envelope를 다시 선언하지 않는다. capability별 generator/fixture는 그 capability 작업이 시작될 때 별도 gate로 켠다. 생성 전후 diff가 있거나 Core SQL·wire·fixture 중 하나가 빠지면 Core merge를 막는다.

시간은 fact가 아니라 reducer 입력이다. 생성된 API는 `reduceExecutionSemantics(facts, observedAt)`이고 attachment TTL·due 여부를 transaction snapshot의 `observedAt`으로 계산한다. DB write 권위 판단은 `STABLE` SQL function 또는 regular view가 같은 transaction의 `statement_timestamp()`을 명시적으로 넘겨 수행한다. materialized projection은 대시보드 관측·비교용일 뿐 reserve, takeover, terminal, capability 판정의 권위가 아니다.

`RunnerAttempt`가 물리 lifecycle 정본이다. 별도 attempt phase·process permit row·cleanup job phase는 없다. state directory는 session 단위가 아니라 exact `(executionId, executionCommandId, attemptId)` namespace이고 `runner.pid`·`runner-identity.json`·socket·lifecycle·SQLite가 그 안에만 존재한다. session-level 경로가 필요하면 current-attempt를 보여 주는 read projection만 둘 수 있으며 registration·spawn 판정은 그 파일을 읽지 않는다. attempt row가 만들어진 순간부터 `cleanup.physicalAbsenceReceipt === null`인 동안 node process capacity를 점유하고, `cleanup.isolationReceipt !== null && cleanup.physicalAbsenceReceipt === null`이면 orphan quota도 점유한다. spawn 전에 취소된 attempt도 `not_launched` receipt가 생기기 전에는 capacity를 반납하지 않는다. cleanup worker의 claim epoch·lease·wake는 attempt가 참조하는 단일 `CleanupObligation`에만 있다. stable launch operation은 DB authorization과 OS spawn을 묶어 물리 child를 최대 하나만 만들며, claim expiry 뒤 늦은 launcher가 새 child를 만들 수 없는 primitive를 구현 단계에서 선택해야 한다.

`CleanupObligation`만 물리 회수 권한의 정본이다. attempt, terminal receipt, retention, post-terminal maintenance는 obligation id만 참조한다. 같은 exact child는 하나의 active obligation만 가질 수 있고, terminal procedure는 기존 preterminal obligation을 참조해야 하며 새 child obligation을 만들 수 없다. activation rollback은 first TERM/KILL이 실패해도 error만 던질 수 없다. 같은 DB transaction에서 attempt capability를 revoke하고 canonical join에서 제외한 뒤 exact absence 또는 `lane=core_attempt_cleanup`, finite `cleanupDeadlineAt`, non-null `nextWakeAt` obligation을 commit해야 호출 스택을 벗어날 수 있다. cleanup claim이 fail-stop되면 higher claim epoch가 같은 stable operation을 재개한다. `TerminalSafetyBarrier`는 물리 삭제가 아니라 “더는 사용자-visible effect를 만들 수 없음”을 증명한다. 살아 있는 fenced child는 `retained + cleanupObligationId`, retention/attachment/writer의 authority handoff는 typed `transferred + new authority/epoch + cleanupObligationId`로 표현한다. child/retention의 `released`는 `never_acquired/process_absent`만 허용되고 attachment/writer의 fenced `released`는 별도 physical release receipt를 함께 요구한다.

`ExecutionRetention`은 cleanup의 두 번째 owner가 아니다. terminal 이후에도 semantic event를 만들 수 있는 background runtime의 **현재 권한 정본**이고, `CleanupObligation`은 그 물리 자원을 언젠가 회수할 책임만 가진다. source execution당 `release === null` retention은 하나이고 `(retentionId, authorityEpoch)` 하나만 lease renew, background task effect, semantic event route를 사용할 수 있다. transfer receipt가 old attachment/writer epoch를 revoke하고 이 current retention row를 만든 뒤에만 terminal safety의 `transferred(resource=retention)`이 성립한다. retention이 참조하는 cleanup obligation은 물리 종료 전까지 그대로 한 개다. release는 task 집합에 대응하는 terminal receipt를 task별로 전부 열거해야 하며, opaque aggregate receipt로 “모두 끝남”을 주장할 수 없다.

runner↔host transport attempt의 immutable identity key는 `(executionId, executionCommandId, attachmentEpoch, hostCallSequence)`다. `operationId`, `payloadHash`, canonical payload와 `attachmentGrantId`는 key가 아니라 그 row의 값이다. runner는 wire frame을 내보내기 **전에** generated procedure로 sequence를 할당하고 canonical call row를 commit하며, envelope는 그 `requestReceiptId`를 싣는다. 따라서 수신된 변조 frame이 canonical row보다 먼저 effect admission에 도달하는 경로가 없다. call table PK는 sequence가 operation/hash/payload를 함수적으로 고정하고, epoch-scoped `UNIQUE(executionId, executionCommandId, attachmentEpoch, operationId)`는 한 attachment 안의 같은 semantic operation을 다른 sequence로 위조하지 못하게 하되 higher epoch의 재시도는 허용한다. insert procedure가 canonical payload hash를 계산하므로 caller가 hash만 맞바꿀 수도 없다. receiver는 receipt row를 먼저 읽어 envelope의 key·operation·hash·grant·payload를 전부 대조하며, 부재나 불일치는 effect 전에 거부한다. direct call DML과 receipt 없는 host effect entrypoint는 revoke한다.

transport와 semantic effect/result의 정본은 분리한다. host-side `HostSemanticOperationRecord`는 stable `operationId`를 PK로, canonical request와 request payload hash를 immutable 값으로 가지며, resolved branch의 `HostSemanticResultReceipt` 하나만 canonical result/hash와 effect proof를 소유한다. host effect entrypoint는 current attachment의 canonical transport call을 검증한 뒤 이 semantic row를 잠근다. 처음이면 same-transaction effect 또는 stable provider operation lookup으로 effect와 result receipt를 확정하고, 이미 resolved면 effect를 다시 실행하지 않고 같은 result receipt를 반환한다. prepared 뒤 crash한 row도 effect proof의 transaction receipt/provider lookup으로 `not_started` 또는 exact result를 판정한 뒤에만 진행한다. 높은 attachment epoch의 재시도는 새 transport call/response row를 만들지만 같은 semantic result receipt를 참조하므로 `host effect commit → response loss → takeover → retry`에서도 effect는 한 번이고 응답 내용과 `resultHash`는 같다.

`RunnerAttachmentJournal`은 runner-local accepted attachment epoch의 durable owner다. grant accept와 revoke를 append-only receipt로 기록하고 generated `RunnerCurrentAttachment` regular projection이 “가장 높은 accepted이고 revoke되지 않은 exact grant” 하나를 계산한다. call row는 `(executionId, executionCommandId, attachmentEpoch, attachmentGrantId)`로 accepted journal receipt를 참조한다. call insert와 effect admission trigger는 같은 SQLite transaction에서 current projection과 exact 일치를 재검사한다. higher epoch/revoke 뒤 늦은 call은 row/effect를 만들 수 없다. response는 call identity PK와 host semantic result receipt를 참조하고 operation id·request payload hash·grant가 call row와 같아야 하며, 이전 epoch request에 대한 늦은 response도 stale no-effect다. 그 stale transport response를 재사용하지 않고 higher epoch가 같은 semantic result를 새 canonical response로 받는다. socket identity나 전체 tuple UNIQUE는 이 fence를 대신하지 않는다.

external request의 300초 deadline은 publication transaction이 operation-owned publication receipt에 고정한 immutable `expiresAt = publishedAt + 300초`다. runner가 요청을 journal에 쓴 시각이 아니라 사용자가 실제로 볼 수 있게 된 시각부터 센다. response admission은 request row, current request-authority epoch, 현재 lineage execution의 terminal prefix를 함께 잠근다. `db_now <= expiresAt`이고 witness가 없을 때만 `responded` winner와 request-scoped delivery를 한 transaction에 commit한다. 일반 terminal witness가 먼저면 request-keyed `not_applied(execution_finished)`, `RunnerLostTerminalWitness`가 먼저면 `not_applied(runner_lost)`가 이기며 둘 다 delivery를 만들지 않는다. response가 먼저면 뒤따른 witness는 기록할 수 있어도 그 exact delivery consumption/application이 끝날 때까지 terminal safety barrier가 닫힌다. `db_now > expiresAt`이고 winner가 비어 있으면 response transaction 자신이 `expired` winner를 commit한다. expiry worker 시각과 recovery 지연은 결과에 관여하지 않는다. `InputApplicationResult`의 식별 정본은 항상 `requestId`이고, 실제 request-scoped delivery가 존재하는 `applied|already_applied`에만 `deliveryId`가 있다. expiry, cancellation, witness-first는 delivery를 만들거나 fabrication하지 않고도 `not_applied`를 구성한다.

request response의 semantic application owner는 delivery assignment consumption chain 하나다. `responded` request operation은 별도 response engine receipt를 만들지 않고 exact consumed assignment composite FK를 참조한다. expiry와 user/owner cancellation은 request operation이 runner journal의 `input_request_expired|input_request_cancelled`와 engine controller application receipt를 소유한다. terminal witness가 먼저인 `execution_finished`는 engine이 더는 wait하지 않는다는 exact witness FK가 no-effect application proof이며 runner application을 요구하지 않는다. request row는 어느 경우든 owner receipt id만 참조하고 내용을 복제하지 않는다. public reducer는 responded 뒤 composite consumption 전을 `applyingResponseRequestIds`로 표시하고 terminal barrier는 각 kind의 exact proof까지 기다린다.

`DeliveryScope`는 재해석 범위를 고정한다. `session` delivery만 다음 유효 execution으로 넘어갈 수 있다. `execution` scope는 exact execution/generation에만, `request` scope는 stable request id와 current authority epoch에만 적용된다. certified replacement는 request row의 authority epoch를 올리는 typed transfer를 함께 commit하므로 공개된 질문은 재게시 없이 successor에 남고 새 response는 current epoch에 bind된다. 닫힌 request는 canonical `no_effect/not_applied`로 끝나며 다음 turn 입력으로 바뀌지 않는다.

assignment마다 runner-local `RunnerAssignmentDispositionSlot` 하나가 registration과 final disposition의 authority다. registration RPC는 operation id, claim epoch, assignment capability epoch를 싣는다. pre-registration 종료는 runner가 slot에 `closed_before_registration`을 commit한 ack 또는 exact `RunnerUnavailabilityProof`와 해당 capability epoch revoke를 묶은 typed proof만 허용한다. unavailability branch 뒤 새 runner는 registration endpoint를 열기 전에 중앙 revoke watermark를 local close tombstone으로 동기화한다. 따라서 이미 전송됐던 낮은 epoch RPC도 SQLite insert 자체가 실패한다. runner는 **engine effect 전에 consumed disposition을 commit**한다. absence/무응답 뒤 Core runner-lost reconciler는 기존 local consumed/cancelled receipt를 그대로 mirror하거나, final disposition이 없으면 exact unavailability+capability revoke로 future write를 막고 `target_terminal_released(engineObservationCount=0)`를 확정한다. session scope는 delivery를 미종결로 보존하고 execution/request scope는 proof-bearing no-effect로 끝낸다. higher capability writer가 context와 pending request를 successor로 이전하는 branch만 Capability A다. 중앙 before-registration variant 셋은 이 fence proof와 delivery-level cancel intent의 exact 조합만 mirror한다. 등록 뒤 local cancel winner는 central `cancelled`만, target-terminal release winner는 scope에 따라 no-effect 또는 rebind만 허용한다.

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
| activation rollback에서 child 종료 실패 | exact attempt isolation과 Core `CleanupObligation`을 한 transaction에 기록 | current execution과 분리된 `orphan_cleanup_due`; 다음 attempt namespace는 독립 | 예외만 throw, session PID 후보에 잔존, cleanup owner 없는 child |
| non-current/foreign PID 증거 관측 | owning attempt를 exact join해 cleanup wake 또는 unknown-process diagnostic 기록 | current attempt 판정은 영향 없음 | session-scoped PID 후보 하나로 전체 spawn 거부 |
| **[Migration]** active-v1 in-place promotion | detach/epoch barrier와 v2 grant를 묶은 `PromotionHandoffFence` CAS | 동일 execution·command의 `active` | old socket·writer와 v2 writer 동시 유효 |
| external request publish receipt | request ledger와 event ingress receipt 연결 | `externalInput.waitingForUserRequestIds` | projection 직접 쓰기, 동일 request 재게시 |
| live runner의 attachment lease 상실 | 새 fact 없음. 기존 lease 만료를 Core reducer가 관측 | `attachment.reconnecting` | stream 실패·execution terminal |
| canonical runner absence 또는 command-plane 무응답 | exact `RunnerUnavailabilityProof`, `RunnerLostTerminalWitness`, delivery disposition 정산 | Core `attachment.runner_lost → settlement.settling → finished(runner_lost)` | IPC error로 execute waiter reject, completed/failed 위장, unconsumed session delivery 삭제 |
| current canonical runner identity 불일치·미확정 | durable fact와 incident만 보존 | Core `attachment.blocked` | 근거 없는 `runner_lost`, replacement·가짜 running |
| stop 요청 | lineage intent를 current execution에 bind하는 CAS | `settlement.settling` | 순간 execution id를 public target으로 사용, FIFO 뒤 배치, ACK를 `stopped`로 반환 |
| runner terminal witness | immutable witness와 delivery admission cutoff CAS | `terminating` | process absence·host intent를 outcome으로 승격, cutoff 뒤 session admission 차단 |
| terminal ingress receipt | witness의 outbox watermark 수신을 CAS | `terminating` | output drain 전 barrier |
| `TerminalSafetyBarrier` | 모든 의미 정산과 effect fence 검증 뒤 CAS | `settlement.settling` | 물리 삭제 완료를 요구, stale effect 허용 |
| visible terminal commit | witness→ingress→barrier FK를 묶어 `LogicalExecution(terminal)`로 CAS | `terminal/finished` | first-signal 덮기, barrier 전 공개 |
| **[Capability B]** terminal 이후 background retention | old attachment/writer revoke와 current `ExecutionRetention` 생성 CAS | capability projection `retention.active` | current owner 없는 background effect·복수 event route |
| **[Capability A]** certified replacement | predecessor `continuity_transfer`와 successor reservation을 한 transaction에 commit | lineage의 successor `reserved`, session stream은 계속 open | 중간 idle, certificate 없는 실행, predecessor open 잔존 |
| delivery bind·rebind | append-only assignment ordinal + kind별 operation | delivery별 received/consumed projection | mutable current pointer, scoped input 오재해석 |
| delivery cancel 요청 | stable delivery row의 intent CAS | delivery별 `cancel_requested` | assignment 부재 시 취소 불가, release 뒤 cancel 유실 |
| delivery consume·cancel·no-effect | runner disposition winner 뒤 operation receipt와 delivery resolution FK CAS | delivery별 public state | 중앙 cancel이 미반영 runner consume를 덮기, pending cancel delivery rebind |

Core projection reducer의 입력은 `CoreLogicalExecution`, current `RunnerAttempt`, attachment lease, append-only assignment/operation receipt, delivery/request ledger, terminal receipts와 명시적 `observedAt`뿐이다. continuity certificate, retention lease, promotion fence는 capability reducer만 읽는다.

| 축 | projection | declarative predicate |
| --- | --- | --- |
| logical | `idle/open/terminal` | open logical row 부재 / open row / terminal record |
| launch | `none/reserved/provisional/activating/active` | current attempt와 spawn·ownership·activation receipt 조합 |
| external input | waiting/applying request id 집합 | published unresolved request / responded이고 exact delivery consumption 전. 둘 다 0이면 foreground |
| attachment | `not_applicable/attached/reconnecting/blocked` | open launch 해당 없음 / valid lease / live runner+lease 없음 / process absent·identity mismatch |
| settlement | `none/settling/finished` | intent·witness 없음 / intent 또는 witness 있고 visible terminal 전 / terminal record |

축은 동시에 참일 수 있다. `launch.active + waitingForUserRequestIds≠[] + applyingResponseRequestIds≠[] + attachment.reconnecting + settlement.none`도 유효하다. 이 Core reducer의 declarative schema가 TypeScript projection, SQL regular view/invariant function과 transition fixture를 생성한다. writable `phase` 컬럼, phase별 CAS, memory phase↔DB phase 수동 동형 표는 삭제한다. capability reducer는 Core projection을 입력으로 받지 않고 같은 immutable facts 중 자기 gate가 허용한 확장 relation만 읽는다.

### 외부 입력 수명 정책

Claude `AskUserQuestion`의 300,000ms UX는 유지하되 publication transaction이 operation receipt에 immutable `publishedAt`과 `expiresAt=publishedAt+300_000`을 함께 쓴다. request가 runner journal에만 있고 아직 공개되지 않았다면 publication receipt가 없고 timer는 시작하지 않는다. response admission은 request row와 operation publication receipt를 잠근 transaction의 DB 시각이 `expiresAt` 이내일 때만 central `responded` receipt를 commit한다. deadline 뒤 winner가 비어 있으면 같은 transaction이 `expired`를 먼저 commit하므로 expiry worker 실행 시각은 결과에 관여하지 않는다.

late response는 새 input이 아니다. canonical result는 request id로 식별되는 `applied`, `already_applied`, `not_applied(expired|cancelled|execution_finished|runner_lost)` 중 하나고 delivery id는 applied 두 branch에만 있다. Agents approval처럼 backend에 timeout이 없으면 publication 뒤에도 deadline을 만들지 않는다. 이 publication/admission 기준을 구현할 수 없는 backend에는 restart-transparent capability를 발급하지 않는다.

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

node capacity도 별도 permit 상태 기계가 아니다. `cleanup.physicalAbsenceReceipt == null`인 attempt 수가 물리 capacity 점유이고, 그중 `cleanup.isolationReceipt != null`인 수가 orphan quota 점유다. 필수 설정 `physicalProcessLimit`과 `isolatedProcessLimit`에 닿으면 해당 node의 Core cleanup obligation을 우선 claim하고 exact TERM→force-reap을 수행하며, 새 placement만 다른 eligible node로 넘기거나 durable wait시킨다. 기존 execution과 다른 node는 멈추지 않는다. N회 rollback 검증은 OS의 exact child 수가 spawn receipt를 가진 unresolved attempt 수와 일치하고, 모든 unresolved attempt count가 capacity 이내인지 검사한다. 첫 kill 실패 뒤 후속 cleanup이 성공하는 fixture는 `cleanupDeadlineAt` 이전 exact absence와 OS process count 원복까지 요구한다.

### 해제 경계와 TerminalSafetyBarrier

host의 종료 의도, runner의 terminal outcome, 사용자-visible terminal은 서로 다른 사실이다. 순서는 고정된다.

1. stop/policy 요청이면 stable lineage intent를 current execution/generation에 bind하는 CAS를 한다. intent는 outcome이 아니다.
2. runner가 존재하면 마지막 engine event와 outbox를 먼저 durable하게 쓰고 `RunnerTerminalWitness`를 commit한다. 아직 물리 child가 없거나 exact absence가 증명된 preactivation 실행은 outbox 0과 absence receipt를 가진 `PreactivationTerminalWitness`를 commit한다. active runner의 exact PID/start absence 또는 bounded command-plane nonresponse가 증명되면 Core reconciler는 읽을 수 있는 durable outbox tail만 먼저 replay하고, attachment/writer/event-ingress authority를 revoke한 뒤 더는 runner-origin output 완전성을 주장하지 않은 채 현재 중앙 ingress watermark를 가진 `RunnerLostTerminalWitness(category=runner_lost)`를 commit한다. identity가 불명확하거나 foreground progress만 멎은 상태는 이 branch를 만들 수 없다.
3. 비정본 `execution_ended` frame은 host를 깨우기만 한다.
4. host/reconciler는 witness high-watermark까지 event ingress에 replay하고 `TerminalIngressReceipt`를 commit한다.
5. witness의 `deliveryAdmissionCutoffSequence` 이하에서 현재 execution에 bind된 assignment와 execution/request-scoped delivery를 canonical receipt로 정산한다. cutoff 뒤 또는 아직 unassigned인 session delivery는 barrier를 막지 않고 FIFO에 남긴다. 닫히는 execution에 bind됐지만 미소비인 session delivery는 assignment만 `released_for_rebind`로 닫는다. `runner_lost`에서도 runner SQLite의 consume-before-effect slot을 읽어 consumed receipt가 있으면 mirror하고, 없으면 exact unavailability+assignment capability revoke로 future central effect admission을 막은 뒤 session scope는 release, execution/request scope는 `no_effect(reason=runner_lost)`로 끝낸다.
6. 모든 external request를 정산한다. response는 exact request-scoped delivery consumption composite FK, expiry와 user/owner cancel은 runner journal+engine application, execution-finished no-effect는 exact terminal witness FK가 필요하다.
7. stream과 durable host-call journal을 정산한다.
8. Core가 소유한 attachment와 writer에 stale authority가 사용자-visible effect를 낼 수 없다는 `ResourceSafetyReceipt`를 만든다.
9. 고정된 의미 receipt와 두 Core effect-fence receipt를 `TerminalSafetyBarrier`로 commit한다. barrier는 cutoff 값을 복사하지 않고 exact `witnessId`만 가진다. logical execution은 아직 open이다.
10. 별도 `commitVisibleTerminal` transaction이 witness→ingress→barrier FK를 다시 검증하고 `LogicalExecution(terminal)`을 공개한다.

물리 runner 회수 완료는 Core barrier 조건이 아니다. runner의 attachment/writer/event-ingress authority가 revoke되면 더는 Core 사용자-visible effect를 만들 수 있고, 살아 있는 child의 물리 회수는 Core `CleanupObligation`이 계속 맡는다. attachment/writer acquired 뒤 `released`는 physical release receipt가 있어야 하며, 늦은 삭제를 기다리지 않으면 `retained+fence+cleanupObligationId`로 남긴다. Core visible terminal은 physical reap 완료를 기다리지 않지만 exact child의 effect fence와 단일 cleanup owner 없이는 열리지 않는다. terminal retention transfer proof만 Capability B의 `TerminalRetentionSafetyExtension`에서 추가 검증한다.

procedure `session_commit_terminal_safety_v2(...)`는 다음을 한 transaction에서 검증한다.

- 모든 external request가 response delivery consumption, expiry/user cancel runner journal→engine application, execution-finished terminal witness FK 중 자기 kind의 유일한 chain으로 정산됨
- barrier의 `(executionId, witnessId)` FK가 open row의 첫 witness와 같고, 그 witness에서 읽은 cutoff 이하의 current-execution assignment와 execution/request-scoped delivery가 정산됨. cutoff 뒤 또는 unassigned session delivery는 검사 대상에서 제외됨
- witness outbox watermark 이하 semantic event가 ingress receipt에 포함됨
- 두 Core slot의 effect fence가 현재 attachment epoch·writer lease와 일치함
- `released` attachment/writer가 실제 acquire 뒤 fence만 들고 있으면 physical release receipt를 요구하고, `transferred`는 old authority revocation과 new authority id/epoch를 모두 요구함

Core procedure는 exact child의 preterminal cleanup obligation 단일성과 `UNIQUE(resource_kind, resource_id) WHERE physical_resolution_receipt_id IS NULL`을 항상 검증한다. Capability B procedure는 Core barrier와 별개로 retention transfer의 `(newAuthorityId, newAuthorityEpoch, transferReceiptId)`와 current `execution_retentions` composite FK를 추가 검증한다. 이 확장 proof가 없으면 Capability B만 비활성이고 Core terminal은 attachment/writer/event-ingress fence와 child cleanup owner로 판정한다.

검증 실패는 terminal을 지연시키고 obligation/reconcile wake를 유지한다. 재시도 소진으로 barrier를 우회하는 variant는 없다. barrier commit과 visible terminal commit은 별도 transaction이므로 그 사이 crash prefix는 open row의 non-null witness·ingress·barrier로 내구화된다. 반대로 barrier가 commit되면 stale effect는 불가능하므로 물리 삭제가 늦어도 별도 visible terminal CAS를 안전하게 재개할 수 있다.

첫 terminal witness slot은 `(execution_id, execution_command_id)`당 하나다. `finish→fail`, `fail→finish`, `fail→fail` 모두 첫 witness만 outcome이며 late signal은 internal diagnostic이다. host intent나 미확정 liveness 추측은 witness가 아니다. exact PID/start absence만 별도 `runner_lost` witness가 될 수 있고 사용자-visible completed/failed/stopped로 위장할 수 없다.

`deliveryAdmissionCutoffSequence`의 writable owner는 witness 하나다. 값은 witness transaction snapshot에서 이미 admission된 가장 큰 session enqueue sequence이고 `TerminalSafetyBarrier`는 `(executionId, witnessId)` FK를 통해서만 이를 읽는다. barrier에 별도 cutoff column을 두지 않으므로 두 값의 불일치 상태를 만들 수 없다. witness 뒤 binder는 새 assignment를 그 execution에 만들 수 없다. cutoff 이하라도 아직 unassigned인 session delivery는 successor 몫이고, cutoff 뒤 admission도 그대로 FIFO에 남는다. 따라서 terminal barrier는 현재 execution이 실제로 얻은 assignment만 닫으며 session head 존재 자체를 terminal 조건으로 쓰지 않는다.

host shutdown이나 adoption handoff는 execution termination이 아니다. `detachAttachment()`가 higher epoch barrier를 만들고 logical execution과 stream은 open으로 유지한다. `close`, rollback, reconnect exhaustion, `execution_ended`, offline replay는 직접 stream terminal을 쓰지 않으며 위 receipt pipeline을 호출하거나 recovery projection만 바꾼다.

## Core v2 — live runner 재부착

### attachment의 fenced lease

attachment는 socket 존재가 아니라 중앙 DB와 runner journal이 같은 epoch로 승인한 lease다.

1. `session_prepare_runner_attachment_v2(...)`가 higher `PreparedAttachmentGrant`를 만들고 old DB writer를 freeze한다.
2. runner recovery endpoint가 grant를 받아 journal을 `quiescing`으로 CAS하고 이전 epoch command admission을 닫는다.
3. runner는 `settledThrough..acceptedThrough`의 모든 command를 `settled(resultReceiptId)` 또는 `transferred(journalEntryId, resumeAtEpoch)`로 처분한 `RunnerAttachmentBarrierReceipt`를 commit한다.
4. `session_commit_attachment_grant_v2(...)`가 barrier의 빈 구간·중복·누락을 검사하고 새 DB writer lease를 연다.
5. 모든 command와 runner↔host call은 execution/command/attachment epoch·monotonic sequence key를 가진다. host call은 pre-send canonical receipt가 sequence→operation/hash/payload를 고정하고 response는 같은 call key를 FK로 참조한다. `RunnerAttachmentJournal` current epoch/grant와 다르거나 receipt 값이 다른 frame은 effect 수행 전에 no-effect 처리된다.

old host detach는 정확성 전제가 아니다. prepare 전에는 old epoch 하나, quiesce 중에는 writer 0개, commit 뒤에는 new epoch 하나만 effect 권한을 가진다. host는 5초마다 renew하고 TTL은 15초다. runner는 TTL이 지나면 engine을 실패시키지 않고 self-quiesce하여 input/outbox/pending host call을 journal에 보존한다. 기존 30초 host-call timeout은 v2에서 lifecycle failure가 아니라 reconcile wake다.

### open scan과 Core reducer

재부착의 시작점은 등록 디렉터리가 아니라 중앙의 모든 open `CoreLogicalExecution`이다. maintenance tick은 open execution, current attempt, attachment lease, runner registration·SQLite witness, delivery/request ledger를 `executionId/attemptId`로 join한다. 메모리 controller는 불일치 탐지에만 쓴다.

Core reducer의 자동 action은 둘이다.

- stable execution/attempt/command identity를 제시하는 **live runner** + invalid/missing attachment → higher epoch `attach_same_execution`
- exact `(attemptId, pid, startIdentity)` absence → current execution의 `settle_runner_lost`. runner-local durable assignment slot과 중앙 mirror를 정산하고 session-scoped 미소비 delivery를 FIFO에 보존한 뒤, 정상 binder가 새 runner·새 execution을 연다

incomplete/mismatched identity는 같은 fact set에서 `attachment.blocked`로 계산한다. Core는 죽은 runner의 execution context를 새 process에 상속하지 않는다. `runner_lost` visible terminal 뒤 보존된 session delivery가 있으면 평상시 신규-turn admission과 같은 경로로 새 runner·새 execution을 만든다. 이 새 실행은 predecessor의 request, checkpoint, effect inventory를 상속하지 않는다. terminal witness가 먼저 commit되면 attachment mutation은 거부되고 terminal pipeline만 재개한다. 새 메시지·재시작·ping은 wake 가속일 뿐 재부착 전제가 아니다.

등록 디렉터리가 0개여도 open execution이 있으면 due scan이 판정을 시작한다. live proof도 exact unavailability proof도 없으면 “회수할 실행 0개”가 아니라 `blocked(identity_unresolved)` 1개다. exact unavailability가 있으면 `runner_lost` settlement가 due work다. 중앙 execution 없이 registration/PID만 있더라도 known `attemptId`로 join되면 Core cleanup obligation이 due work다. 어느 Core attempt에도 속하지 않는 외부 PID는 진단 대상으로 격리하되 새 attempt namespace의 spawn 판정을 막지 않는다. dead execution context inheritance만 Capability A 소관이다.

운영 수치는 다음과 같다. 이는 저장소 가용성과 fair scheduling 아래의 SLO이며 무제한 worker fail-stop을 포함한 hard correctness bound라고 주장하지 않는다.

| 수치 | 값 | 의미 |
| --- | ---: | --- |
| `EXECUTION_RECONCILE_SCAN_MS` | 5,000ms | due open execution scan 간격 |
| `ATTACHMENT_RENEW_MS` | 5,000ms | lease 갱신 간격 |
| `ATTACHMENT_TTL_MS` | 15,000ms | runner self-quiesce 시각 |
| `ATTACHMENT_TAKEOVER_HANDSHAKE_MS` | 10,000ms | higher epoch barrier 목표 |

Core E5는 live runner proof가 있는 open execution의 eventual reattach와 exact runner absence가 있는 execution의 eventual `runner_lost` settlement를 함께 다룬다. scheduler는 delivery/attachment/terminal due key에 aging을 적용하고 같은 key가 무한히 뒤로 밀리지 않는 no-starvation contract를 제공해야 한다. identity mismatch는 이 보장의 대상이 아니며 blocked로 분리한다.

## Capability A — certified runner replacement

이 절은 1단계 Core 구현·완료 gate에 포함하지 않는다. Core default는 exact death를 `runner_lost`로 정산하고 새 execution을 평상시처럼 시작한다. 이 capability는 그 대신 죽은 runner의 in-flight context·request·effect를 successor에게 **상속**하려는 backend만 별도 opt-in한다. 7일 실측상 우리 노드 runner death는 5건이므로 delivery 종착 Core보다 우선하지 않으며, 향후 계측이 우선순위를 정한다.

Capability A가 훗날 켜지면 exact-absence procedure가 execution row와 capability certificate를 함께 잠그고 `runner_lost` witness와 `continuity_transfer` 중 정확히 하나를 commit한다. capability disabled, certificate missing, proof mismatch 중 하나면 Core `runner_lost`가 이긴다. 두 branch가 같은 predecessor에 함께 생기거나 certificate를 기다리며 open으로 멈추는 상태는 허용하지 않는다.

owner-null open row는 idle·interrupted·가짜 visible terminal로 바꾸지 않는다. stable identity를 찾으면 같은 execution에 backfill하고 higher epoch로 adopt한다. exact process absence가 확인되면 complete `ExecutionContinuityCertificate`가 있을 때만 predecessor의 non-public `ExecutionSupersessionRecord(kind=continuity_transfer)`와 successor reservation을 한 transaction에 commit한다. 이 transaction은 같은 `ExecutionLineageId`를 보존하고 predecessor open unique를 닫으며 successor open을 만든다. 또한 pending request마다 `ExternalRequestAuthorityTransfer`를 기록해 authority execution/epoch와 이미 admitted된 response delivery scope를 옮기고, lineage stop invocation이 있으면 같은 row lock 안에서 binding을 successor로 이동한다. response admission과 replacement는 lineage row 뒤 request id 정렬 순으로 같은 lock을 얻으므로 한쪽의 old epoch write가 남지 않는다. 둘이 동시에 open이거나 둘 다 없는 prefix, 질문은 보이는데 답변 authority는 predecessor인 prefix, stop invocation이 두 execution에 붙는 prefix가 없다.

v2 eligibility는 모든 engine/tool effect boundary에서 다음 effect 전에 continuity certificate를 durable하게 갱신하는 capability test를 요구한다. external non-idempotent effect는 stable operation id로 provider 결과를 재조회할 수 있거나 effect와 local committed receipt가 같은 transaction에 들어가는 경우만 허용한다. `effect committed → certificate commit` 사이 crash 뒤에도 stable operation lookup 또는 same-transaction receipt로 결과를 복원할 수 있어야 한다. certificate에는 checkpoint, consumed input/outbox/host-call watermark, pending request ids, delivery head, 모든 effect의 `not_started/committed/compensated` receipt와 atomicity proof가 있어야 한다. 이 조건을 못 지키는 backend는 v2 replacement capability를 받지 못하고 in-place attachment takeover만 허용된다.

Capability A가 켜진 backend의 process가 certificate 없이 사라지면 inheritance를 시도하지 않고 Core `runner_lost` 정책으로 내려간다. public projection은 그 사이 `not_running/settling`을 보이고 최종 outcome은 `runner_lost`다. 죽은 process가 더는 만들 수 없는 certificate를 기다리는 정상 recovery state는 없다.

Capability A 활성화 gate는 다음 전부다.

- every-effect-boundary `ExecutionContinuityCertificate`와 engine checkpoint가 process death 전에 durable함
- arbitrary non-idempotent provider effect가 stable operation lookup 또는 same-transaction receipt를 제공함
- predecessor `continuity_transfer`와 successor reservation, pending request authority transfer, lineage stop rebinding이 한 transaction임
- process absence, effect commit→certificate commit, pending request answer, stop 경합 failpoint가 모두 GREEN임
- gate가 없는 backend는 Core live-runner adopt만 허용하고 replacement capability를 광고하지 않음

운영 수치 `CLEANUP_OBLIGATION_LEASE_MS=15,000ms`, `PROCESS_ABSENCE_GRACE_MS=15,000ms`, `PROCESS_ABSENCE_SECOND_SCAN_MS=5,000ms`와 cleanup/orphan capacity accounting은 이 capability/운영 cleanup의 SLO다. Core reattach bound에 섞지 않는다.

## Capability B — terminal background retention

이 절도 1단계 Core 구현·완료 gate에 포함하지 않는다. Core terminal은 attachment/writer fence 뒤 공개되고 background continuation이 필요한 backend만 별도 retention capability를 요구한다.

terminal retention은 open-execution scan과 다른 조회 축이다. maintenance tick이 `release IS NULL`인 `execution_retentions`를 lease 시각으로 스캔한다. lease가 유효하면 exact owner/epoch만 renew한다. 만료됐으면 eligible host가 row를 잠그고 `expectedAuthorityEpoch` CAS로 owner를 바꾸며 epoch를 정확히 1 올리고 lease와 `eventRoute.authorityEpoch`를 한 transaction에 갱신한다. background task inventory와 terminal receipts, route id, authority transfer provenance와 cleanup obligation id는 보존한다.

Capability B 활성화 gate는 다음 전부다.

- old attachment/writer revoke와 current `ExecutionRetention` 생성이 한 transfer receipt로 연결됨
- source execution당 current retention과 event route가 각각 하나임
- task별 terminal receipt와 release-reference exact composite FK가 inventory 전량을 증명함
- expired same-row higher-epoch takeover, task effect routing, release 경합 fixture가 GREEN임
- gate가 꺼져 있으면 Core reducer·terminal procedure·public projection이 retention relation을 읽지 않음

release receipt는 retention/epoch/owner/task별 terminal reference/effect-fence/absence를 묶는다. 누락·중복·다른 retention/task receipt는 procedure가 거부하고 release 뒤 renew/takeover/event/effect도 거부한다. 이 proof의 완성도는 Capability B gate이며 Core restart fixture의 전제가 아니다.

## Core v2 — progress와 process liveness

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

session-scoped target execution이 consumption 전에 닫히면 current assignment만 release하고 delivery resolution은 null로 보존한다. inbox 전이면 runner close ack 또는 exact unavailability+assignment capability revoke인 typed registration fence, inbox 뒤면 local `target_terminal_released(engineObservationCount=0)`가 먼저 필요하다. 다만 delivery-level cancel intent가 있으면 rebind transaction이 delivery row를 잠가 cancel과 consume winner를 다시 판정한다. consume가 먼저 이긴 경우 외에는 cancel이 delivery final을 차지하고 successor assignment를 만들지 않는다. cancel이 없을 때만 ordinal을 올려 rebind한다. execution scope는 no-effect로 끝나고 request scope는 current request authority가 successor로 transfer된 경우에만 새 authority epoch로 rebind한다. current unresolved assignment는 마지막 이력의 projection이며 partial unique가 강제한다.

cancel intent와 final winner는 assignment가 아니라 stable delivery row가 소유한다. 따라서 capacity wait로 assignment가 없어도 취소할 수 있고, intent는 모든 ordinal을 관통한다. inbox 전 cancel은 typed registration fence 뒤 delivery `cancelled`로 끝난다. inbox 뒤에는 public `cancel_requested`만 반환하고 local slot의 consume/cancel disposition을 기다린다. local consume가 먼저면 final은 consumed, local cancel이 먼저면 central cancelled뿐이다. target-terminal release가 먼저여도 pending cancel을 지울 수 없고 rebind 직전 delivery lock에서 다시 경합한다. 같은 invocation retry는 delivery-level canonical intent/winner를 반환한다.

request response application은 별도 semantic chain을 만들지 않는다. request operation의 `responded` branch가 가리키는 composite FK는 exact request-scoped delivery의 consumed runner disposition, central mirror, runner input sequence를 모두 묶는다. response admission과 terminal witness는 request+lineage terminal-prefix lock을 같은 순서로 얻는다. 일반 witness first는 delivery 없이 request-keyed `not_applied(execution_finished)`, runner-lost witness first는 `not_applied(runner_lost)`, response first는 exact application이 끝날 때까지 terminal barrier를 통과하지 못한다. pending request authority를 successor로 이전해 질문을 계속하는 것은 Capability A에서만 허용한다.

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

request-scoped 응답·approval의 결과는 request id를 공통 key로 하는 `applied | already_applied | not_applied(expired|cancelled|execution_finished|runner_lost)`다. delivery id는 responded 뒤 실제 delivery가 생기고 소비된 applied 계열에만 있다. deadline 판정은 locked request row의 immutable `expiresAt`과 DB 시각으로 한다. response admission 뒤에는 별도 application 정본을 만들지 않고 exact delivery consumption composite FK가 결과를 확정한다. expiry/cancel만 request operation의 runner journal·engine application chain을 재개하고, runner-lost winner는 exact unavailability witness FK로 끝난다. raw failure는 internal diagnostic에만 남고 외부에는 `PublicOutcome`만 투영한다.

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

Core의 exact `runner_process_absent`는 `execution.open/activity.not_running + availability.delayed + settlement.settling`을 거쳐 distinct `finished(outcome=runner_lost)`로 수렴한다. 이것은 completed/failed/stopped가 아니며 동일 execution을 부활시켰다는 주장도 아니다. `runner_identity_unresolved`와 Capability A의 `continuity_invariant_breach`만 `availability.blocked { incidentId, automaticProgress:false }`다. `running+delayed`나 정상 terminal로 거짓 투영하지 않는다. runner-lost settlement 중에는 stop이 이미 이긴 경우 그 intent를 diagnostic에 보존하되 public outcome을 `stopped`로 바꾸지 않는다. 아직 소비되지 않아 실제 cancel proof를 만들 수 있는 delivery id만 `cancellableDeliveryIds`에 남는다. Core 경계 fixture는 distinct runner_lost terminal, false normal terminal 0, durable input 유실 0을 판정한다.

### durable fact와 복구 창

| 사실 | durable 위치 | 범위 |
| --- | --- | --- |
| logical execution open/terminal과 단조 terminal prefix | 중앙 execution ledger | Core |
| stable runner attempt/execution/command/PID/start identity | `runner_attempts` monotonic receipts | Core |
| prepared/committed attachment writer authority | 중앙 grant + runner accepted epoch journal/barrier | Core |
| user input과 scope/FIFO/input sequence | delivery·assignment ledger + runner inbox + head | Core |
| pending request publication/resolution/application | request ledger + exact application proof | Core |
| current-execution stop intent | lineage control row + execution binding | Core |
| input/outbox/semantic event replay | runner journal + event ingress cursor/id unique | Core |
| terminal ordering | witness + ingress receipt + Core `TerminalSafetyBarrier` + visible CAS | Core |
| 지원 host call의 semantic result | host semantic operation/result ledger | Core 조건부 |
| every-effect checkpoint와 successor lineage | continuity certificate + supersession record | Capability A |
| physical cleanup responsibility | `cleanup_obligations` + unresolved-attempt capacity projection | Core |
| terminal background authority | retention/task/route ledger | Capability B |
| active-v1 writer handoff | promotion fence receipt | Migration |
| progress/process liveness | runner journal + central monotonic projection | Core 관측 |

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

아래 표는 지금까지 검증한 통합 invariant inventory를 보존한다. **Core 3단계 gate는 `[Core]`만 판정**하고, `[Capability A]`·`[Capability B]`·`[Migration]`은 해당 capability를 켜기 전 gate다. 같은 행에 둘이 있으면 앞 문장이 Core 보장, 뒤 문장이 optional extension이다.

### 실행 불변식 16개

| ID | 불변식 | 새 구조에서 위반이 불가능한 이유 | 강제 수단 |
| ---: | --- | --- | --- |
| E1 | session당 open execution 최대 1, identity 일치 | session open unique와 모든 receipt의 execution FK가 같은 key를 요구한다. | DB unique/FK |
| E2 | lifecycle 의미가 하나의 계약에서 나온다 | writable lifecycle은 `open|terminal`뿐이고 세부 phase는 한 declarative reducer가 receipts에서 생성한다. | generated TS/SQL/test |
| E3 | provisional spawn도 실행이다 | child는 open execution의 `RunnerAttempt.spawnReceipt`로만 생기며 attempt가 execution FK 없이 존재할 수 없다. | FK + receipt CAS |
| E4 | 새 identity가 옛 자원과 격리된다 | attempt별 state namespace와 registration composite key, attachment epoch, operation id가 effect 경계마다 검사된다. non-current attempt의 PID·identity 파일은 canonical join 입력이 될 수 없다. | DB/runner fence + attempt namespace |
| E5 | [Core] delivery waiter가 책임과 진행을 잃지 않는다 | delivery/assignment operation은 proof-bearing final 전 due time을 잃지 않는다. live responsive runner면 재부착, exact absence/무응답이면 runner-lost 정산과 session delivery 보존으로 수렴한다. failed-attempt residue는 cleanup lane이 제거해 다음 spawn을 막지 않는다. context inheritance만 [Capability A]다. | durable scan + no-starvation fixture |
| E6 | [Core] delivery·attempt cleanup reconcile은 restart·reserve·message와 독립이다 | 중앙 unresolved delivery/open execution scan과 due cleanup-obligation scan이 시작점이고 live identity는 attachment, exact unavailability는 runner-lost settlement, isolated child는 cleanup worker를 깨운다. | periodic scan + NOT NULL due |
| E7 | [Core] reference clear는 종료가 아니다 | witness, ingress, request application 또는 witness-keyed no-effect, cutoff-bound delivery resolution, attachment/writer effect fence를 가진 `TerminalSafetyBarrier` 없이는 terminal CAS가 거부된다. spawned child의 effect fence·cleanup obligation은 Core, terminal retention은 [Capability B] extension이다. | fixed record + procedure/FK |
| E8 | terminal은 멱등이고 visible 결과는 하나다 | open row가 monotonic witness→ingress→barrier prefix를 보유하고 별도 visible terminal CAS가 첫 outcome만 허용한다. | prefix CHECK + unique/CAS |
| E9 | active operation 관측은 실행과 함께 끝난다 | active operation set은 open execution·attempt·lease에서 계산되며 별도 mutable set이 없다. | projection |
| E10 | [Core/A] activation 실패는 재부착, child cleanup, 또는 정직한 runner-lost 정산이다 | CAS 패자/activation 실패 child는 Core isolation+cleanup obligation으로 canonical join에서 빠진다. canonical live attempt만 같은 execution에 재부착하고 exact absent/nonresponsive attempt는 runner-lost로 닫는다. old execution context를 successor가 잇는 branch만 [Capability A]다. | identity assertion + cleanup/terminal transaction |
| E11 | [Core/A] open execution의 제3상태를 잃지 않는다 | Core `CoreAttachmentProjection`은 reconnecting, exact absence/무응답 `runner_lost`, current identity-unresolved blocked를 구분한다. non-current PID mismatch는 cleanup wake이지 blocked attachment가 아니다. certified replacement projection은 [Capability A]다. | discriminated union + reducer |
| E12 | [Core] rollback은 exact child를 대상으로 하고 책임을 남긴다 | absence/isolation/cleanup receipt가 attempt id+spawn receipt FK+pid+start identity를 요구한다. first kill 실패는 exact absence 또는 단일 Core obligation 없이는 rollback procedure를 끝낼 수 없다. | coupled receipt + composite FK + cleanup partial unique |
| E13 | [Core/A] retry 또는 명시적 책임이 남는다 | Core open execution과 unresolved delivery에는 due time이 있고, failed-attempt child에는 finite cleanup deadline·claim epoch·next wake를 가진 단일 obligation이 있다. context/effect inheritance만 [Capability A]다. | NOT NULL/FK + Core partial unique |
| E14 | execution inventory는 registration과 독립이다 | open execution을 먼저 읽어 full outer join하므로 registration 0건도 회수 대상 0건으로 바뀌지 않는다. | query contract + fixture |
| E15 | [Core/B] acquire/release가 대칭이다 | Core attachment·writer·request·spawned child는 대응 fence와 release 또는 단일 cleanup owner를 요구한다. terminal retention authority만 [Capability B]에서 하나다. | receipt matrix + procedure/unique |
| E16 | durable/process/memory 불일치는 한 의미 계약으로 분류된다 | declarative reducer가 facts를 projection/recovery variant로 바꾸고 메모리는 그 결과를 소비만 한다. | generated exhaustive reducer |

Core E5의 적용 도메인은 proof-bearing unresolved delivery다. 같은 execution/command/PID/start identity의 live responsive runner면 attachment operation과 consumption으로, exact absence/command-plane nonresponse면 runner-lost terminal과 session delivery rebind/no-effect로 eventual settle한다. current attempt identity가 미확정일 때만 `blocked`를 투영한다. non-current attempt PID mismatch는 owning attempt cleanup을 깨우고 새 namespace를 막지 않는다. 죽은 execution의 context·effect·pending request inheritance는 Capability A gate를 통과한 뒤에만 주장한다.

### delivery 불변식 10개

| ID | 불변식 | 새 구조에서 위반이 불가능한 이유 | 강제 수단 |
| ---: | --- | --- | --- |
| D1 | [Core/A] 승인된 session input은 재전송 없이 유효 execution에 도달 | Core에서는 live reattach 또는 runner-lost 뒤 평상시 새 execution에 같은 delivery id로 도달한다. pending request authority/context inheritance만 [Capability A]다. | scope type + cutoff + delivery lock + durable head/wake |
| D2 | assignment는 concrete execution 또는 명시적 unassigned | append-only assignment history 각 row가 exact execution/generation/command payload를 갖고 unresolved row 0개가 unassigned다. current pointer는 projection이다. | partial unique + typed operation payload |
| D3 | [Core/A] consumption 최대 1, durable tombstone | assignment-local slot이 registration close/consume/cancel/target-terminal-release를 직렬화한다. delayed RPC는 capability/close epoch에 막힌다. absence/무응답 뒤 Core runner-lost reconciler는 consumed-before-effect receipt 또는 exact unavailability+revoke proof로 완결한다. context inheritance writer만 [Capability A]다. | runner slot unique/CAS + capability fence + coupled central FK |
| D4 | unknown assignment reconcile 전 재할당 금지 | 기존 history의 unresolved assignment가 있으면 새 ordinal 생성 procedure가 거부된다. `released_for_rebind` 뒤 session scope만 다음 ordinal을 허용한다. | partial unique + append-only ordinal |
| D5 | session FIFO skip 금지 | stored procedure만 head를 읽고 resolved receipt와 같은 transaction에서 다음 head로 전진한다. direct DML은 revoke된다. | head pointer + privilege fence |
| D6 | attachment/activation이 delivery를 다시 깨운다 | open execution reducer 변화가 due assignment scan의 wake를 갱신한다. ping은 전제가 아니다. | trigger/procedure |
| D7 | retry budget·`uncertain`은 책임 종착지가 아니다 | operation은 `consumed|cancelled|no_effect` receipt 전 삭제되지 않고 owner+next wake를 가진다. attempt count가 2,173을 넘어도 final enum으로 바뀌지 않는다. | final CHECK + FK + due CHECK |
| D8 | durable admission 또는 같은 receipt만 success ACK다 | route는 node 결과가 아니라 delivery/idempotency row의 `ReceivedInput`만 반환하며 CAS miss는 canonical reread한다. | generated API union + reread fixture |
| D9 | failure/no-effect 의미가 증명된다 | admission rejection은 durable proof, pre-registration no-effect는 typed close/revoke fence, cancel/consume는 runner disposition+central mirror, internal failure는 public outcome과 분리된다. | proof FK + coupled operation union |
| D10 | 판정은 exact assigned execution receipt만 쓴다 | consumption receipt에 delivery, execution, generation, command, assignment operation/capability, input sequence가 모두 필요하다. request application은 이 exact composite FK만 읽는다. | operation payload + composite receipt join |

### 축소 감사에서 복원·추가한 보장

불변식 26개만으로 r2→r3 삭제를 감사했을 때 다음 보장이 목록 밖이라 누락됐다. 이후 정본 삭제 검토는 이 항목과 r2 원문까지 함께 대조한다.

| ID | 보장 | 구조적 강제 |
| ---: | --- | --- |
| X1 | [Core/A] terminal witness 뒤 admission이 terminal과 교착하지 않는다 | Core witness cutoff와 cutoff-bound barrier가 같은 execution의 정산만 잠그고 session delivery는 평상시 successor execution에 rebind한다. request/context authority transfer만 Capability A다. |
| X2 | [Capability A] certified replacement는 predecessor를 증명 가능하게 닫고 동일 public session lineage를 잇는다 | `continuity_transfer` record와 successor reservation의 단일 transaction, predecessor open→terminal CHECK |
| X3 | [Core] external request expiry/cancel이 runner engine까지 전달된다 | operation-owned central winner→runner `input_request_expired|cancelled` journal→engine application receipt, barrier FK |
| X4 | [Core/A] stale·변조 runner↔host transport가 effect를 내지 않고, effect 뒤 응답 유실도 effect 재실행을 만들지 않는다 | Core pre-send transport receipt·attachment journal fence·지원 tool semantic result ledger. runner 사망 뒤 provider lookup 복원은 Capability A다. |
| X5 | [Migration] active-v1 cutover에 old/new writer가 동시에 유효하지 않다 | `PromotionHandoffFence`, command 전량 처분, old writer revoke·socket close, v2 grant의 단일 commit |
| X6 | [Capability B] terminal 이후 background semantic authority와 event route는 하나이고 release는 exact task 전량 종료 뒤에만 가능하다 | source execution current `ExecutionRetention` partial unique, retention epoch lease·route unique, task별 terminal receipt composite FK·전수 anti-join, expired same-row higher-epoch takeover와 exact release CAS |
| X7 | [Core/A] pre-registration 종료 뒤 늦은 assignment write가 effect를 만들지 않는다 | Core assignment-local close/capability epoch와 stale registration trigger. exact unavailability는 Core runner-lost settlement writer가 닫고, context inheritance extension만 Capability A다. |
| X8 | [Core/A] request response의 application owner와 replacement authority가 하나다 | Core consumed assignment composite FK와 request+terminal-prefix lock. successor request authority epoch CAS는 Capability A다. |
| X9 | [Core/A] public cancel/stop은 stable 대상에 적용된다 | Core delivery-level cancel과 current-execution stop binding. rebind/continuity transfer 경합은 Capability A다. |

Core 구현 전 최소 gate는 X3, X4의 live-runner subset, X7의 assignment fence와 runner-lost disposition, X8의 same-execution request chain, X9의 delivery cancel+current-execution stop이다. X2·X5·X6과 dead-runner **context inheritance**는 각 optional capability를 켜기 전까지 Core gate를 막지 않는다.

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
| epoch-scoped host call이 semantic effect/result까지 소유 | epoch transport attempt + host semantic operation/result ledger | 응답 유실 뒤 effect owner N → semantic owner 1 |
| active-v1 cutover 운영 순서 | `PromotionHandoffFence` receipt FK | writer 공존 가능 경로 1 → 0 |
| terminal 이후 “retention responsibility” 서술 | current `ExecutionRetention` authority + 기존 cleanup obligation | semantic owner 0 → 1, physical owner 추가 0 |
| retention task 전량 종료 aggregate 문자열 | task inventory별 terminal receipt + exact release-reference FK | opaque 전량 주장 1 → 구조화 증거 N |
| stop/interrupt를 ordinary FIFO input으로 처리 | termination intent CAS / execution-scoped interrupt | scope 누출 1 → 0 |
| output exactly-once 주장 | at-least-once transport + semantic-id dedupe | 과장 제거 |
| raw 내부 failure를 외부 반환 | internal diagnostic + `PublicOutcome` | 의미 경계 1 |
| dispatcher `closed`, stream `ended/error` | witness→ingress→barrier→terminal | 분산 terminal writer N → 1 |
| user-visible in-process fallback | durable independent-runner placement wait | fallback 1 → 0 |
| owner-null→interrupted, proof 없는 replacement | identity projection + certificate-only replacement | 사용자-visible 손실 경로 2 → 0 |
| session-scoped PID 후보 병합 | attempt namespace | 이전 잔재 입력 경로 1 → 0 |

직접 field clear, phase assignment, dispatcher stream finish/fail, permit/job lifecycle mutation, recovery saga phase mutation은 삭제 대상이다. 관측용 화면에 phase가 필요하면 generated projection이나 materialized 관측 cache만 읽고, 권위 판단은 `observedAt`을 받은 reducer/SQL function으로 수행한다.

## 적용 순서

각 Core 단위는 독립 커밋·review가 가능하고 최종 gate 전에는 제품 의미를 바꾸지 않는다.

| Core 단위 | 변경 | 종료 시 관측 가능한 결과 | 호환 |
| --- | --- | --- | --- |
| 0. RED 기준선 | delivery 최우선 Core 8 fixtures, runner-lost 경계, 정상 경로, #818·7일 계측·260824 repro-3 기준 고정 | 제품 변화 없음 | 테스트 세션 |
| 1. Core declarative semantics | Core TS projection·runner wire/SQLite·SQL invariant·transition fixture 생성 | Core 9축 shadow projection 비교 가능 | capability reducer 미적용 |
| 2. caller identity·scope | stable delivery/request/stop identity와 scope를 모든 Core caller에서 shadow 기록 | 같은 action의 canonical identity 확인 | v2 ingress off |
| 3. additive Core fact schema | Core logical/attempt·cleanup obligation, attachment, delivery/request/stop, outbox/ingress, terminal, 지원 host result relation 추가 | v1 동작 동일, Core procedure shadow 호출 가능 | row별 semantics write fence |
| 4. live runner attachment | prepared→runner barrier→committed 2단계 fence와 generated epoch wire를 shadow 검증 | same execution/command/PID가 higher epoch로 adopt됨 | Core capability off |
| 5. reconnect-window input | delivery assignment/inbox, request application, current-execution stop을 durable operation으로 구동 | restart 창 input·답변·stop이 canonical receipt로 재개됨 | route는 아직 v1 projection |
| 6. output·terminal·public | outbox overlap replay/dedupe와 witness→ingress→Core barrier→visible terminal, runner-lost delivery settlement 완성 | restart 전후 public trace 동일, exact absence/무응답은 distinct runner-lost와 delivery 보존 | Core capability off |
| 7. Core cutover | caller, DB, attempt cleanup, attachment, delivery, Core host-call, terminal/public capability를 한 transaction에서 활성 | eligible v2 session이 delivery 수렴·live adopt·failed-attempt cleanup 경로 사용 | v1 downgrade 금지, exact unavailability는 runner-lost |

단위 4~6은 gate 뒤에서 함께 완성하고 단위 7에서 한 번만 활성화한다. ingress ACK가 attachment 투명화보다 먼저 v2 의미로 노출되는 창은 없다. shared fixture 하나를 Core fact-ledger factory로 바꾸면 adoption 계약 8개가 따라오고 옛 shape를 기대한 구조 화석 1개만 제거한다.

| 후속 구획 | 별도 적용 단위 | Core와의 관계 |
| --- | --- | --- |
| Capability A | continuity certificate/effect inventory, dead-runner context inheritance, supersession·request/stop transfer | Core runner-lost default를 opt-in backend에서만 대체 |
| Capability B | retention authority/task/route relation과 takeover/release worker | Core visible terminal 뒤 optional extension |
| Migration | legacy cutoff/backfill, active-v1 `PromotionHandoffFence`, rolling coexistence, 구 writer 제거 | Core 신규 v2 경로와 독립 배포 |

## Core v2 스키마와 optional migration

DB 변경은 필요하지만 이 설계에서는 파일을 만들거나 적용하지 않는다. `073_execution_turn_state_machine.sql`은 **additive Core 9축과 신규 v2 row 제약만** 만든다. 기존 v1 row backfill, active-v1 promotion, legacy writer 제거는 이 migration에 넣지 않고 아래 Migration 구획의 후속 번호로 분리한다. Core 구현 커밋은 다음 세 정본만 동형 갱신한다.

1. `packages/db-schema/sql/migrations/073_execution_turn_state_machine.sql`
2. `packages/db-schema/migration-manifest.json`의 checksum·rollback compatibility
3. `packages/db-schema/sql/schema.sql`의 bootstrap 동형 정의

### Core v2 중앙 스키마

`session_execution_ownerships`는 이름을 rolling 동안 유지하되 logical execution ledger 역할을 한다.

- `execution_id` unique, `semantics_version`, `executor_kind`
- `logical_state IN ('open','terminal')`. 세부 phase 컬럼 없음
- reservation receipt, `current_attempt_id`, attachment grant/epoch/lease
- lineage-owned termination intent FK, terminal witness, ingress receipt, terminal safety barrier
- progress receipt, `reconcile_due_at`
- session별 `WHERE logical_state='open'` unique
- v2면 `executor_kind='independent_runner'`
- open row는 monotonic terminal prefix를 허용한다: witness null이면 ingress·barrier도 null, ingress non-null이면 witness 필수, barrier non-null이면 witness·ingress 필수다. barrier 뒤에도 별도 visible commit 전까지 logical state는 open이다
- runner-lost witness branch는 exact `(attempt_id, pid, start_identity)`에 대한 `process_absent | command_plane_nonresponsive` proof와 distinct `public_outcome='runner_lost'`를 요구한다. nonresponsive proof는 reconnect budget, 두 command-plane probe, unchanged durable watermarks, attachment/writer revoke를 모두 참조한다. completed/failed/stopped branch와 공유할 수 없다
- terminal safety barrier는 cutoff 값을 복제하지 않고 `(execution_id, witness_id)` composite FK만 저장한다. delivery cutoff는 witness row에서 파생한다
- Core visible terminal이면 witness·ingress·barrier FK가 모두 non-null이다. `continuity_transfer`와 migration archival branch는 Core CHECK에 없고 해당 optional capability schema가 별도 relation/constraint로 추가한다
- `execution_semantics_v2_projection` generated regular view/SQL function은 declarative reducer가 만든다. transaction `observedAt`을 입력받는 권위 판정이며 application writer 권한이 없다. materialized copy는 관측용으로만 허용한다

Core durable relation은 다음 축뿐이다.

- `runner_attempts`: reservation, spawn, ownership, activation, exact execution/command/PID/start identity, attempt별 state namespace, coupled cleanup state, Core runner-lost 판정용 exact absence/무응답 proof. mutable phase 없음. checkpoint/context inheritance FK만 Capability A extension임
- `cleanup_obligations`: Core가 spawn한 exact attempt child의 유일한 물리 회수 owner. attempt isolation·effect fence, stable cleanup operation, home node, finite deadline, claim epoch/lease/next wake, exact absence receipt를 가진다. 같은 attempt child의 active obligation partial unique와 attempt cleanup composite FK를 강제한다
- `runner_attachment_grants`, `runner_attachment_barrier_receipts`: prepared/committed epoch, old writer freeze, runner accepted command disposition와 watermark. expected epoch+operation id로 재진입함
- `session_deliveries`: stable id, immutable canonical JSONB payload+hash, `DeliveryScope` columns, enqueue/admission 시각, delivery-level cancel intent와 canonical resolution receipt FK. mutable current-assignment pointer와 assignment-level cancel owner 없음
- `session_delivery_assignments`: delivery별 append-only ordinal, exact execution/generation/command, operation FK, final assignment receipt FK. delivery당 unresolved row partial unique
- `session_delivery_heads`: session FIFO head. head 변경은 consumption/cancel/no-effect resolution과 같은 procedure transaction
- `external_requests`: stable request/lineage identity, current Core execution, semantic event id, operation FK와 owner publication/resolution/application proof FK. successor authority epoch/transfer는 Capability A extension임
- `idempotent_operations`: kind별 typed payload, operation id/payload hash, claim epoch/lease/next wake, exact-store stage receipt의 단일 owner
- `runner_host_semantic_operations`와 append-only `runner_host_semantic_result_receipts`: stable operation id PK, immutable canonical request/payload hash, nullable exact result receipt FK, canonical result/hash와 Core-eligible same-transaction/effect-free proof. attachment epoch·transport sequence를 소유하지 않으며 higher epoch transport가 같은 result receipt를 재조회함
- `execution_semantics_control`: stable lineage id, current Core execution pointer, current-execution stop invocation/binding의 단일 owner
- terminal witness/ingress/barrier/visible record와 semantic event id/cursor unique relation

`session_deliveries`의 final resolution CHECK는 `consumed | cancelled | no_effect`만 허용한다. `delivered`, `uncertain`, `queued`, `claimed`는 final enum이 아니라 unresolved projection이며 `resolution_receipt_id IS NULL`, non-null responsibility operation과 `next_wake_at`을 요구한다. legacy `superseded`는 exact target-terminal/cancel proof를 가진 `no_effect`로 backfill한다. retry attempt 수는 이 CHECK를 우회하지 못한다.

runner SQLite에는 generated `runner_attachment_journal_v2`, `runner_host_calls_v2`, `runner_host_responses_v2`, `runner_assignment_disposition_slots_v2`와 `runner_current_attachment_v2` regular projection이 생긴다.

- journal은 epoch accept/revoke receipt의 append-only owner다. `(execution_id, execution_command_id, attachment_epoch, attachment_grant_id, receipt_kind)` key와 monotonic epoch trigger를 가진다.
- call PK는 `(execution_id, execution_command_id, attachment_epoch, host_call_sequence)`이고 `request_receipt_id`는 immutable unique다. `(execution_id, execution_command_id, attachment_epoch, operation_id)`도 unique라 같은 epoch 안에서 operation을 다른 sequence로 바꿀 수 없지만, higher epoch에는 같은 semantic operation의 새 transport attempt를 허용한다. `operation_id`, canonical payload/hash, grant는 PK row의 값이다. UPDATE/DELETE와 direct INSERT는 금지한다.
- call은 wire send 전 generated insert procedure가 canonical payload hash를 계산해 commit한다. call의 epoch/grant는 accepted journal receipt FK를 가져야 하고 insert/effect trigger는 `runner_current_attachment_v2`와 exact equality를 요구한다.
- response는 call PK와 `request_receipt_id`를 FK로 참조한다. operation id·request payload hash·grant 불일치는 trigger가 거부한다. `semantic_result_receipt_id`, result hash와 canonical result는 host semantic ledger의 exact receipt를 가리키며 higher epoch retry response도 같은 receipt를 참조한다.
- assignment slot은 `(assignment_id, operation_id)` PK, monotonic `assignment_capability_epoch/highest_claim_epoch`, nullable inbox receipt와 exactly-one final disposition/close receipt를 가진다. generated registration procedure는 stale claim/capability와 `closed_before_registration` 뒤 insert를 거부한다. exact-unavailability central revoke watermark는 새 runner endpoint open 전 local close tombstone으로 import해야 한다. Core runner-lost writer는 consumed-before-effect receipt를 mirror하거나 exact unavailability+revoke proof로 old assignment를 release/no-effect 정산한다. successor에게 context/request authority를 넘기는 disposition extension만 Capability A다.

이 relation은 중앙 execution row나 semantic result의 복사본이 아니라 runner-local attachment/call transport admission journal이다. 중앙 host-call settlement는 transport watermark와 host semantic result receipt를 함께 참조한다.

Core 밖 relation은 같은 migration에 섞지 않고 capability별 gate가 열릴 때 별도 추가한다.

- **Capability A**: `execution_continuity_certificates`, `execution_supersessions`, successor request/stop authority transfer, provider-effect proof extension과 context-inheritance writer 권한. Core cleanup obligation과 exact absence receipt를 소비할 수는 있지만 새 cleanup authority를 만들지 않는다
- **Capability B**: `execution_retentions`, immutable retained task inventory, task별 terminal receipt, release-reference relation과 current authority/route lease
- **Migration**: `execution_promotion_handoff_receipts`, legacy detach barrier, session semantics cutover/backfill control

삭제되는 계획 table은 `execution_reconcile_jobs`의 saga phase, `execution_runner_process_permits`, `execution_spawn_cleanup_jobs`, `execution_post_terminal_maintenance`다. Core reconcile scheduling은 open execution의 `reconcile_due_at`과 exact attempt의 단일 `cleanup_obligations.next_wake_at`에만 있다. node process/orphan capacity는 별도 writable permit이 아니라 unresolved `runner_attempts.cleanup`의 regular projection이다.

application role의 Core execution, attempt, delivery/head, request, operation, host semantic result direct DML은 revoke한다. Core procedure가 강제하는 핵심 제약은 다음과 같다.

- `session_reserve_execution_v2`: session open unique, capability, independent executor
- `session_record_runner_attempt_*_v2`: receipt는 null→value만, stable launch operation당 child 최대 1
- `session_record_attempt_rollback_v2`: exact spawn receipt를 잠그고 rollback result를 `released(exact absence)` 또는 `isolated_pending_cleanup(effect fence + 단일 Core obligation)` 중 하나로 commit한다. cleanup 책임 없는 rollback error와 non-current attempt의 canonical registration join을 거부한다
- `session_claim_attempt_cleanup_v2`: due Core obligation을 expected claim epoch로 취득하고 exact attempt PID/start identity만 TERM→force-reap할 lease를 연다. fail-stop claim은 higher epoch가 같은 stable operation으로 재개한다
- `session_complete_attempt_cleanup_v2`: exact absence receipt를 attempt cleanup state와 obligation에 한 transaction으로 연결하고 capacity/orphan projection에서 제거한다. 다른 attempt PID, 누락 spawn receipt, stale claim epoch completion을 거부한다
- `session_prepare/commit_attachment_grant_v2`: higher epoch와 gap-free accepted command disposition
- `session_settle_runner_lost_v2`: exact attempt/PID/start의 process absence 또는 bounded command-plane nonresponse, attachment·writer·assignment capability revoke, current central ingress watermark, runner-local disposition slot을 검증한다. nonresponse는 output stall이 아니라 reconnect budget과 health probes로만 구성한다. 읽을 수 있는 outbox tail은 선행 replay하되 unavailable tail을 기다리며 open으로 멈추지 않는다. current execution에 distinct runner-lost witness를 쓰고 execute waiter를 durable terminal projection으로 settle하며, consumed receipt를 mirror하고 미소비 session delivery는 assignment만 release하며 execution/request delivery는 proof-bearing no-effect로 닫는다
- `session_prepare/resolve_runner_host_semantic_operation_v2`: canonical transport call을 검증하고 stable operation row를 잠근다. request hash 불일치는 거부한다. Core가 지원하는 same-transaction/effect-free tool은 resolved row를 재실행하지 않고 같은 semantic result receipt를 반환한다. stable provider lookup과 runner 사망 뒤 effect recovery는 Capability A다
- `session_accept_input_v2`: stable id/payload/scope admission
- `session_prepare/resolve_operation_v2`: kind별 payload, exact-store receipt 순서, operation/payload composite FK, monotonic claim
- `session_publish_external_request_v2`: publication receipt와 immutable `publishedAt/expiresAt`을 한 commit에 기록
- `session_resolve_external_request_v2`: request authority+deadline+lineage terminal prefix를 같은 lock order로 잡는다. 일반 witness first는 execution_finished, runner-lost witness first는 runner_lost no-effect를 exact witness FK로 남긴다. response first는 request-scoped delivery+exact consumed assignment composite FK다. expiry와 user/owner cancel은 runner journal·engine application receipt를 검증한다
- `session_create_delivery_assignment_v2`: delivery cancel intent를 먼저 잠그고 append-only ordinal, unresolved partial unique, assignment operation/claim/capability epoch를 만든다. witness cutoff 뒤 current target assignment와 pending cancel delivery rebind를 금지한다
- `session_request_delivery_cancel_v2`: stable delivery row에 invocation을 CAS한다. assignment 유무·ordinal과 무관하며 final winner가 없으면 rebind보다 우선한다
- `session_resolve_delivery_v2`: runner slot disposition 또는 typed close-before-registration/exact-absence+capability-revoke proof를 검증하고 scoped no-effect/rebind와 head advance를 commit한다. consume가 먼저인 경우 외 pending delivery cancel은 central cancelled이고 rebind 금지다
- `session_request_stop_v2`: stable lineage/invocation intent를 current open execution에 bind한다. Core에서는 같은 execution 안에서 binding epoch 하나만 허용한다
- `session_record_terminal_witness_v2`: runner-origin/preactivation/runner-lost 중 first witness와 현재 delivery admission cutoff를 한 CAS로 기록. runner-lost branch는 exact `RunnerUnavailabilityProof` 없이 호출 불가
- `session_commit_terminal_safety_v2`: barrier의 witness FK에서 cutoff를 읽고 witness watermark, request/delivery/stream/host-call resolution과 attachment/writer effect-fence를 검증
- `session_commit_execution_terminal_v2`: witness→ingress→barrier 뒤 first visible terminal

Optional capability procedure는 Core API와 분리한다.

- **Capability A**: `session_replace_execution_v2`, checkpoint/context inheritance disposition writer, provider lookup effect settlement, successor request/stop authority transfer. attempt isolation·cleanup은 Core procedure를 재사용한다
- **Capability B**: `session_transfer/renew_execution_retention_v2`, `session_record_execution_retention_task_terminal_v2`, exact task-terminal release
- **Migration**: `session_promote_execution_v2`와 legacy detach/promotion handoff 검증

Core에서 같은 exact child의 active cleanup obligation은 partial unique 하나다. child의 `released`는 never-acquired/exact absence만, live fenced child는 retained+obligation만 허용한다. attachment/writer의 acquired 뒤 `released`는 fence와 physical release receipt를 모두 요구한다. 모든 `transferred`는 old revocation, transfer receipt, new authority id/epoch, 기존 obligation FK를 함께 요구한다. Capability A는 이 Core receipt를 replacement gate의 입력으로 읽을 뿐 exact child의 두 번째 cleanup owner가 될 수 없다.

Capability B의 retention/background runtime은 terminal 뒤에도 attachment를 유지할 수 있지만 authority가 모호하지 않다. barrier 전에 old execution attachment/writer epoch를 revoke하고 `execution_retentions` current row를 authority transfer receipt와 함께 commit한다. `UNIQUE(source_execution_id) WHERE released_at IS NULL`과 `UNIQUE(event_route_id) WHERE released_at IS NULL`이 current owner와 semantic event route를 각각 하나로 고정한다. 모든 background event/effect는 `(retention_id, authority_epoch)`를 가지고, unexpired current lease와 immutable task inventory에 모두 들어 있을 때만 ingress가 받는다. task terminal procedure는 exact current authority와 task inventory row를 잠그고 terminal receipt를 task별 한 번만 append한다. terminal safety extension의 transferred receipt는 retention row의 id/epoch와 기존 cleanup obligation FK를 함께 가리킨다.

Capability B의 retention maintenance scan은 terminal logical row와 무관하게 unreleased current row를 읽는다. owner fail-stop으로 lease가 만료되면 takeover branch가 row lock+expected epoch CAS로 owner/epoch/lease/event-route epoch만 교체한다. task inventory, task terminal receipts, route id, transfer provenance, cleanup obligation은 보존한다. 두 host 중 하나만 `+1`에 성공한다. 모든 inventory task에 exact terminal receipt가 있고 release-reference set과 양방향 anti-join이 0건이며 effect fence/absence가 증명될 때만 current epoch owner 또는 certified cleanup worker가 같은 row에 typed `ExecutionRetentionReleaseReceipt`를 commit하고 event route를 닫는다. release와 takeover/renew가 경합해도 row lock의 한 winner만 남고 release 뒤 higher epoch 취득은 불가능하다.

## Migration — active-v1 promotion과 backfill

### legacy live data migration 순서

2026-08-23 실측 기준 기존 row는 6,319개다: active 2, identity_proven 2, reserved 1, failed 5,804, terminal 510. 새 세 컬럼은 없다. 구현 직전 같은 query를 다시 실행한다.

1. 후속 migration에서 `execution_id`, `semantics_version`, `executor_kind`, logical/receipt/lease/due 필드를 nullable로 추가한다. 새 table과 NOT VALID 제약을 만든다.
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

Core 구조는 동결하되 세 구현 선택이 남아 있다.

1. no-starvation scheduler: continuous 신규 backlog에서도 ready Core attachment key와 due attempt-cleanup obligation이 무한 추월당하지 않아야 한다. aging/queue discipline과 최대 추월 metric은 구현에서 정하고 delivery backlog·orphan cleanup backlog fixture를 반드시 통과한다. dead execution의 continuity replacement queue discipline만 Capability A gate에서 확장한다.
2. one-shot launcher: Core는 same live execution을 재부착할 때 process를 다시 spawn하지 않고, runner-lost 뒤 평상시 **새 execution**을 열 때 stable launch operation 하나가 child를 최대 하나만 만들도록 요구한다. 죽은 execution의 same-command checkpoint successor를 만드는 extension만 Capability A다. pidfd helper·전용 launcher 선택은 구현 결정이다.
3. tool fixture 경계: Core fixture 2는 `(a)` stable Core host operation/result ledger가 있는 지원 tool 또는 `(b)` runner-local/effect-free/idempotent tool 중 하나로 고정한다. 어느 경계를 첫 구현에 택할지는 C 결정이지만, runner 사망 뒤 arbitrary non-idempotent provider effect 복원을 Core 성공 조건에 섞을 수 없다.

Capability A/B와 Migration cutover 단위를 session 또는 node 중 어디에 둘지는 후속 운영 선택이다. 각 optional capability는 자기 gate를 통과하기 전 Core reducer·routing 입력이 될 수 없다.

## Core v2 설계 검증 및 3단계 RED 조건

3단계 진입 gate는 **delivery 종착 + live-runner host-restart + failed-attempt residue 회수**의 아래 여덟 Core fixture다. 실측 미소비 10%와 직접 연결된 input·request·completion fixture를 먼저 두고, 우리 노드 1위 실패 30건과 직접 연결된 `activate-rollback`을 Core fixture 8로 승격한다. fixture 1~7은 시작·restart 직전·재부착 직후에 `runner PID/start identity가 살아 있음`을 assert한다. execution id와 command id는 고정되고 attachment epoch만 단조 증가한다. fixture 8은 CAS 패자 attempt와 winning/current execution을 분리해 판정한다.

| # | Core fixture | 필수 trace·판정 |
| ---: | --- | --- |
| 1 | restart window user input admission | 호출자는 durable `received`를 받고, 같은 delivery id·payload·runner input sequence가 재부착 뒤 정확히 한 번 consume된다. 503·재전송 요구·context event 소실이 없다. |
| 2 | AskUserQuestion 대기 중 restart 후 답변 | 같은 execution id와 request id를 유지하고 질문을 재게시하지 않는다. 답변 admission·application 또는 immutable deadline expiry가 한 winner이며 fabricated delivery id가 없다. |
| 3 | terminal witness/outbox 전송 사이 restart | witness→ingress watermark→completion delivery/host-call 정산→Core barrier→visible terminal CAS의 어느 prefix에서 죽어도 output·completion notification·최종 결과가 각각 한 번 종결된다. `uncertain` 재시도로 빠지지 않는다. |
| 4 | assistant output 생성 중 host kill/restart | 2단계 attachment fence 뒤 같은 execution/command가 계속되고, outbox overlap replay를 semantic event id로 dedupe해 output 누락·중복이 0이다. |
| 5 | tool call 대기 중 host kill/restart | 구현 결정 C에서 정한 지원 host operation/result ledger 또는 runner-local/effect-free tool을 쓴다. pending call/result는 higher epoch에서 같은 stable operation/result를 재조회하며 effect count가 1이다. |
| 6 | restart 직전/중 stop | stable invocation의 durable intent가 current execution에 한 번 bind된다. ACK는 `stop_requested`, `stopped`는 witness·Core barrier·visible terminal 뒤 한 번뿐이다. |
| 7 | 같은 시나리오 연속 N회 restart | 매 회 PID/start identity·execution/command가 유지되고 epoch만 증가한다. accepted input 유실·semantic output 중복·사용자 재동작·최종 결과 차이가 모두 0이다. |
| 8 | `activate-rollback` child kill 실패 | 예약 CAS 패자 attempt가 child spawn 뒤 first kill에 실패한다. exact isolation+Core cleanup obligation이 commit되고 다음 attempt는 다른 namespace에서 `pid evidence disagrees` 없이 spawn한다. cleanup worker가 `cleanupDeadlineAt` 안에 exact PID/start child를 회수해 physical process count와 orphan quota를 원복한다. 그 사이 admission된 delivery는 같은 id로 보존·소비되며 사용자 재전송, 가짜 running/terminal이 없다. |

공통 합격 기준은 **사용자 재전송·재클릭 0, accepted input 유실 0, proof 없는 final 0, semantic output 중복 0, 정상 경로 회귀 0**이다. fixture 1~7은 execution/command identity 유지와 최종 결과 동일을 추가로 요구하고, fixture 8은 current/winning execution identity 보존, failed attempt canonical-join 제외, exact orphan process count 원복을 요구한다. 각 delivery는 `consumed | cancelled | no_effect(proof)` 또는 unresolved+owner+`nextWakeAt` 중 정확히 하나여야 하고 `uncertain`은 생성 불가다. 이 여덟 fixture는 Core 9축만으로 판정할 수 있어야 한다. Capability A/B 또는 Migration relation이 없어서 fixture를 만들 수 없다면 Core 범위 분리가 잘못된 것이다.

Core attachment failpoint는 `prepared grant commit`, `old DB writer freeze`, runner의 old admission close·accepted epoch/command disposition/watermark barrier commit, 중앙 exact receipt 검증, committed grant 사이마다 둔다. 어느 prefix에서 host가 다시 죽어도 **같은 attachment operation id**로 재진입하며 새 grant를 중복 생성하거나 old/new writer를 동시에 열지 않는다.

Core cross-store failpoint는 request publication, response-vs-expiry, assignment RPC send, runner inbox insert, runner consume, central mirror, outbox ingress, terminal prefix 사이에 둔다. stale claim·capability와 epoch가 다른 runner↔host frame은 effect 전에 거부하고 durable payload만으로 replay한다. current execution 안에서 request/stop/terminal의 winner와 public projection이 재기동 전후 같아야 한다.

기준선은 그대로 보존한다. `restart-adopt` GREEN과 `restart-intervention-window` RED의 실측 차이가 Core 범위의 근거다. #818은 shared fixture 한 곳 변경으로 8계약 유지·구조 화석 1개 제거, 단일 terminal 전환 기존 green 파단 0, disposition decision table 37 passed를 재현한다. normal steady-state와 pure adopt는 GREEN을 유지하고 restart-window 503·input/context 소실을 RED로 고정한다. attempt budget을 2,174회까지 밀어도 `durable_next_turn`과 `completion_notification`이 `uncertain` final을 만들지 않고 proof-bearing resolution 또는 due owner로 남는 fixture를 추가한다.

fixture 1~7의 canonical runner가 사라지거나 bounded command-plane probe에 응답하지 않으면 live-runner transparency 판정을 중단하고 별도 `runner_lost` 경계 fixture로 전환한다. exact unavailability 전에는 current identity-unresolved blocked 또는 reconnecting이고, proof 뒤에는 `not_running/settling → finished(runner_lost)`여야 한다. execute waiter reject·영구 pending, completed/failed/stopped 위장, 동일 execution 부활, accepted input 삭제는 모두 RED다. runner-local consumed receipt는 중앙 consumed로 mirror하고, 미소비 session delivery는 같은 delivery id로 새 runner/new execution에서 consume되며, execution/request delivery는 exact runner-lost no-effect로 끝나야 한다. 자동 context/checkpoint inheritance는 Capability A gate 전에는 시도하지 않는다.

### Optional capability activation gate

- **Capability A**: Core의 exact unavailability·cleanup receipt를 전제로 every-effect-boundary continuity certificate, provider lookup proof, predecessor `continuity_transfer`+successor reservation, pending request/stop authority transfer, certified assignment recovery writer를 함께 검증한다. `waiting_for_you → process absence → replacement → answer`, external effect commit→certificate failpoint, successor rebind/cancel/stop 경합은 이 gate 소관이다.
- **Capability B**: current retention authority/epoch/route, immutable task inventory, task별 terminal receipt와 exact release-reference 전수, takeover/renew/release CAS를 검증한다. Core terminal fixture를 막지 않는다.
- **Migration**: 6,319행 nullable→backfill→validate→NOT NULL dry-run, duplicate-open proof-bearing archival, active-v1 `PromotionHandoffFence`, accepted command 전량 처분, old writer revoke·socket close, v1/v2 DB write fence와 rollback routing을 검증한다.

declarative generation·drift CI는 Core schema에서 `CoreTaskExecutionProjection`, orthogonal public projection, kind별 Core operation, attempt cleanup, runner attachment/wire/assignment slot, `reduce(facts, observedAt)`, SQL regular view와 위 여덟 transition fixture를 만든다. Capability A/B/Migration schema는 별도 생성 산출물이며 Core build가 import하지 않는다.

## 중간 결론

Core v2는 **delivery의 증명 가능한 종착, live-runner host-restart transparency, failed-attempt residue가 다음 runner를 막지 않는 물리 진입 안전성**만 먼저 구현한다. 그 범위에는 logical execution/terminal prefix, attempt별 namespace·cleanup과 exact unavailability를 포함한 stable attempt identity, 2단계 attachment grant, delivery/assignment/inbox, external request application, current-execution stop, outbox/ingress, terminal safety, 지원 tool result라는 9축이 필요하고 충분하다.

정상과 재기동은 같은 admission·assignment·request·output·terminal receipt를 통과한다. 따라서 live-runner 범위에서 재시작 유무가 입력 승인 의미, 출력, 최종 결과, 필요한 사용자 조작을 바꾸지 않는다. failed attempt는 exact namespace에서 격리·회수되어 다음 attempt의 PID 증거가 될 수 없다. canonical runner가 사라지거나 command plane이 무응답이면 Core는 거짓 연속성을 만들지 않고 current execution을 distinct `runner_lost`로 정산하며 미소비 session delivery를 새 execution까지 보존한다.

죽은 runner의 certified context/effect/request inheritance, terminal background retention, active-v1 promotion은 삭제한 설계가 아니다. 각각 Capability A, Capability B, Migration으로 분리했고 자기 gate를 통과하기 전 Core의 reducer·routing·3단계 진입 조건에 들어오지 않는다. 7일 계측상 Core의 우선순위는 사용자 메시지 미소비 20/200, 최대 2,173회 `uncertain` 재시도, 우리 노드 1위 `pid evidence disagrees` 30건이다. runner death 5건의 transparent inheritance는 여전히 Capability A다.
