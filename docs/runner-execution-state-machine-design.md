# 실행 턴 1급 상태기계 재설계

기준 커밋: `2abbc180` (2026-08-23, PR #818 포함)

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
  executionCommandId: string;
}

interface ExecutionOwnership extends ExecutionReservation, SpawnedChildProof {
  activatedAt: IsoDateTime;
}

type ExecutionProgressKind =
  | "assistant_message"
  | "thinking"
  | "tool_result";

type ExecutionProgress =
  | {
      state: "not_observed";
      leaseStartedAt: IsoDateTime;
      progressLeaseExpiresAt: IsoDateTime;
      inFlightTools: readonly [];
    }
  | {
      state: "observed";
      sequence: number;
      kind: ExecutionProgressKind;
      progressedAt: IsoDateTime;
      progressLeaseExpiresAt: IsoDateTime;
      inFlightTools: ReadonlyArray<{
        toolUseId: string;
        absoluteLeaseExpiresAt: IsoDateTime;
      }>;
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
  | { kind: "offline_replay"; attachment: OfflineReplayAttachment };

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
      kind: "terminal_witness";
      central: DurableExecutionRecord;
      runnerLifecycle: RunnerLifecycleRecord;
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
}

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
  | { kind: "attached_owner"; ownership: ExecutionOwnership; attachment: LiveRunnerAttachment }
  | { kind: "recovering_owner"; ownership: ExecutionOwnership; recovery: ExecutionRecoveryHandle };

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
      progress: ExecutionProgress;
      waiters: ExecutionWaiters;
      inputs: ExecutionInputSet;
    }
  | {
      phase: "recovering";
      ownership: ExecutionOwnership;
      method: "host_reattach" | "adopt" | "offline_replay";
      evidence: ExecutionRecoveryEvidence;
      handle: ExecutionRecoveryHandle;
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
      retention: ExecutionRetention;
    };

interface BeginExecutionInput {
  key: ExecutionKey;
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
  method: "host_reattach" | "adopt" | "offline_replay";
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

기존 12개 필드의 정보는 다음처럼 정확히 한 union 안으로 이동한다.

| 기존 Task 필드 | 새 소유 위치 |
| --- | --- |
| `runner` | `provisional/activating/active.attachment`, recovery handle 또는 `terminal.retention` |
| `runnerRetainedForClaudeBackground` | `terminal.retention.kind` |
| `runnerIsOfflineReplay` | `recovering.method`과 `handle.kind` |
| `runnerTerminalFact` | `terminating.firstSignal`, `terminal.record.firstSignal` |
| `executionPromise` | `waiters.terminal.promise`과 `terminating.termination` |
| `executionActivationPromise` | `waiters.activation.promise` |
| `executionActivationHandoff` | `waiters.activation` |
| `executionOwnership` | `active/recovering.ownership` 또는 termination subject |
| `executionOwnershipReservation` | `reserved/provisional.reservation` |
| `recoveredExecutionOwnership` | `recovering.evidence` |
| `pendingExecutionExpectedTerminalEventId` | `reservation.terminalProjectionFence` |
| `interruptRequest` | `waiters.interrupt` |

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
| `terminal` | 다음 유효 입력 | 새 `reserved` | 새 `executionId`, retention attachment의 명시적 handoff | terminal record 재사용, retained runner를 current turn으로 간주 |

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
9. 정책이 요구할 때만 exact child proof로 child를 종료·retire한다. host restart와 live adoption handoff에서는 child를 보존하고, foreground 종료 뒤 Claude background task가 남으면 `terminal.retention`으로 명시 이전한다.
10. cleanup 실패 전체를 `ExecutionCleanupReport`에 기록하고, 독립 단계는 끝까지 시도한 뒤 `terminal`로 전이한다. 실패 단계는 maintenance lane이 재시도한다.

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

1. `session_execution_ownerships`의 `reserved`, `identity_proven`, `active`, `terminating` row를 node별로 읽는다.
2. runner 등록 디렉터리와 runner SQLite lifecycle witness를 읽는다.
3. 메모리 controller를 읽되 판단 근거가 아니라 불일치 탐지에만 쓴다.
4. `executionId`를 기준으로 full outer join한다.
5. 모든 row를 disposition으로 분류하고, 각 결과를 `completed` 또는 `scheduled(wakeAt)` receipt로 끝낸다.

따라서 등록 디렉터리가 0개여도 1번에서 열린 실행 4개가 나오면 네 실행을 모두 검사한다. 반대로 중앙 execution 없이 등록만 있으면 orphan child 회수 대상이다. `activeRunnerOperations`와 Task 필드 존재는 inventory가 아니라 controller의 관측 projection으로 격하한다.

스캔은 기존 bounded `PeriodicMaintenanceLoop`의 독립 step으로 둔다. step timeout이 나도 다음 tick이 강제되고, 한 실행의 reconcile이 다른 실행을 막지 않도록 session별 bounded job으로 분리한다. 회수는 새 메시지, reserve, intervention, 배포, 재시작 중 어느 것도 트리거로 요구하지 않는다.

### progress와 process liveness 분리

살아 있는 프로세스와 진행하는 턴은 다른 사실이다.

- `assistant_message`, `thinking`, `tool_result`만 foreground progress lease를 갱신한다. 정본 predicate는 하나다.
- `tool_start`는 progress가 아니라 해당 tool의 절대 lease를 연다. heartbeat가 와도 이 절대 lease를 무한 연장하지 않는다.
- runner heartbeat는 process liveness만 갱신한다. 객체, socket, PID, 등록 디렉터리 존재는 progress가 아니다.
- 중앙 progress row는 runner SQLite의 monotonic `progress_seq`를 CAS 투영한다. 늦은 host가 sequence를 되돌릴 수 없다.
- progress lease가 지났더라도 절대 lease 안의 in-flight tool이 있으면 기다린다. 둘 다 지났고 terminal witness도 없을 때만 `reap_stalled`을 증명한다.

이는 “tool result, thinking, agent message가 오고 있으면 살아 있다”는 사용자 기준을 정본 predicate로 올린 것이다. 현재 `runner_child_runtime.ts:584`의 모든 SSE event progress와 `claude_runtime_followup_watchdog.ts:205`의 foreground predicate를 하나로 합친다.

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
  | "drain_closed";

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
} satisfies Record<RunnerRecoveryDisposition, DispositionPolicy>;
```

action executor의 반환 타입은 다음 둘뿐이다.

```ts
type RecoveryReceipt =
  | { kind: "completed"; executionId: ExecutionId; resultingPhase: TaskExecution["phase"] }
  | { kind: "scheduled"; executionId: ExecutionId; wakeAt: IsoDateTime; reason: string };
