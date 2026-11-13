import { setup } from "xstate";

/** 중앙 세션 한 줄을 읽은 결과다. */
export type RunnerCentralLookup =
  | "missing"
  | "lookup_error"
  | "owner_node_changed"
  | "active"
  | "inactive";

/** 직전 잇기 전이의 응답이다. */
export type RunnerAdoptResponse =
  | "none"
  | "applied"
  | "retryable_rejection"
  | "terminal_rejection";

/** 중앙 확인이 고르는 조치다. */
export type RunnerCentralCheckDecision =
  | "reap"
  | "adopt"
  | "keep"
  | "keep_retry";

export interface RunnerCentralCheckFacts {
  /** 중앙 세션 조회 결과. */
  lookup: RunnerCentralLookup;
  /** 종료 확정이면서 정상 보유인가. */
  terminalRetained: boolean;
  /** 이 실행의 등록 적용 응답을 받았고 턴을 도는 중인가. */
  registrationAppliedAndTurnRunning: boolean;
  /** 직전 잇기 응답. */
  adoptResponse: RunnerAdoptResponse;
}

export interface RunnerCentralCheckEvent extends RunnerCentralCheckFacts {
  type: "CHECK";
}

export const RUNNER_CENTRAL_LOOKUPS: readonly RunnerCentralLookup[] = [
  "missing",
  "lookup_error",
  "owner_node_changed",
  "active",
  "inactive",
];

export const RUNNER_ADOPT_RESPONSES: readonly RunnerAdoptResponse[] = [
  "none",
  "applied",
  "retryable_rejection",
  "terminal_rejection",
];

export const RUNNER_CENTRAL_CHECK_DECISIONS: readonly RunnerCentralCheckDecision[] = [
  "reap",
  "adopt",
  "keep",
  "keep_retry",
];

const verdict = (decision: RunnerCentralCheckDecision) => ({
  type: "verdict" as const,
  params: { decision },
});

/**
 * 중앙 확인 기계다. 전이 배열의 순서가 판정 순서다.
 * 액터를 만들지 않고 transition()은 기호 액션만 돌려준다.
 */
export const runnerCentralCheckMachine = setup({
  types: {
    events: {} as RunnerCentralCheckEvent,
  },
  guards: {
    terminalRejection: ({ event }) => event.adoptResponse === "terminal_rejection",
    terminalRejectionRetained: ({ event }) =>
      event.adoptResponse === "terminal_rejection" && event.terminalRetained,
    missing: ({ event }) => event.lookup === "missing",
    ownerNodeChanged: ({ event }) => event.lookup === "owner_node_changed",
    lookupError: ({ event }) => event.lookup === "lookup_error",
    active: ({ event }) => event.lookup === "active",
    retryableRejection: ({ event }) => event.adoptResponse === "retryable_rejection",
    inactiveRetained: ({ event }) =>
      event.lookup === "inactive" && event.terminalRetained,
    inactiveAdoptable: ({ event }) =>
      event.lookup === "inactive"
      && !event.terminalRetained
      && event.registrationAppliedAndTurnRunning,
    inactiveOther: ({ event }) => event.lookup === "inactive",
  },
  actions: {
    verdict: () => {},
  },
}).createMachine({
  id: "runnerCentralCheck",
  initial: "decide",
  description: "러너 하나를 중앙 세션과 대조해 거둘지, 이을지, 둘지 가른다",
  states: {
    decide: {
      description: "조회 결과, 종료 확정 보유, 등록 적용 턴 실행, 직전 잇기 응답으로 가른다",
      on: {
        CHECK: [
          {
            guard: "missing",
            actions: verdict("reap"),
            description: "중앙 줄이 없으면 보유 중이어도 거둔다",
          },
          {
            guard: "ownerNodeChanged",
            actions: verdict("reap"),
            description: "소유 노드가 바뀌었으면 보유 중이어도 거둔다",
          },
          {
            guard: "terminalRejectionRetained",
            actions: verdict("keep"),
            description: "다시 될 까닭 없는 잇기 거절을 받았어도 정상 보유 중이면 거두지 않는다",
          },
          {
            guard: "terminalRejection",
            actions: verdict("reap"),
            description: "다시 될 까닭 없는 잇기 거절이면 거둔다",
          },
          {
            guard: "lookupError",
            actions: verdict("keep"),
            description: "조회 오류면 아무것도 바꾸지 않는다",
          },
          {
            guard: "active",
            actions: verdict("keep"),
            description: "중앙이 활성이면 그대로 둔다",
          },
          {
            guard: "retryableRejection",
            actions: verdict("keep_retry"),
            description: "다시 될 수 있는 잇기 거절이면 두고 간격 뒤 다시 판정한다",
          },
          {
            guard: "inactiveRetained",
            actions: verdict("keep"),
            description: "종료 확정이면서 정상 보유면 잇지도 거두지도 않는다",
          },
          {
            guard: "inactiveAdoptable",
            actions: verdict("adopt"),
            description: "등록 적용을 받고 턴을 도는 중이면 잇는다",
          },
          {
            guard: "inactiveOther",
            actions: verdict("keep"),
            description: "활성 아님이고 그 밖이면 그대로 둔다",
          },
        ],
      },
    },
  },
});
