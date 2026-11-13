import { setup } from "xstate";

/** 러너가 남긴 종료 사실이다. `none`은 아직 없음이다. */
export const NODE_RUNNER_TERMINAL_FACTS = [
  "none",
  "completed",
  "failed",
  "reaped",
  "closed",
] as const;
export type NodeRunnerTerminalFact = (typeof NODE_RUNNER_TERMINAL_FACTS)[number];

/**
 * 종료 뒤 정상 보유의 종류다. 클로드의 남은 백그라운드 작업,
 * 코덱스의 남은 명령, 없음이다. 해제 중은 `releasing` 사실로 따로 받는다.
 */
export const NODE_RETENTION_KINDS = [
  "none",
  "claude_background",
  "codex_command",
] as const;
export type NodeRetentionKind = (typeof NODE_RETENTION_KINDS)[number];

/** Task 필드에 흩어진 사실을 한 자리에 모은 판정 입력이다. */
export interface NodeExecutionFacts {
  /** 상태가 initializing이나 running이다. */
  active: boolean;
  /** 종료 상태이고 중앙이 종료 사건을 적용했다(terminationEventRecorded). */
  terminalRecorded: boolean;
  /** task.runner가 붙어 있다. */
  hasRunner: boolean;
  /** 붙은 러너가 살아 있는 프로세스가 아니라 기록을 다시 읽는 손잡이다(runnerIsOfflineReplay). */
  offlineReplay: boolean;
  /** 시동 장벽(executionActivation)이나 실행 약속(executionPromise)이 있다. */
  hasStartBarrier: boolean;
  /** 중앙이 적용한 실행 등록(executionRegistration)이 있다. */
  hasRegistration: boolean;
  /** 러너가 남긴 종료 사실(runnerTerminalFact). */
  runnerTerminalFact: NodeRunnerTerminalFact;
  /** 종료 뒤 정상 보유의 종류(runnerRetainedForDetachedWork와 엔진). */
  retention: NodeRetentionKind;
  /** 러너 해제 청구가 걸려 있다(runnerReleaseClaim). */
  releasing: boolean;
  /** DB 줄에서 올린 task다(hydratedFromDb). */
  hydratedFromDb: boolean;
  /** 멈춤 장벽이 올라 있다. Task에는 이 표지가 없어 호출자가 넘긴다. */
  stopRequested: boolean;
}

export interface NodeExecutionProjectEvent extends NodeExecutionFacts {
  type: "PROJECT";
}

/** 노드 실행 상태 값이다. 판정 순서가 곧 이 배열의 순서다. */
export const NODE_EXECUTION_PHASES = [
  "retained_releasing",
  "retained_claude_background",
  "retained_codex_command",
  "stopping",
  "hydrated_active",
  "starting",
  "replaying",
  "terminating",
  "registering",
  "running",
  "idle",
] as const;
export type NodeExecutionPhase = (typeof NODE_EXECUTION_PHASES)[number];

const recordedWithRunner = (event: NodeExecutionFacts): boolean =>
  event.terminalRecorded && event.hasRunner;

/**
 * 노드 실행 상태 투영 기계다. 전이 배열의 순서가 판정 순서이고 목표 상태가 값이다.
 * 액터를 만들지 않고 transition()으로 다음 상태 값만 읽는다.
 */
export const nodeExecutionMachine = setup({
  types: {
    events: {} as NodeExecutionProjectEvent,
  },
  guards: {
    retainedReleasing: ({ event }) => recordedWithRunner(event) && event.releasing,
    retainedClaude: ({ event }) =>
      recordedWithRunner(event) && event.retention === "claude_background",
    retainedCodex: ({ event }) =>
      recordedWithRunner(event) && event.retention === "codex_command",
    stopping: ({ event }) => event.active && event.stopRequested,
    // 실행 등록이 남은 task는 시동 복구가 이을 러너가 있을 수 있어 러너 없는 task가
    // 아니다. 재연결 실행 중 목록도 같은 기준으로 복구 대기로 본다.
    hydratedActive: ({ event }) =>
      event.active
      && !event.hasRunner
      && event.hydratedFromDb
      && !event.hasStartBarrier
      && !event.hasRegistration,
    starting: ({ event }) => event.active && !event.hasRunner,
    replaying: ({ event }) => event.hasRunner && event.offlineReplay,
    terminating: ({ event }) =>
      event.hasRunner && (!event.active || event.runnerTerminalFact !== "none"),
    registering: ({ event }) => event.active && event.hasRunner && !event.hasRegistration,
    running: ({ event }) => event.active && event.hasRunner && event.hasRegistration,
    idle: ({ event }) => !event.active && !event.hasRunner,
  },
}).createMachine({
  id: "nodeExecution",
  initial: "project",
  description: "Task 필드의 사실을 노드 실행 상태 하나로 투영한다",
  states: {
    project: {
      description: "사실을 받아 위에서부터 처음 맞는 실행 상태로 간다",
      on: {
        PROJECT: [
          {
            guard: "retainedReleasing",
            target: "retained_releasing",
            description: "종료가 기록됐고 러너 해제 청구가 걸려 있다",
          },
          {
            guard: "retainedClaude",
            target: "retained_claude_background",
            description: "종료가 기록됐고 클로드의 남은 백그라운드 작업이 러너를 쥐고 있다",
          },
          {
            guard: "retainedCodex",
            target: "retained_codex_command",
            description: "종료가 기록됐고 코덱스의 남은 명령이 러너를 쥐고 있다",
          },
          {
            guard: "stopping",
            target: "stopping",
            description: "활성이고 멈춤 장벽이 올라 있다",
          },
          {
            guard: "hydratedActive",
            target: "hydrated_active",
            description: "러너도 실행 등록도 없이 DB에서 올린 활성 task다",
          },
          {
            guard: "starting",
            target: "starting",
            description: "활성이고 러너가 아직 없다",
          },
          {
            guard: "replaying",
            target: "replaying",
            description: "붙은 러너가 기록을 다시 읽는 손잡이다",
          },
          {
            guard: "terminating",
            target: "terminating",
            description: "러너가 붙은 채 종료를 올렸거나 올리는 중이다",
          },
          {
            guard: "registering",
            target: "registering",
            description: "러너는 붙었고 실행 등록 응답을 아직 받지 못했다",
          },
          {
            guard: "running",
            target: "running",
            description: "러너가 붙었고 등록이 적용됐다",
          },
          {
            guard: "idle",
            target: "idle",
            description: "활성도 러너도 없다",
          },
        ],
      },
    },
    retained_releasing: { description: "종료 뒤 러너를 해제하는 중" },
    retained_claude_background: { description: "종료 뒤 클로드 백그라운드 작업 보유" },
    retained_codex_command: { description: "종료 뒤 코덱스 남은 명령 보유" },
    stopping: { description: "멈추는 중" },
    hydrated_active: { description: "러너 없이 올린 활성 task" },
    starting: { description: "러너를 띄우는 중(러너 없음)" },
    replaying: { description: "러너의 남은 기록을 올리는 중(오프라인 재생)" },
    terminating: { description: "종료를 올리는 중(러너 붙음)" },
    registering: { description: "실행 등록 응답을 기다리는 중(러너 붙음)" },
    running: { description: "러너가 턴을 도는 중" },
    idle: { description: "주인 없음" },
  },
});
