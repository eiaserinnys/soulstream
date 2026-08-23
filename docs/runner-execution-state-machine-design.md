# 실행 턴 1급 상태기계 재설계

기준 커밋: `9a0cb300` (2026-08-23)

상태: 설계 초안. 제품 코드, DB 마이그레이션, 배포는 이 문서의 범위가 아니다.

## 판정 기준

이 설계의 성공 조건은 하나다.

> 사용자와 실행 중인 에이전트는 서버 재시작을 알 수 없어야 한다. 대시보드가 내려가는 것과 전달이 보장된 지연만 허용한다. 오류, 503, 재시도 요구, 턴 중단, 응답 누락, 중복, 컨텍스트 유실은 모두 실패다.

따라서 “실패를 정직하게 알렸다”, “큐에 넣었다고 알려 줬다”, “다시 보내면 된다”는 수용되지 않는다. 정상 경로와 재기동 경로가 같은 입력 승인 계약, 같은 출력 스트림, 같은 최종 결과를 사용해야 한다.

## 설계 결정 요약

현재 결함의 뿌리는 러너가 아니라 **실행 중인 한 턴을 나타내는 1급 개념의 부재**다. 다음 여섯 결정을 함께 적용한다.

1. `Task`의 실행 관련 optional 필드 12개를 항상 존재하는 `execution: TaskExecutionController` 한 필드로 바꾼다.
2. 실행은 `idle`, `reserved`, `provisional`, `activating`, `active`, `recovering`, `terminating`, `terminal`의 판별 유니온이다. provisional spawn은 활성화 전이라도 이미 실행이다.
3. 획득은 `begin()`에서, 해제는 `terminate()`에서만 일어난다. 필드 삭제는 상태 전이가 아니다.
4. dispatcher의 접속 수명과 실행 수명을 분리한다. `detachHost()`는 접속만 반납하며 실행을 종료하거나 스트림을 실패시키지 않는다.
5. 중앙 DB의 열린 실행 inventory를 주기 스캔의 출발점으로 삼는다. 등록 디렉터리는 증거이지 inventory가 아니다.
6. 모든 사용자 입력은 먼저 durable delivery로 승인한 뒤 정확한 `executionId`에 할당한다. 호출자에게는 정상·복구 여부와 무관하게 같은 `accepted` 응답만 반환한다.

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
- 260823 사고 표본에서는 runner lifecycle이 `failed`였고 등록이 사라졌는데도 중앙 ownership과 host 실행 대기가 남았다. runner를 죽인 뒤에도 새 reserve가 없으므로 회수가 시작되지 않았다. 두 intervention은 옛 command에 `claimed`로 남았고, attempt 소진 delivery는 `uncertain`에서 다시 스캔되지 않았다.

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
type IsoDateTime = string & { readonly __brand: "IsoDateTime" };

interface ExecutionKey {
  sessionId: string;
  executionId: ExecutionId;
  ownershipGeneration: number;
  entryPath: "initial" | "auto_resume" | "adopt" | "replacement";
  createdAt: IsoDateTime;
}

interface ExecutionReservation {
  key: ExecutionKey;
  ownerKind: "runner_process" | "adopted_runner" | "in_process";
  manifestId: string;
  runtimeEnvIdentity: string;
  reservationExpiresAt: IsoDateTime;
}

interface SpawnedChildProof {
  registrationId: string;
  pid: number;
  startIdentity: string;
  executionCommandId: string;
}

interface ExecutionOwnership extends ExecutionReservation, SpawnedChildProof {
  activatedAt: IsoDateTime;
}

type ExecutionProgressKind =
  | "assistant_message"
  | "thinking"
  | "tool_result";

interface ExecutionProgress {
  sequence: number;
  kind: ExecutionProgressKind;
  progressedAt: IsoDateTime;
  progressLeaseExpiresAt: IsoDateTime;
  inFlightTools: ReadonlyArray<{
    toolUseId: string;
    absoluteLeaseExpiresAt: IsoDateTime;
  }>;
}

interface ExecutionWaiters {
  activation: Deferred<void>;
  terminal: Deferred<ExecutionTerminalRecord>;
  interrupt: SerializedCommandSlot<boolean>;
}