```

refreshed disposition이 달라지면 executor는 새 키로 같은 `Record`를 다시 조회한다. 아무 일도 하지 않는 `return`은 타입에 없다. 이 구조는 새 11번째 disposition이 추가될 때 policy와 test matrix 양쪽을 컴파일 오류로 만든다.

## delivery와 실행의 연결

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
  executionCommandId: string;
  payloadHash: string;
  assignedAt: IsoDateTime;
}

interface DeliveryConsumptionReceipt {
  attemptId: string;
  executionId: ExecutionId;
  executionCommandId: string;
  runnerInputSequence: number;
  consumedAt: IsoDateTime;
}
```

`uncertain`은 delivery의 종착지가 아니다. 이전 attempt의 결과를 아직 모른다는 뜻이면 `reconciling`이고, 같은 command의 runner input journal과 consumption receipt를 조회해 `consumed` 또는 `queued`로 끝낸다. 조회 전에는 새 attempt를 만들 수 없다.

재시도 횟수 소진도 종착지가 아니다. cadence를 늦추는 `retry_paused`이며 ownership 변화, 새 execution activation, maintenance tick이 모두 wake source다. `dead_letter`는 유효하고 이미 승인한 메시지의 상태에서 제거한다. `rejected`는 payload identity 충돌, 권한 거부처럼 **시스템이 durable admission 전에 또는 consumption 전에 명시적으로 비수용을 증명한 경우**에만 허용한다.

### 할당과 순서

한 DB transaction이 session의 head delivery와 open execution을 함께 잠근다.

1. 아직 terminal이 아닌 가장 작은 `enqueue_sequence`를 고른다.
2. 앞 delivery가 `queued`가 아니면 뒤 delivery를 할당하지 않는다.
3. active execution row와 command identity를 읽는다.
4. `(delivery_id, attempt_number)` row에 `execution_id`, generation, command id를 기록한다.
5. runner durable input inbox에 같은 attempt id를 넣고 receipt fence를 만든다.
6. runner receipt 뒤에만 delivery를 `consumed`로 바꾼다.

