import { setup } from "xstate";

/**
 * 러너 수명 기록의 상태다. "none"은 저장된 줄이 없는 경우(NULL)다.
 * 저장 문자열(running, completed, failed, closed, reaped)은 그대로 둔다.
 */
export type RunnerLifecycleState =
  | "none"
  | "running"
  | "completed"
  | "failed"
  | "closed"
  | "reaped";

/** 수명 기록에 들어오는 걸음이다. finish는 끝 상태별로 나눠 열거한다. */
export type RunnerLifecycleStep =
  | "begin"
  | "progress"
  | "liveness"
  | "tool_started"
  | "tool_finished"
  | "finish_completed"
  | "finish_failed"
  | "finish_closed"
  | "reap";

export type RunnerLifecycleDecision = "apply" | "reject" | "ignore";

export type RunnerLifecycleEventType =
  | "BEGIN"
  | "PROGRESS"
  | "LIVENESS"
  | "TOOL_STARTED"
  | "TOOL_FINISHED"
  | "FINISH_COMPLETED"
  | "FINISH_FAILED"
  | "FINISH_CLOSED"
  | "REAP";

export interface RunnerLifecycleEvent {
  type: RunnerLifecycleEventType;
  /** 실행 명령 번호가 저장된 번호와 같은가. */
  commandMatches: boolean;
}

export const RUNNER_LIFECYCLE_STEP_EVENT: Readonly<
  Record<RunnerLifecycleStep, RunnerLifecycleEventType>
> = {
  begin: "BEGIN",
  progress: "PROGRESS",
  liveness: "LIVENESS",
  tool_started: "TOOL_STARTED",
  tool_finished: "TOOL_FINISHED",
  finish_completed: "FINISH_COMPLETED",
  finish_failed: "FINISH_FAILED",
  finish_closed: "FINISH_CLOSED",
  reap: "REAP",
};

export const RUNNER_LIFECYCLE_STATES: readonly RunnerLifecycleState[] = [
  "none",
  "running",
  "completed",
  "failed",
  "closed",
  "reaped",
];

export const RUNNER_LIFECYCLE_STEPS: readonly RunnerLifecycleStep[] = [
  "begin",
  "progress",
  "liveness",
  "tool_started",
  "tool_finished",
  "finish_completed",
  "finish_failed",
  "finish_closed",
  "reap",
];

const reject = (description: string) => ({
  actions: "reject",
  description,
});

const rejectMismatch = (description: string) => ({
  actions: "reject",
  description,
});

const matching = (description: string, transition: Record<string, unknown>) => [
  {
    guard: "commandMatches" as const,
    ...transition,
    description,
  },
  rejectMismatch("실행 명령 번호가 달라 거부한다"),
];

function observations() {
  return {
    PROGRESS: matching("실행 중이고 번호가 같으면 진행을 적는다", {
      target: "running",
      actions: "apply",
    }),
    LIVENESS: matching("실행 중이고 번호가 같으면 생존을 적는다", {
      target: "running",
      actions: "apply",
    }),
    TOOL_STARTED: matching("실행 중이고 번호가 같으면 도구 시작을 적는다", {
      target: "running",
      actions: "apply",
    }),
    TOOL_FINISHED: matching("실행 중이고 번호가 같으면 도구 끝을 적는다", {
      target: "running",
      actions: "apply",
    }),
  };
}

const begin = (description: string) => ({
  target: "running",
  actions: "apply",
  description,
});

/**
 * 수명 기록 기계다. 액터를 만들지 않는다. transition()은 기호 액션만 돌려주고
 * SQL은 부르는 쪽이 실행한다.
 */