interface ExecutionInputSet {
  assignedDeliveryIds: ReadonlySet<DeliveryId>;
  nextExpectedEnqueueSequence: bigint;
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

interface InProcessAttachment {
  kind: "in_process";
  engine: EnginePort;
  eventStream: ProcessFrameStream;
  hostResources: RunnerHostResourceLedger;
}

type ExecutionAttachment =
  | LiveRunnerAttachment
  | OfflineReplayAttachment
  | InProcessAttachment;

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
}

interface ExecutionTerminalRecord {
  key: ExecutionKey;
  firstSignal: ExecutionTerminalSignal;
  committedAt: IsoDateTime;
  deliveryResolution: "settled";
  cleanup: ExecutionCleanupReport;
}

type TerminationSubject =
  | { kind: "reservation"; reservation: ExecutionReservation }
  | {
      kind: "provisional_child";
      reservation: ExecutionReservation;
      child: SpawnedChildProof;
      attachment: ExecutionAttachment;
    }
  | { kind: "owned"; ownership: ExecutionOwnership; attachment: ExecutionAttachment };

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
      attachment: ExecutionAttachment;
      waiters: ExecutionWaiters;
      inputs: ExecutionInputSet;
    }
  | {
      phase: "activating";
      ownership: Omit<ExecutionOwnership, "activatedAt">;
      attachment: ExecutionAttachment;
      waiters: ExecutionWaiters;
      inputs: ExecutionInputSet;
    }
  | {
      phase: "active";
      ownership: ExecutionOwnership;
      attachment: ExecutionAttachment;
      mode: "foreground" | "background_retained";
      progress: ExecutionProgress;
      waiters: ExecutionWaiters;
      inputs: ExecutionInputSet;
    }
  | {
      phase: "recovering";
      ownership: ExecutionOwnership;
      method: "host_reattach" | "adopt" | "offline_replay";
      evidence: ExecutionRecoveryEvidence;
      progress: ExecutionProgress;
      waiters: ExecutionWaiters;
      inputs: ExecutionInputSet;
    }
  | {
      phase: "terminating";
      subject: TerminationSubject;
      firstSignal: ExecutionTerminalSignal;
      termination: Promise<ExecutionTerminalRecord>;
      waiters: ExecutionWaiters;
      inputs: ExecutionInputSet;
    }
  | {
      phase: "terminal";
      record: ExecutionTerminalRecord;
    };

interface TaskExecutionController {
  readonly current: TaskExecution;
  begin(input: BeginExecutionInput): Promise<ExecutionReservation>;
  attachSpawn(
    executionId: ExecutionId,
    child: SpawnedChildProof,
    attachment: ExecutionAttachment,
  ): Promise<void>;
  activate(executionId: ExecutionId): Promise<ExecutionOwnership>;
  beginRecovery(input: BeginExecutionRecoveryInput): Promise<void>;
  recordProgress(executionId: ExecutionId, progress: ExecutionProgress): Promise<void>;
  assignDelivery(executionId: ExecutionId, deliveryId: DeliveryId): Promise<void>;
  requestInterrupt(executionId: ExecutionId): Promise<boolean>;
  terminate(
    executionId: ExecutionId,
    signal: ExecutionTerminalSignal,
  ): Promise<ExecutionTerminalRecord>;
  awaitTerminal(executionId: ExecutionId): Promise<ExecutionTerminalRecord>;
}

