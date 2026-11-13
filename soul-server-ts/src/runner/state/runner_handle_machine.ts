import { setup } from "xstate";

import type { RunnerRecoveryDisposition } from "./runner_recovery_machine.js";

/** 이미 붙은 러너의 백그라운드 작업 보유를 물은 결과다. */
export type RunnerHandleDetachedBackground = "not_probed" | "retained" | "absent";

/** 만료된 정상 보유 러너의 해제를 물은 결과다. */
export type RunnerHandleRetention = "not_probed" | "released" | "not_released";

/** 붙은 러너의 종료 등록 은퇴를 물은 결과다. */
export type RunnerHandleAttachedTerminal = "not_probed" | "retired" | "open";

/** 복구 처리 하나가 고르는 조치다. */
export type RunnerHandleAction =
  | "recover_closed_engine_terminal"
  | "probe_detached_background"
  | "stop_detached_background"
  | "terminalize_dead_background"
  | "probe_expired_retention"
  | "stop_released_retention"
  | "probe_attached_terminal"
  | "stop_retired_attached_terminal"
  | "retire_recorded_terminal"
  | "recover_by_disposition"
  | "terminalize_failed"
  | "recover_closed"
  | "terminalize_reaped"
  | "unsupported";

export interface RunnerHandleFacts {
  disposition: RunnerRecoveryDisposition;
  hasTask: boolean;
  /** 종료 사건이 기록된 확정 종료인가. */
  recordedTerminal: boolean;
  /** 닫힌 엔진 실패가 적힌 종료인가. */
  closedEngineTerminal: boolean;
  detachedBackground: RunnerHandleDetachedBackground;
  retention: RunnerHandleRetention;
  attachedTerminal: RunnerHandleAttachedTerminal;
  deadBackgroundTerminalized: boolean;
  hasRunner: boolean;
  hasExecutionPromise: boolean;
}

export interface RunnerHandleEvent extends RunnerHandleFacts {
  type: "HANDLE";
}

export const RUNNER_HANDLE_BACKGROUND_STATES: readonly RunnerHandleDetachedBackground[] = [
  "not_probed",
  "retained",
  "absent",
];

export const RUNNER_HANDLE_RETENTION_STATES: readonly RunnerHandleRetention[] = [
  "not_probed",
  "released",
  "not_released",
];

export const RUNNER_HANDLE_ATTACHED_TERMINAL_STATES: readonly RunnerHandleAttachedTerminal[] = [
  "not_probed",
  "retired",
  "open",
];

export const RUNNER_HANDLE_ACTIONS: readonly RunnerHandleAction[] = [
  "recover_closed_engine_terminal",
  "probe_detached_background",
  "stop_detached_background",
  "terminalize_dead_background",
  "probe_expired_retention",
  "stop_released_retention",
  "probe_attached_terminal",
  "stop_retired_attached_terminal",
  "retire_recorded_terminal",
  "recover_by_disposition",
  "terminalize_failed",
  "recover_closed",
  "terminalize_reaped",
  "unsupported",
];

const isAdoptionOrReplay = (disposition: RunnerRecoveryDisposition): boolean =>
  disposition === "adopt_prebootstrap"
  || disposition === "adopt_running"
  || disposition === "replay_terminal"
  || disposition === "replay_terminal_dead";

const verdict = (action: RunnerHandleAction) => ({
  type: "verdict" as const,
  params: { action },
});

/**
 * 복구 처리 기계다. 전이 배열의 순서가 조치 순서다.
 * 물어봐야 아는 조치(probe)는 handle()이 실행하고 결과를 사실에 적어 다시 판정한다.
 */