제약은 다음을 DB에서도 막는다.

- delivery 하나당 open attempt 최대 1개
- attempt 하나당 execution 정확히 1개
- consumption receipt의 `(delivery_id, attempt_id)` unique
- runner input의 `attempt_id` unique
- session별 FIFO head를 건너뛰는 assignment 금지

execution activation은 binder wake event를 같은 durable transaction에 넣는다. 복구가 끝나기 전에 온 개입은 `queued`로 머물고, 기존 execution이 `active`로 돌아오면 그 execution에, 이미 terminal이면 다음 execution에 할당된다. 어느 경우에도 호출자가 다시 보내지 않는다.

### admission과 외부 ACK

모든 입력 종류를 admission 정본으로 통합한다.

```ts
type ExecutionInputKind =
  | "user_message"
  | "intervention"
  | "ask_question_response"
  | "tool_result"
  | "interrupt"
  | "completion_notification"
  | "runtime_followup";

interface AcceptedInput {
  status: "accepted";
  deliveryId: DeliveryId;
}
```

orch는 node WebSocket을 호출하기 전에 delivery와 idempotency receipt를 Postgres에 commit한다. 정상일 때도 곧바로 node에 보내지 않고 binder를 깨운다. node 단절과 command timeout은 API 결과가 아니라 내부 지연 사유다.

`markQueued()`나 assignment CAS가 false이면 즉시 실패하지 않는다. delivery id로 canonical row를 재조회한다.

- `queued`, `assigned`, `reconciling`, `retry_paused`, `consumed`면 같은 `AcceptedInput`을 반환한다.
- identity가 다른 payload면 비수용을 증명한 409를 반환할 수 있다. 이는 restart 신호가 아니라 caller idempotency 위반이다.
- DB commit 결과 자체가 불명확하면 같은 idempotency key로 내부 재조회하며 HTTP 연결을 유지한다. 연결이 끊기면 caller transport가 같은 key로 자동 재시도하고 동일 receipt를 받는다.

현재 “queued-state CAS false → throw → 503”과 `sessions.py:408`의 node 단절 503은 이 경계가 생기면 구조적으로 사라진다. 외부에는 queued, auto-resumed, recovering 같은 disposition도 노출하지 않는다. 정상 경로와 재기동 경로의 응답을 같게 만들기 위해서다.

## 재기동 투명성

### 반드시 durable한 것

| 사실 | durable 위치 | 재기동 뒤 사용 |
| --- | --- | --- |
| 논리 실행 identity와 phase | 중앙 execution row | open inventory와 controller 재구성 |
| first terminal signal | 중앙 first-signal CAS | 중복 terminal 차단과 session 최종 투영 |
| runner child identity와 execute command | 중앙 row + runner bootstrap witness | exact process adopt·rollback |
| foreground progress와 in-flight tool lease | runner lifecycle + 중앙 monotonic projection | stalled 판정 |
| engine 입력 | runner command/input journal | command 재전송 중복 차단 |
| engine 출력 | runner event outbox + IPC journal | event id 순서 replay |
| host call 요청·응답 | runner request journal + host idempotency receipt | host 교체 뒤 같은 correlation id 재개 |
| 사용자 입력과 FIFO | orch delivery ledger | 복구 전 입력 보존과 activation bind |
| delivery→execution attempt | delivery attempt row + runner input receipt | 결과 reconcile과 exactly-once |
| backend session id와 context mutation | 기존 durable session/event effect | 새 host Task hydration |

runner child는 soul-server shutdown 대상이 아니다. 계획 재기동에서 host는 `detachAttachment("host_shutdown")`만 수행한다. engine turn, runner SQLite, writer lock, child socket은 살아 남는다.

child가 보내는 host call은 전송 전에 correlation id와 payload를 runner journal에 기록한다. host attachment가 없으면 deadline error를 engine에 반환하지 않고 대기한다. 새 host가 붙으면 같은 요청을 replay하고, host는 idempotency receipt가 있으면 같은 응답을 돌려준다. request cadence는 조절할 수 있지만 retry budget은 책임을 끝내지 않는다.

출력은 host 메모리 stream이 아니라 runner outbox와 event ingress receipt를 기준으로 이어진다. dashboard는 재접속 뒤 마지막 event id 다음부터 replay한다. 실행 중 agent는 engine process가 계속 살아 있고 host call이 대기하므로 재시작을 오류로 관측하지 않는다.