interface Task {
  // 기존 도메인 필드
  readonly execution: TaskExecutionController;
}
```

`Task.execution`은 required다. 자원이 없는 이유는 `undefined`가 아니라 phase가 말한다. 아직 시작하지 않았으면 `idle`, 자식이 아직 없으면 `reserved`, 자식을 만들었지만 활성화 전이면 `provisional`, 회수 중이면 `recovering`, 자원을 정산했으면 terminal record를 가진 `terminal`이다. “없음”, “해당 없음”, “치웠음”이 같은 값이 되는 경로가 사라진다.

`executionId`는 예약 전에 host가 생성하는 논리적 턴 identity다. `executionCommandId`는 runner command identity이므로 provisional spawn에서 붙는다. 둘을 합치지 않는다. delivery는 앞의 논리적 identity에 속하고 runner receipt는 뒤의 command identity까지 증명한다.

## 상태 전이표

| 현재 | 계기 | 다음 | 필수 durable 효과 | 금지 |
| --- | --- | --- | --- | --- |
| `idle` 또는 `terminal` | 새 입력 head 승인 | `reserved` | 새 execution row와 generation CAS | runner spawn 선행 |
| `reserved` | 정확한 child spawn 성공 | `provisional` | child proof를 execution row와 runner witness에 기록 | 활성화 전 실행 부재로 취급 |
| `reserved` | reserve 취소·만료 | `terminating` | first terminal signal CAS | reservation 필드만 삭제 |
| `provisional` | ownership proof 성공 | `activating` | proof CAS | sidecar 재독만으로 child identity 교체 |
| `provisional` | proof·parent init 실패 | `terminating` | exact spawned child proof로 rollback | 현재 등록 PID 추측 종료 |
| `activating` | activation ACK | `active` | active CAS, activation waiter resolve | delivery 선할당 |
| `activating` | activation 실패 | `terminating` | failure signal CAS | promise만 reject하고 child 방치 |
| `active` | host attachment 상실 | `recovering` | recovery wake 기록 | stream fail, execution terminal 처리 |
| `recovering` | 같은 identity reattach/adopt | `active` | attachment epoch 갱신 | 새 execution 생성 |
| `recovering` | durable terminal witness | `terminating` | witness를 first signal로 CAS | 늦은 host 오류로 덮기 |
| `active` 또는 `recovering` | runner terminal·interrupt·reaper 증명 | `terminating` | first signal CAS | 직접 `finish()`/`fail()` 분기 |
| `terminating` | 정산 완료 | `terminal` | terminal row, delivery resolution, cleanup report | waiters를 남긴 채 field clear |
| `terminal` | 다음 유효 입력 | 새 `reserved` | 새 `executionId` | terminal record 재사용 |

모든 mutation은 controller의 `transition(expectedExecutionId, expectedPhase, next)` CAS를 거친다. 이전 실행의 callback은 execution id가 다르면 관측만 기록하고 현재 실행의 자원에 접근할 수 없다.

## 획득과 해제의 대칭

### 획득 경계

`begin()`은 다음을 한 원자적 책임으로 묶는다.

1. session별 controller mutex를 획득한다.
2. 현재 phase가 `idle` 또는 `terminal`인지 확인한다.
3. `executionId`, generation, activation/terminal/interrupt waiter를 만든다.
4. 중앙 execution row를 `reserved`로 기록한다.
5. 메모리 상태를 `reserved`로 게시한다.
6. mutex를 놓는다.

spawn은 그 뒤에 일어나지만, 성공 즉시 `attachSpawn()`이 exact child proof와 attachment resource ledger를 함께 `provisional`에 넣는다. 그래서 activation 전 실패도 “실행이 없었다”가 아니라 terminalize해야 할 실행으로 남는다.

### 해제 경계

`terminate(executionId, signal)`만 실행을 끝낸다. 같은 execution에 대한 모든 호출은 하나의 memoized termination promise를 돌려받는다. 첫 호출만 first-signal CAS를 이기고 나머지는 late signal 진단으로 남는다.

해제 순서는 다음으로 고정한다.

1. 해당 execution으로의 새 delivery bind와 interrupt 시작을 닫는다.
2. first terminal signal을 중앙 execution row에 CAS한다.
3. runner outbox와 IPC journal의 terminal 이전 frame을 event ingress receipt까지 drain한다.
4. 할당된 delivery attempt를 consumed, unconsumed, reconcile_pending 중 하나로 정산한다.
5. `ProcessFrameStream.terminate(firstSignal)`로 내부 소비자에게 정확히 한 terminal을 보낸다.
6. activation, terminal, interrupt waiter를 모두 settle한다.
7. 진행 관측, request lifetime, reconnect timer, in-flight frame handler를 정산한다.
8. pump mux 등록, IPC attachment, parent outbox, offline writer와 writer lock을 반납한다.
9. 정책이 요구할 때만 exact child proof로 child를 종료·retire한다. host restart와 live adoption handoff에서는 child를 보존한다.
10. cleanup 실패 전체를 `ExecutionCleanupReport`에 기록하고, 독립 단계는 끝까지 시도한 뒤 `terminal`로 전이한다. 실패 단계는 maintenance lane이 재시도한다.

host attachment 반납은 이 목록과 다른 연산이다.

```ts
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

`close`, rollback, reconnect exhaustion, `execution_ended`, offline replay terminal의 다섯 진입점은 직접 boolean이나 stream을 건드리지 않는다. terminal 증명이 있는 네 경로는 controller `terminate()`를 호출하고, reconnect exhaustion은 `recovering`과 `detachAttachment()`를 호출한다. `detachAttachment()`는 child, execution row, output stream의 terminal 상태를 바꾸지 않는다.

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
