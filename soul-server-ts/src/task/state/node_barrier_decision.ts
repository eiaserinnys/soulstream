import { transition } from "xstate";

import {
  nodeBarrierMachine,
  type NodeBarrierEventType,
  type NodeBarrierState,
  type NodeStopDisposition,
} from "./node_barrier_machine.js";

interface VerdictAction {
  type: "verdict";
  params: { disposition: NodeStopDisposition };
}

export interface NodeBarrierStep {
  state: NodeBarrierState;
  /** 멈춤 요청이 받은 처분이다. 멈춤 요청이 아닌 사건에서는 null이다. */
  stop: NodeStopDisposition | null;
}

/** 장벽이 서 있는 모양에 사건 하나를 넣어 다음 모양과 멈춤 처분을 낸다. */
export function stepNodeBarrier(
  state: NodeBarrierState,
  event: NodeBarrierEventType,
): NodeBarrierStep {
  const snapshot = nodeBarrierMachine.resolveState({ value: state, context: {} });
  const [next, actions] = transition(nodeBarrierMachine, snapshot, { type: event });
  const verdict = (actions as { type: string; params?: unknown }[]).find(
    (action) => action.type === "verdict",
  ) as VerdictAction | undefined;
  if (event === "STOP_REQUESTED" && verdict === undefined) {
    throw new Error(`stop request without disposition: ${state}`);
  }
  return {
    state: next.value as NodeBarrierState,
    stop: verdict?.params.disposition ?? null,
  };
}

/** 멈춤 요청이 앞선 장벽을 만났을 때의 처분을 낸다. */
export function decideNodeStopRequest(
  preceding: NodeBarrierState,
): NodeStopDisposition {
  const { stop } = stepNodeBarrier(preceding, "STOP_REQUESTED");
  if (stop === null) throw new Error(`stop request without disposition: ${preceding}`);
  return stop;
}