### 복구 창 입력

복구 전 입력의 순서는 다음으로 고정한다.

1. orch가 입력을 durable admission하고 정상과 같은 `accepted`를 반환한다.
2. input은 session FIFO에서 unassigned로 기다린다.
3. 새 host가 중앙 open execution을 hydrate한다.
4. exact child를 adopt하고 `recovering → active`를 commit한다.
5. activation wake가 FIFO binder를 실행한다.
6. bind transaction이 기존 command가 여전히 active인지 다시 확인한다.
7. active면 그 command inbox로, terminal이면 다음 execution의 첫 입력으로 들어간다.

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

`in_process` execution은 host process와 운명을 같이하므로 이 수용 기준을 만족할 수 없다. 투명성 gate가 켜진 사용자·에이전트 턴은 반드시 독립 runner 또는 같은 durability를 가진 외부 worker에서 실행한다. 현행 `ownerKind: "in_process"` 사용처가 0임을 전수 검증하기 전에는 gate를 전면 활성화하지 않는다. 존재한다면 해당 경로를 외부 worker로 옮기는 것이 설계 조건이며, 오류 노출 fallback은 두지 않는다.

## 불변식에서 구조로의 매핑

### 실행 불변식 16개

| # | 불변식 | 위반이 구성상 불가능한 이유 | 강제 수단 |
| ---: | --- | --- | --- |
| 1 | session당 current execution 최대 1, 모든 참조 identity 일치 | required controller 하나와 DB open-execution unique 제약이 같은 `executionId`만 허용한다. | 타입 + DB CAS |
| 2 | 실행 lifecycle은 명시적 단일 상태기계 | 모든 상태가 `TaskExecution` 판별 유니온이며 presence 판정 API가 없다. | 타입 |
| 3 | provisional spawn도 실행 | spawn proof와 attachment를 가진 `provisional`이 activation 전에 필수다. | 타입 + 단일 attach 경로 |
| 4 | 새 identity가 옛 자원과 격리 | callback과 transition이 `executionId + generation`을 요구한다. 불일치 callback은 mutation 권한이 없다. | 타입 + runtime fence |
| 5 | runner·registration 소실 시 모든 waiter bounded settle | 중앙 open inventory가 소실을 disposition으로 만들고, termination이 모든 waiter를 한 번에 settle한다. | 주기 reconcile + 단일 종료 |
| 6 | 회수는 restart·reserve·message와 독립 | maintenance가 중앙 open inventory를 항상 스캔한다. | runtime maintenance |
| 7 | reference clear는 종료가 아님 | public clear API가 없고 `terminal` 전이는 cleanup receipt를 요구한다. | 타입 + 단일 경로 |
| 8 | terminal은 멱등, visible 결과 하나 | first-signal DB CAS와 memoized `terminate()`가 모든 신호를 합친다. | DB CAS + 단일 경로 |
| 9 | activeRunnerOperations는 실행과 함께 끝남 | stall 관측이 controller resource ledger의 cleanup step이라 별도 finish 누락이 없다. | 단일 resource ledger |
| 10 | activation 실패 시 같은 generation active 또는 exact child dead | `provisional`은 exact child proof를 보유하고 failure가 `terminate()` 없이는 상태를 벗어나지 못한다. | 타입 + identity-fenced rollback |
| 11 | live child/open ownership/unreachable waiter의 제3상태 금지 | full outer inventory join이 모든 불일치를 disposition으로 만들고 모든 action은 receipt를 반환한다. | exhaustive runtime table |
| 12 | rollback은 exact spawned child proof 사용 | `provisional.child` 없이는 rollback action을 호출할 수 없다. sidecar 최신값은 입력 타입이 아니다. | 타입 |
| 13 | recovery retry 또는 명시적 책임 | action 결과가 `completed | scheduled`뿐이라 silent abandon이 없다. | 타입 + maintenance wake |
| 14 | execution inventory는 registration과 별도 reconcile | 중앙 open execution에서 스캔을 시작하고 registration과 full outer join한다. | 구조 |
| 15 | acquire/release 대칭 경계와 자원 순서 | `begin/attachSpawn`과 `terminate`가 controller의 유일한 획득·해제 API다. | 인터페이스 + 단일 경로 |
| 16 | durable/process/memory 불일치는 한 결정표로 해결 | classifier는 사실만 만들고 `Record`가 모든 disposition action을 강제한다. | exhaustive 타입 + runtime 검사 |