export const runnerLifecycleMachine = setup({
  types: {
    events: {} as RunnerLifecycleEvent,
  },
  guards: {
    commandMatches: ({ event }) => event.commandMatches,
  },
  actions: Object.fromEntries(
    ["apply", "reject", "ignore"].map((name) => [name, () => {}]),
  ) as Record<string, () => void>,
}).createMachine({
  id: "runnerLifecycle",
  initial: "none",
  description: "러너 등록 하나의 실행 명령 수명 기록",
  states: {
    none: {
      description: "수명 기록 없음",
      on: {
        BEGIN: begin("기록이 없어도 실행을 연다"),
        PROGRESS: reject("기록이 없으면 진행을 적지 않는다"),
        LIVENESS: reject("기록이 없으면 생존을 적지 않는다"),
        TOOL_STARTED: reject("기록이 없으면 도구 시작을 적지 않는다"),
        TOOL_FINISHED: reject("기록이 없으면 도구 끝을 적지 않는다"),
        FINISH_COMPLETED: reject("기록이 없으면 완료로 닫지 않는다"),
        FINISH_FAILED: reject("기록이 없으면 실패로 닫지 않는다"),
        FINISH_CLOSED: reject("기록이 없으면 닫지 않는다"),
        REAP: reject("기록이 없으면 치우지 않는다"),
      },
    },
    running: {
      description: "실행 중",
      on: {
        BEGIN: begin("새 실행 명령으로 다시 연다"),
        ...observations(),
        FINISH_COMPLETED: matching("실행 중이고 번호가 같으면 완료로 닫는다", {
          target: "completed",
          actions: "apply",
        }),
        FINISH_FAILED: matching("실행 중이고 번호가 같으면 실패로 닫는다", {
          target: "failed",
          actions: "apply",
        }),
        FINISH_CLOSED: matching("실행 중이고 번호가 같으면 닫는다", {
          target: "closed",
          actions: "apply",
        }),
        REAP: matching("실행 중이고 번호가 같으면 치운다", {
          target: "reaped",
          actions: "apply",
        }),
      },
    },
    completed: {
      description: "완료됨",
      on: {
        BEGIN: begin("끝난 기록도 새 실행 명령으로 다시 연다"),
        PROGRESS: reject("끝난 기록에는 진행을 적지 않는다"),
        LIVENESS: reject("끝난 기록에는 생존을 적지 않는다"),
        TOOL_STARTED: reject("끝난 기록에는 도구 시작을 적지 않는다"),
        TOOL_FINISHED: reject("끝난 기록에는 도구 끝을 적지 않는다"),
        FINISH_COMPLETED: reject("이미 끝난 기록을 다시 닫지 않는다"),
        FINISH_FAILED: reject("이미 끝난 기록을 실패로 덮지 않는다"),
        FINISH_CLOSED: reject("이미 끝난 기록을 닫지 않는다"),
        REAP: reject("이미 끝난 기록을 치우지 않는다"),
      },
    },
    failed: {
      description: "실패함",
      on: {
        BEGIN: begin("끝난 기록도 새 실행 명령으로 다시 연다"),
        PROGRESS: reject("끝난 기록에는 진행을 적지 않는다"),
        LIVENESS: reject("끝난 기록에는 생존을 적지 않는다"),
        TOOL_STARTED: reject("끝난 기록에는 도구 시작을 적지 않는다"),
        TOOL_FINISHED: reject("끝난 기록에는 도구 끝을 적지 않는다"),
        FINISH_COMPLETED: reject("이미 끝난 기록을 완료로 덮지 않는다"),
        FINISH_FAILED: reject("이미 끝난 기록을 다시 닫지 않는다"),
        FINISH_CLOSED: reject("이미 끝난 기록을 닫지 않는다"),
        REAP: reject("이미 끝난 기록을 치우지 않는다"),
      },
    },
    closed: {
      description: "닫힘",
      on: {
        BEGIN: begin("닫힌 기록도 새 실행 명령으로 다시 연다"),
        PROGRESS: reject("닫힌 기록에는 진행을 적지 않는다"),
        LIVENESS: reject("닫힌 기록에는 생존을 적지 않는다"),
        TOOL_STARTED: reject("닫힌 기록에는 도구 시작을 적지 않는다"),
        TOOL_FINISHED: reject("닫힌 기록에는 도구 끝을 적지 않는다"),
        FINISH_COMPLETED: [
          {
            guard: "commandMatches",
            actions: "ignore",
            description: "닫힌 뒤 온 늦은 완료는 무시한다",
          },
          rejectMismatch("실행 명령 번호가 달라 거부한다"),
        ],
        FINISH_FAILED: [
          {
            guard: "commandMatches",
            actions: "ignore",
            description: "닫힌 뒤 온 늦은 실패는 무시한다",
          },
          rejectMismatch("실행 명령 번호가 달라 거부한다"),
        ],
        FINISH_CLOSED: [
          {
            guard: "commandMatches",
            actions: "ignore",
            description: "닫힌 뒤 온 늦은 닫기도 무시한다",
          },
          rejectMismatch("실행 명령 번호가 달라 거부한다"),
        ],
        REAP: reject("닫힌 기록을 치우지 않는다"),
      },
    },
    reaped: {
      description: "치워짐",
      on: {
        BEGIN: begin("치운 기록도 새 실행 명령으로 다시 연다"),
        PROGRESS: reject("치운 기록에는 진행을 적지 않는다"),
        LIVENESS: reject("치운 기록에는 생존을 적지 않는다"),
        TOOL_STARTED: reject("치운 기록에는 도구 시작을 적지 않는다"),
        TOOL_FINISHED: reject("치운 기록에는 도구 끝을 적지 않는다"),
        FINISH_COMPLETED: [
          {
            guard: "commandMatches",
            actions: "ignore",
            description: "치운 뒤 온 늦은 완료는 무시한다",
          },
          rejectMismatch("실행 명령 번호가 달라 거부한다"),
        ],
        FINISH_FAILED: [
          {
            guard: "commandMatches",
            actions: "ignore",
            description: "치운 뒤 온 늦은 실패는 무시한다",
          },
          rejectMismatch("실행 명령 번호가 달라 거부한다"),
        ],
        FINISH_CLOSED: [
          {
            guard: "commandMatches",
            actions: "ignore",
            description: "치운 뒤 온 늦은 닫기도 무시한다",
          },
          rejectMismatch("실행 명령 번호가 달라 거부한다"),
        ],
        REAP: reject("이미 치운 기록을 다시 치우지 않는다"),
      },
    },
  },
});
