import { setup } from "xstate";

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

export interface NodeExecutionFacts {
  active: boolean;
  terminalRecorded: boolean;
  hasRunner: boolean;
  offlineReplay: boolean;
  hasStartBarrier: boolean;
  hasRegistration: boolean;
  hasRunnerTerminalFact: boolean;
  retention: NodeRetentionKind;
  releasing: boolean;
  hydratedFromDb: boolean;
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
    hydratedActive: ({ event }) =>
      event.active
      && !event.hasRunner
      && event.hydratedFromDb
      && !event.hasStartBarrier
      && !event.hasRegistration,
    starting: ({ event }) => event.active && !event.hasRunner,
    replaying: ({ event }) => event.hasRunner && event.offlineReplay,
    terminating: ({ event }) =>
      event.hasRunner && (!event.active || event.hasRunnerTerminalFact),
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