### delivery 불변식 10개

| # | 불변식 | 위반이 구성상 불가능한 이유 | 강제 수단 |
| ---: | --- | --- | --- |
| D1 | 승인된 논리 메시지는 재전송 없이 다음 유효 실행에 도달 | admission 뒤 책임 상태에는 폐기 terminal이 없고 queued/retry_paused를 maintenance와 activation이 깨운다. | DB 상태기계 + wake |
| D2 | attempt는 concrete execution 또는 explicit unassigned | `queued`에는 attempt가 없고 `assigned`부터 `AssignedDeliveryAttempt`가 필수다. | 판별 유니온 + DB NOT NULL |
| D3 | consumption 최대 1, durable tombstone | attempt id와 runner input receipt unique, delivery consumption receipt unique다. | DB unique + idempotency |
| D4 | unknown attempt reconcile 전 새 attempt 금지 | `reconciling`에 open attempt가 필수이며 binder는 queued만 할당한다. | 타입 + DB partial unique |
| D5 | session FIFO | head row lock과 `enqueue_sequence` predicate가 뒤 assignment를 거부한다. | DB transaction |
| D6 | 새 execution activation이 redelivery를 깨움 | activation transaction이 durable binder wake를 함께 기록한다. | 단일 transaction |
| D7 | attempt budget은 cadence만 제어 | 소진 상태가 terminal이 아닌 `retry_paused`이고 세 wake source가 필수다. | 타입 + policy |
| D8 | durable admission 또는 동일 receipt는 성공 ACK | API가 node 결과가 아니라 canonical delivery row로 `AcceptedInput`을 만든다. | ingress 단일 경로 |
| D9 | failure는 비수용 증명 때만, uncertain은 pending | `uncertain` terminal이 없고 identity mismatch 등 proof가 있는 `rejected`만 있다. | 타입 + proof requirement |
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

직접 field assignment인 `task.runner = undefined`, `task.executionPromise = undefined`, `task.runnerTerminalFact = ...`와 dispatcher `activeStream?.finish/fail`, `closed = true`는 전부 삭제 대상이다. 관측용 `NodeStallMonitor.activeRunnerOperations`는 남을 수 있지만 controller snapshot의 projection일 뿐 생존 판정에는 쓰지 않는다.

## 적용 순서

각 단위는 독립 커밋·독립 review가 가능해야 하고, 끝날 때 시스템은 계속 동작해야 한다.

| 단위 | 변경 | 단위 종료 시 관측 가능한 결과 | 호환 전략 |
| --- | --- | --- | --- |
| 0. 계약 고정 | 정상, pure adopt, 복구 창 intervention, runner-death, activation rollback RED를 영구 gate로 등록 | 제품 동작 변화 없음. 현재 결함 2종만 RED | 별도 테스트 세션이 수행 |
| 1. 중앙 스키마 additive | migration 073의 execution/delivery identity와 first-signal CAS 추가 | 제품 동작 변화 없음. 구 코드 계속 동작 | legacy column·function projection 유지 |
| 2. 2-1 controller 도입 | `TaskExecution`과 제품 factory, shared test fixture 전환. legacy 필드는 read-only compatibility view로 controller에서만 투영 | 실행 결과 동일. provisional spawn과 waiter가 inspector에 명시적으로 보임 | 호출지를 한 factory로 묶고 직접 setter 금지 lint |
| 3. 2-2 terminal 단일화 | dispatcher와 stream을 first-signal terminal state로 전환 | terminal 경합에서 첫 결과만 보이고 모든 waiter가 settle | #818 실측상 기존 green 0건 파단 |
| 4. 2-3 decision table | recovery action을 exhaustive `Record`로 구동하고 중앙 open inventory 스캔 추가 | 새 입력 없이 runner/등록 소실 실행이 bounded 회수 | #818 실측 37 passed 기준, 정책 변경 테스트만 재기준화 |
| 5. delivery bind | attempt에 execution identity, FIFO binder, reconcile/retry_paused 도입 | 다른 delivery 성공이 앞 delivery를 가리지 못함. CAS miss도 accepted | legacy delivery state는 read projection |
| 6. ingress 전환 | web, mobile, Slack, MCP, cross-node, 내부 호출을 durable admission ACK로 통합 | 재기동 창 입력이 503 없이 같은 ACK를 받고 나중에 전달 | caller별 stable delivery id 선배포 |
| 7. attachment 투명화 | host-call journal replay, shutdown detach, adopt 후 stream replay | 실행 중 agent가 host restart를 오류나 turn 중단으로 관측하지 못함 | v1 runner witness adapter 유지 |
| 8. 구 표면 제거 | Task optional 12, partial cleanup 9곳, legacy disposition helper와 상태 projection 삭제 | 구조 화석 2 제거, direct mutation grep 0 | 모든 node semantics v2 확인 뒤 수행 |

