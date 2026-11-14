import { setup } from "xstate";

import { classifyRunnerAdoptRejection } from "./node_adopt_rejection.js";

/** 서버 응답을 읽는 호출 종류 일곱이다. */
export const NODE_RESPONSE_CALLS = [
  "execution_registration",
  "startup_recovery_adopt",
  "attached_runner_adopt",
  "resume",
  "resume_compensation_terminal",
  "first_message",
  "termination",
] as const;
export type NodeResponseCall = (typeof NODE_RESPONSE_CALLS)[number];

/** 응답이 노드에 닿는 길 다섯이다. 적용 응답(applied=true)은 이 칸을 거치지 않는다. */
export const NODE_RESPONSE_ROUTES = [
  "transport_retryable",
  "transport_quarantine",
  "dead_letter",
  "applied_false",
  "no_response",
] as const;
export type NodeResponseRoute = (typeof NODE_RESPONSE_ROUTES)[number];

/** 와이어 거절 사유다. `none`은 사유가 실리지 않았다는 뜻이다. */
export const NODE_WIRE_REASONS = [
  "already_terminal",
  "session_missing",
  "owner_node_changed",
  "worktree_busy",
  "worktree_not_ready",
  "none",
] as const;
export type NodeWireReason = (typeof NODE_WIRE_REASONS)[number];

/**
 * 거절된 등록이 task의 지금 등록과 같은가. 다름은 낡은 등록의 거절이다.
 * 정본 투영의 등록 번호와 우리 것을 견준 결과로 호출자가 준다.
 */
export const NODE_REGISTRATION_MATCHES = ["same", "different"] as const;
export type NodeRegistrationMatch = (typeof NODE_REGISTRATION_MATCHES)[number];

/** 정본 투영의 termination_event_id와 우리 종료의 관계다. */
export const NODE_TERMINATION_PROJECTIONS = ["same", "different", "absent"] as const;
export type NodeTerminationProjection = (typeof NODE_TERMINATION_PROJECTIONS)[number];

/** 중앙 세션 유무다. 확인하지 못했으면 `unknown`이다. */
export const NODE_CENTRAL_SESSIONS = ["present", "absent", "unknown"] as const;
export type NodeCentralSession = (typeof NODE_CENTRAL_SESSIONS)[number];

export interface NodeResponseFacts {
  call: NodeResponseCall;
  route: NodeResponseRoute;
  reason: NodeWireReason;
  registration: NodeRegistrationMatch;
  termination: NodeTerminationProjection;
  centralSession: NodeCentralSession;
  /** 종료 뒤 정상 보유 중인가. */
  retained: boolean;
}

export interface NodeResponseEvent extends NodeResponseFacts {
  type: "RESPOND";
}

/** 응답을 받은 칸이다. 적용됨 하나와 거절의 칸 넷이다. */
export const NODE_RESPONSE_CELLS = [
  "applied",
  "retryable",
  "no_retry",
  "permanent",
  "quarantine",
] as const;
export type NodeResponseCell = (typeof NODE_RESPONSE_CELLS)[number];

const wireReason = (reason: NodeWireReason): string | null =>
  reason === "none" ? null : reason;

/**
 * 응답을 받은 칸의 기계다. 전이 배열의 순서가 판정 순서이고 목표 상태가 칸이다.
 * 정리 의도는 칸과 사실에서 node_response_decision이 낸다.
 */
export const nodeResponseMachine = setup({
  types: {
    events: {} as NodeResponseEvent,
  },
  guards: {
    quarantined: ({ event }) => event.route === "transport_quarantine",
    deadLetter: ({ event }) => event.route === "dead_letter",
    notRejected: ({ event }) =>
      event.route === "transport_retryable" || event.route === "no_response",
    terminationAlreadyRecorded: ({ event }) =>
      event.call === "termination" && event.termination === "same",
    terminalReason: ({ event }) =>
      event.route === "applied_false"
      && classifyRunnerAdoptRejection(wireReason(event.reason)) === "terminal_rejection",
    terminationOtherRecorded: ({ event }) =>
      event.route === "applied_false"
      && event.call === "termination"
      && event.reason === "none"
      && event.termination === "different",
    appliedFalse: ({ event }) => event.route === "applied_false",
  },
}).createMachine({
  id: "nodeResponse",
  initial: "decide",
  description: "서버 응답을 받은 칸 하나로 가른다",
  states: {
    decide: {
      description: "응답 길, 사유, 정본 투영으로 위에서부터 처음 맞는 칸으로 간다",
      on: {
        RESPOND: [
          {
            guard: "terminationAlreadyRecorded",
            target: "applied",
            description: "종료 호출에서 정본의 종료 사건이 우리 종료다(응답 길과 사유는 보지 않는다)",
          },
          {
            guard: "quarantined",
            target: "quarantine",
            description: "전송 거절이 영구라 아웃박스 맨 앞 줄을 격리했다",
          },
          {
            guard: "deadLetter",
            target: "permanent",
            description: "응답 안에 dead letter가 실렸다",
          },
          {
            guard: "notRejected",
            target: "retryable",
            description: "전송 거절이 다시 될 수 있거나 응답이 없다",
          },
          {
            guard: "terminalReason",
            target: "no_retry",
            description: "사유가 다시 될 까닭 없는 것이다",
          },
          {
            guard: "terminationOtherRecorded",
            target: "no_retry",
            description: "종료 거절에 사유가 없고 다른 종료가 이미 있다",
          },
          {
            guard: "appliedFalse",
            target: "retryable",
            description: "사유가 없거나 다시 될 수 있는 사유다(옛 서버 호환)",
          },
        ],
      },
    },
    applied: { description: "적용됨" },
    retryable: { description: "다시 될 수 있는 거절" },
    no_retry: { description: "다시 될 까닭이 없는 거절" },
    permanent: { description: "영구 거절" },
    quarantine: { description: "격리" },
  },
});