export const runnerHandleMachine = setup({
  types: {
    events: {} as RunnerHandleEvent,
  },
  guards: {
    closedEngineTerminal: ({ event }) =>
      event.hasTask
      && event.disposition === "replay_terminal"
      && event.closedEngineTerminal,
    detachedBackgroundUnprobed: ({ event }) =>
      event.hasTask
      && event.disposition === "replay_terminal"
      && event.detachedBackground === "not_probed",
    detachedBackgroundRetained: ({ event }) =>
      event.hasTask
      && event.disposition === "replay_terminal"
      && event.detachedBackground === "retained",
    deadBackgroundUnterminalized: ({ event }) =>
      event.disposition === "replay_terminal_dead"
      && !event.deadBackgroundTerminalized,
    retentionUnprobed: ({ event }) =>
      event.hasTask && event.recordedTerminal
      && event.retention === "not_probed",
    retentionReleased: ({ event }) =>
      event.hasTask && event.recordedTerminal
      && event.retention === "released",
    attachedTerminalUnprobed: ({ event }) =>
      event.hasTask && event.recordedTerminal
      && event.attachedTerminal === "not_probed",
    attachedTerminalRetired: ({ event }) =>
      event.hasTask && event.recordedTerminal
      && event.attachedTerminal === "retired",
    recordedTerminalWithoutExecution: ({ event }) =>
      event.hasTask && event.recordedTerminal
      && !event.hasRunner && !event.hasExecutionPromise,
    recoverableDisposition: ({ event }) => isAdoptionOrReplay(event.disposition),
    reapDead: ({ event }) => event.disposition === "reap_dead",
    closed: ({ event }) => event.disposition === "closed",
    alreadyReaped: ({ event }) => event.disposition === "already_reaped",
  },
  actions: {
    verdict: () => {},
  },
}).createMachine({
  id: "runnerHandle",
  initial: "decide",
  description: "복구 가름 하나에 할 조치",
  states: {
    decide: {
      description: "가름과 task 사실, 물은 결과로 조치를 고른다",
      on: {
        HANDLE: [
          {
            guard: "closedEngineTerminal",
            actions: verdict("recover_closed_engine_terminal"),
            description: "닫힌 엔진 실패가 적힌 종료는 복구 가름으로 보낸다",
          },
          {
            guard: "detachedBackgroundUnprobed",
            actions: verdict("probe_detached_background"),
            description: "종료 재생 전에 백그라운드 작업 보유를 묻는다",
          },
          {
            guard: "detachedBackgroundRetained",
            actions: verdict("stop_detached_background"),
            description: "백그라운드 작업이 프로세스를 쥐고 있으면 그대로 둔다",
          },
          {
            guard: "deadBackgroundUnterminalized",
            actions: verdict("terminalize_dead_background"),
            description: "죽은 러너의 백그라운드 작업을 먼저 종료로 적는다",
          },
          {
            guard: "retentionUnprobed",
            actions: verdict("probe_expired_retention"),
            description: "종료 확정 정상 보유의 만료 해제를 묻는다",
          },
          {
            guard: "retentionReleased",
            actions: verdict("stop_released_retention"),
            description: "만료 보유를 해제했으면 은퇴까지 마치고 끝낸다",
          },
          {
            guard: "attachedTerminalUnprobed",
            actions: verdict("probe_attached_terminal"),
            description: "붙은 러너의 종료 등록 은퇴를 묻는다",
          },
          {
            guard: "attachedTerminalRetired",
            actions: verdict("stop_retired_attached_terminal"),
            description: "붙은 러너의 종료 등록을 은퇴시켰으면 끝낸다",
          },
          {
            guard: "recordedTerminalWithoutExecution",
            actions: verdict("retire_recorded_terminal"),
            description: "종료 확정이고 실행을 쥐지 않았으면 재생 없이 은퇴한다",
          },
          {
            guard: "recoverableDisposition",
            actions: verdict("recover_by_disposition"),
            description: "잇기와 재생 가름은 그 가름으로 복구한다",
          },
          {
            guard: "reapDead",
            actions: verdict("terminalize_failed"),
            description: "죽은 실행은 실패로 종결한다",
          },
          {
            guard: "closed",
            actions: verdict("recover_closed"),
            description: "닫힌 기록은 닫힌 복구로 보낸다",
          },
          {
            guard: "alreadyReaped",
            actions: verdict("terminalize_reaped"),
            description: "이미 치운 기록은 치운 종결로 보낸다",
          },
          {
            actions: verdict("unsupported"),
            description: "나머지 가름은 처리할 길이 없다",
          },
        ],
      },
    },
  },
});