단위 2에서 legacy field와 새 controller를 독립적으로 dual-write하지 않는다. controller가 유일한 writer이고 legacy getter는 controller state의 projection이다. 중간 상태에서도 정본은 하나다.

현재 동작 기록 테스트 32개는 단위별 정책 변경표와 연결한다. 바뀐 정책을 기대한 RED만 새 계약으로 갱신하고, 나머지 RED는 회귀다. shared fixture 전환으로 따라오는 8개는 개별 수정하지 않는다.

## DB 마이그레이션과 구·신 호환

DB 변경은 필요하다. 실행 identity, first terminal, progress와 delivery assignment는 process memory만으로 재기동을 관통할 수 없기 때문이다. 이 설계 세션에서는 파일을 만들거나 적용하지 않는다.

계획하는 migration은 `073_execution_turn_state_machine.sql` 하나다.

### 중앙 DB 계획

`session_execution_ownerships`를 durable execution ledger로 확장한다.

- `execution_id TEXT`
- `semantics_version SMALLINT`
- phase constraint에 `terminating`
- `first_terminal_signal JSONB`, `first_terminal_committed_at TIMESTAMPTZ`
- `progress_seq BIGINT`, `progress_kind TEXT`, `progress_at TIMESTAMPTZ`
- `cleanup_state TEXT`, `cleanup_report JSONB`
- `attachment_epoch BIGINT`
- open phase 전체를 대상으로 한 session당 unique partial index
- `session_commit_execution_terminal(...)` first-signal CAS
- `session_list_open_executions(node_id, limit)` inventory 함수

기존 physical 이름은 rolling window 동안 유지한다. 이름은 설계 정본이 아니며 repository가 `DurableExecutionRecord`로 감싼다. 테이블 rename은 정확성에 기여하지 않고 구 stored function을 깨뜨리므로 이 migration의 대상이 아니다.

`session_delivery_attempts`에는 다음을 더한다.

- `attempt_id TEXT UNIQUE`
- `execution_id TEXT`
- `ownership_generation BIGINT`
- `execution_command_id TEXT`
- `assignment_state TEXT`
- `runner_input_sequence BIGINT`
- `resolved_at TIMESTAMPTZ`
- open attempt unique partial index와 execution FK

`session_deliveries`에는 `responsibility_state`를 추가한다. 이것이 새 정본이고 기존 `state`, `aggregate_state`, `uncertain`, `dead_letter`는 rolling compatibility projection으로만 갱신한다. 새 코드는 projection을 읽지 않는다.

마이그레이션 산출 단계에서는 다음 세 곳을 같은 커밋에서 갱신한다.

1. `packages/db-schema/sql/migrations/073_execution_turn_state_machine.sql`
2. `packages/db-schema/migration-manifest.json`의 sha256·rollback compatibility
3. `packages/db-schema/sql/schema.sql`의 bootstrap 동형 정의

runner SQLite는 중앙 migration과 별도로 additive schema upgrade를 한다. execution id, first terminal witness, delivery attempt id, durable host-call request/response를 추가한다. 중앙 execution row가 정본이고 runner SQLite는 child가 host 부재 중 남기는 증거다. reconcile이 monotonic sequence와 identity fence를 검증한 뒤 중앙 정본에 투영한다.

### rolling coexistence

