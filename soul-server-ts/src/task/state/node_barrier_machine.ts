import { setup } from "xstate";

/** 한 task의 일을 줄 세우는 장벽의 종류 셋이다. */
export const NODE_BARRIER_KINDS = [
  "execution_start",
  "intervention_handoff",
  "stop",
] as const;
export type NodeBarrierKind = (typeof NODE_BARRIER_KINDS)[number];

/** 장벽이 서 있는 모양이다. 멈춤 요청이 넘기기 장벽을 기다리는 중이 하나 더 있다. */
export const NODE_BARRIER_STATES = [
  "none",
  "execution_start",
  "intervention_handoff",
  "stop_waiting_handoff",
  "stop",
] as const;
export type NodeBarrierState = (typeof NODE_BARRIER_STATES)[number];

/** 멈춤 요청이 앞선 장벽을 만나 받는 처분이다. 빈 값으로 돌아가는 처분은 없다. */
export const NODE_STOP_DISPOSITIONS = [
  "stop_now",
  "stop_after_handoff",
  "already_stopping",
] as const;
export type NodeStopDisposition = (typeof NODE_STOP_DISPOSITIONS)[number];

export const NODE_BARRIER_EVENTS = [
  "START_BEGUN",
  "START_RELEASED",
  "HANDOFF_BEGUN",
  "HANDOFF_RELEASED",
  "STOP_REQUESTED",
  "STOP_DONE",
] as const;
export type NodeBarrierEventType = (typeof NODE_BARRIER_EVENTS)[number];

export interface NodeBarrierEvent {
  type: NodeBarrierEventType;
}

const stop = (disposition: NodeStopDisposition) => ({
  type: "verdict" as const,
  params: { disposition },
});

/**
 * 실행 장벽, 지시 넘기기 장벽, 멈춤 장벽의 직렬화 기계다.
 * 넘기기 장벽을 기다린 멈춤은 장벽이 풀리면 멈춤 장벽으로 올라 보통 멈춤 길을 탄다.
 * 장벽을 지우고 돌아가는 전이는 없다.
 */
export const nodeBarrierMachine = setup({
  types: {
    events: {} as NodeBarrierEvent,
  },
  actions: {
    verdict: () => {},
  },
}).createMachine({
  id: "nodeBarrier",
  initial: "none",
  description: "실행 시작, 지시 넘기기, 멈춤 장벽의 직렬화",
  states: {
    none: {
      description: "장벽 없음",
      on: {
        START_BEGUN: { target: "execution_start", description: "실행 시작 장벽을 올린다" },
        HANDOFF_BEGUN: { target: "intervention_handoff", description: "지시 넘기기 장벽을 올린다" },
        STOP_REQUESTED: {
          target: "stop",
          actions: stop("stop_now"),
          description: "곧바로 멈춘다",
        },
      },
    },
    execution_start: {
      description: "실행 시작 장벽",
      on: {
        START_RELEASED: { target: "none", description: "시작 장벽이 풀린다" },
        STOP_REQUESTED: {
          target: "stop",
          actions: stop("stop_now"),
          description: "시작 장벽을 기다리지 않고 곧바로 멈춘다",
        },
      },
    },
    intervention_handoff: {
      description: "지시 넘기기 장벽",
      on: {
        HANDOFF_RELEASED: { target: "none", description: "넘기기가 끝난다" },
        STOP_REQUESTED: {
          target: "stop_waiting_handoff",
          actions: stop("stop_after_handoff"),
          description: "넘기기가 끝난 뒤 보통 멈춤 길로 간다",
        },
      },
    },
    stop_waiting_handoff: {
      description: "넘기기가 끝나기를 기다리는 멈춤",
      on: {
        HANDOFF_RELEASED: {
          target: "stop",
          description: "넘기기가 끝나면 멈춤 장벽을 올려 보통 멈춤 길을 탄다",
        },
        STOP_REQUESTED: {
          target: "stop_waiting_handoff",
          actions: stop("already_stopping"),
          description: "이미 멈추는 중이다",
        },
      },
    },
    stop: {
      description: "멈춤 장벽",
      on: {
        STOP_DONE: { target: "none", description: "멈춤이 끝난다" },
        STOP_REQUESTED: {
          target: "stop",
          actions: stop("already_stopping"),
          description: "이미 멈추는 중이다",
        },
      },
    },
  },
});
