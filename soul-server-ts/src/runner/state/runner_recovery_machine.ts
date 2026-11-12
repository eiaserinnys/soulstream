import { setup } from "xstate";

import type { RunnerLifecycleState } from "./runner_lifecycle_machine.js";

export type RunnerRecoveryDisposition =
  | "wait_for_bootstrap"
  | "adopt_prebootstrap"
  | "adopt_running"
  | "replay_terminal"
  | "replay_terminal_dead"
  | "retired_terminal"
  | "reap_dead"
  | "already_reaped"
  | "closed";

export interface RunnerRecoveryFacts {
  /** 은퇴 표시가 있는가. */
  retired: boolean;
  /** 읽은 수명 상태. "none"은 기록 없음이다. */
  lifecycle: RunnerLifecycleState;
  /** 등록에 적힌 pid가 살아 있는가. */
  pidAlive: boolean;
  /** 부트스트랩 임대 시간이 지났는가. */
  bootstrapLeaseElapsed: boolean;
}

export interface RunnerRecoveryEvent extends RunnerRecoveryFacts {
  type: "CLASSIFY";
}

export const RUNNER_RECOVERY_DISPOSITIONS: readonly RunnerRecoveryDisposition[] = [
  "wait_for_bootstrap",
  "adopt_prebootstrap",
  "adopt_running",
  "replay_terminal",
  "replay_terminal_dead",
  "retired_terminal",
  "reap_dead",
  "already_reaped",
  "closed",
];

const isTerminal = (state: RunnerLifecycleState): boolean =>
  state === "completed" || state === "failed";

const verdict = (disposition: RunnerRecoveryDisposition) => ({
  type: "verdict" as const,
  params: { disposition },
});

/**
 * 복구 가름 기계다. 전이 배열의 순서가 판정 순서다.
 * 액터를 만들지 않고 transition()은 기호 액션만 돌려준다.
 */
export const runnerRecoveryMachine = setup({
  types: {
    events: {} as RunnerRecoveryEvent,
  },
  guards: {
    retired: ({ event }) => event.retired,
    reaped: ({ event }) => !event.retired && event.lifecycle === "reaped",
    closed: ({ event }) => !event.retired && event.lifecycle === "closed",
    noLifecyclePidAlive: ({ event }) =>
      !event.retired && event.lifecycle === "none" && event.pidAlive,
    noLifecycleLeaseElapsed: ({ event }) =>
      !event.retired && event.lifecycle === "none" && !event.pidAlive
      && event.bootstrapLeaseElapsed,
    noLifecycleWaiting: ({ event }) =>
      !event.retired && event.lifecycle === "none" && !event.pidAlive
      && !event.bootstrapLeaseElapsed,
    terminalPidAlive: ({ event }) =>
      !event.retired && isTerminal(event.lifecycle) && event.pidAlive,
    terminalDead: ({ event }) =>
      !event.retired && isTerminal(event.lifecycle) && !event.pidAlive,
    runningDead: ({ event }) =>
      !event.retired && event.lifecycle === "running" && !event.pidAlive,
    runningAlive: ({ event }) =>
      !event.retired && event.lifecycle === "running" && event.pidAlive,
  },
  actions: {
    verdict: () => {},
  },
}).createMachine({
  id: "runnerRecovery",
  initial: "decide",
  description: "러너 등록 하나의 복구 가름",
  states: {
    decide: {
      description: "은퇴 표시, 수명 상태, pid 생존, 부트스트랩 임대 경과로 가른다",
      on: {
        CLASSIFY: [
          {
            guard: "retired",
            actions: verdict("retired_terminal"),
            description: "은퇴 표시가 있으면 은퇴로 본다",
          },
          {
            guard: "reaped",
            actions: verdict("already_reaped"),
            description: "이미 치운 기록이다",
          },
          {
            guard: "closed",
            actions: verdict("closed"),
            description: "닫힌 기록이다",
          },
          {
            guard: "noLifecyclePidAlive",
            actions: verdict("adopt_prebootstrap"),
            description: "기록 없이 pid가 살아 있다",
          },
          {
            guard: "noLifecycleLeaseElapsed",
            actions: verdict("reap_dead"),
            description: "기록 없이 pid가 죽었고 임대가 지났다",
          },
          {
            guard: "noLifecycleWaiting",
            actions: verdict("wait_for_bootstrap"),
            description: "기록 없이 pid가 죽었고 임대가 남았다",
          },
          {
            guard: "terminalPidAlive",
            actions: verdict("replay_terminal"),
            description: "끝난 기록이고 pid가 살아 있다",
          },
          {
            guard: "terminalDead",
            actions: verdict("replay_terminal_dead"),
            description: "끝난 기록이고 pid가 죽었다",
          },
          {
            guard: "runningDead",
            actions: verdict("reap_dead"),
            description: "실행 중 기록인데 pid가 죽었다",
          },
          {
            guard: "runningAlive",
            actions: verdict("adopt_running"),
            description: "실행 중 기록이고 pid가 살아 있다",
          },
        ],
      },
    },
  },
});