1. additive 073을 먼저 배포하되 기존 함수와 column 의미를 유지한다.
2. semantics v2 host는 v1 runner bootstrap을 `LegacyExecutionWitnessAdapter`로 읽는다. 기존 live turn을 upgrade 이유로 죽이지 않는다.
3. 모든 host가 v2가 되기 전에는 새 v2-only witness를 생성하지 않는다. admission은 이미 durable하므로 이 창의 입력은 기다릴 수 있다.
4. cluster가 v2가 되면 새 실행부터 `semantics_version=2`로 만든다. 기존 v1 open execution은 v2 중앙 inventory가 감시하고 종료 또는 adopt 때 자연스럽게 전환한다.
5. v2 runner는 rolling 기간에 기존 frame_protocol과 bootstrap projection을 함께 기록한다. 형식 계약의 Zod 정본은 유지하고 semantics version으로 의미만 가른다.
6. rollback은 additive DB와 v1 projection을 그대로 둔 채 가능하다. v2-only execution이 열려 있으면 먼저 v2 host가 drain하거나 ownership handoff를 끝내며, old host가 모르는 state를 강제로 맡지 않는다.

이 공존 전략에서도 사용자 ACK는 admission receipt 하나다. 구·신 runner 선택이나 handoff 대기는 외부 결과에 나타나지 않는다.

## 검증자가 확인할 열어 둔 질문

1. 현행 `ownerKind: "in_process"`가 실제 user-visible agent turn에 남아 있는가. 하나라도 있으면 투명성 gate 전에 독립 worker 이관 설계가 추가되어야 한다.
2. web, soul-app, Slack bot, Cogito MCP, cross-node command, 내부 completion/runtime followup 전부가 stable delivery id를 생성·재사용할 수 있는가. 누락 caller inventory를 검증해야 한다.
3. engine별 비멱등 host call은 무엇인가. correlation receipt만으로 충분한지, 별도 operation receipt나 보상 transaction이 필요한지 전수 열거해야 한다.
4. progress predicate를 `assistant_message | thinking | tool_result`로 좁힐 때 backend별 event 이름이 완전히 매핑되는가. `tool_start` 절대 lease의 기존 수치와 종료 조건도 실제 SDK event로 검증해야 한다.
5. 중앙 terminal CAS와 runner outbox terminal frame 중 어느 것이 먼저 durable해지는가. 구현은 outbox 유실과 terminal 영구 대기 둘 다 없는 transaction/receipt 순서를 증명해야 한다.
6. owner-null legacy running session을 v2 `idle`로 만들지 open execution으로 backfill할지 두 번 관측 규칙으로 확정해야 한다. 증거 부족을 terminal 실패로 사용자에게 노출하면 안 된다.
7. orch가 commit 직후 응답 전에 재시작할 때 각 caller transport가 같은 idempotency key로 자동 재시도하는가. caller별로 실제 연결 중단 실험이 필요하다.
8. runner process 자체의 crash는 host restart와 다른 실패 영역이다. 각 engine이 동일 turn을 checkpoint-resume할 수 있는지 확인 전에는 “runner crash도 완전 투명”으로 범위를 넓히지 않는다. 다만 host restart가 runner를 죽이는 경로는 금지한다.
9. 늦게 합류할 정상·pure adopt·복구 창 scenario 결과에서 새 상태 전이 또는 durable 자원이 빠진 것이 있는가. 설계 검증 세션이 이 문서의 상태표와 시나리오 trace를 행 단위로 대조해야 한다.

## 설계 검증 통과 조건

- 문서의 모든 phase가 실제 entry/terminal 경로를 MECE로 덮고, silent return이나 direct clear가 필요한 사례가 없어야 한다.
- 실행 불변식 16개와 delivery 불변식 10개가 각각 최소 한 개의 타입, DB 제약, 단일 경로, runtime reconcile에 연결되어야 한다.
- 정상, pure adopt, 복구 전 intervention 세 시나리오가 외부 관측 표에서 같은 ACK와 event 순서를 보여야 한다.
- runner-death와 activation rollback 영구 RED가 새 구조에서는 각각 bounded terminal settle과 exact child cleanup으로만 green이 되어야 한다.
- #818의 2-2 기존 green 0 파단, 2-3 37 passed를 기준선으로 삼고, 2-1은 shared fixture 한 곳 변경으로 계약 8개를 보존해야 한다.
- 제품 코드 구현 전에 migration 073의 forward/rollback compatibility와 v1/v2 coexistence를 별도 검토해야 한다.

## 중간 결론

재기동 투명성은 더 많은 예외 처리로 얻지 못한다. 실행 턴, 그 턴에 할당된 입력, 첫 terminal과 자원 수명을 하나의 identity와 상태기계로 묶고, 정상 경로도 같은 durable 경계를 통과시킬 때만 재기동이 평상시와 구분되지 않는다.
