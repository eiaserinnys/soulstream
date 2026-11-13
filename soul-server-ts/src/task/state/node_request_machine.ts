import { setup } from "xstate";

import { NODE_EXECUTION_PHASES, type NodeExecutionPhase } from "./node_execution_machine.js";

/** 바깥에서 오는 요청 넷이다. */
export const NODE_REQUEST_KINDS = ["stop", "intervene", "delete", "resume"] as const;
export type NodeRequestKind = (typeof NODE_REQUEST_KINDS)[number];

export const NODE_STOP_REQUEST_DISPOSITIONS = [
  "reject_not_running",
  "terminate_without_runner",
  "interrupt_and_terminate",
  "join_stop",
] as const;
export const NODE_INTERVENE_REQUEST_DISPOSITIONS = [
  "queue_and_restart",
  "hold_until_started",
  "deliver_or_queue",
] as const;
export const NODE_DELETE_REQUEST_DISPOSITIONS = [
  "delete_row",
  "terminate_without_runner_then_delete",
  "stop_then_delete",
] as const;
export const NODE_RESUME_REQUEST_DISPOSITIONS = [
  "start_execution",
  "join_start",
  "start_on_retained_runner",
  "reject_runner_attached",
  "wait_then_start",
] as const;

export type NodeRequestDisposition =
  | (typeof NODE_STOP_REQUEST_DISPOSITIONS)[number]
  | (typeof NODE_INTERVENE_REQUEST_DISPOSITIONS)[number]
  | (typeof NODE_DELETE_REQUEST_DISPOSITIONS)[number]
  | (typeof NODE_RESUME_REQUEST_DISPOSITIONS)[number];

/**
 * 칸의 근거다. `design`은 설계가 정한 처분, `current`는 지금 코드의 동작을 그대로 적은 것,
 * `open`은 옛 결정표에서 확인 못 함이었거나 설계가 정하지 않아 뒤 단위가 코드로 닫을 칸이다.
 */
export type NodeRequestBasis = "design" | "current" | "open";

export interface NodeRequestCell {
  disposition: NodeRequestDisposition;
  basis: NodeRequestBasis;
  note: string;
}

type PhaseRow = Record<NodeRequestKind, NodeRequestCell>;

const cell = (
  disposition: NodeRequestDisposition,
  basis: NodeRequestBasis,
  note: string,
): NodeRequestCell => ({ disposition, basis, note });

/**
 * 실행 상태 x 요청 종류의 처분 표다. 기계는 이 표에서 만든다. 칸을 빼면 형 검사가 막는다.
 * 러너 없이 올린 활성 task의 멈춤과 삭제는 종료 기록을 만드는 처분이다.
 */
export const NODE_REQUEST_TABLE: Readonly<Record<NodeExecutionPhase, PhaseRow>> = {
  idle: {
    stop: cell("reject_not_running", "current", "이미 끝난 세션이라 거짓을 돌려준다"),
    intervene: cell("queue_and_restart", "current", "대기 줄에 넣고 다시 띄운다"),
    delete: cell("delete_row", "current", "줄을 지운다"),
    resume: cell("start_execution", "current", "새 실행을 시작한다"),
  },
  hydrated_active: {
    stop: cell("terminate_without_runner", "design", "SESSION_NOT_RUNNING으로 돌려보내지 않고 종료 기록을 만든다"),
    intervene: cell("queue_and_restart", "open", "러너가 없으므로 대기 줄에 넣고 다시 띄운다"),
    delete: cell("terminate_without_runner_then_delete", "design", "조용히 지우지 않고 종료 기록을 만든 뒤 지운다"),
    resume: cell("start_execution", "open", "러너를 새로 띄운다"),
  },
  starting: {
    stop: cell("reject_not_running", "current", "러너가 붙어 있지 않아 거짓을 돌려준다"),
    intervene: cell("hold_until_started", "current", "시동이 끝날 때까지 붙든다"),
    delete: cell("delete_row", "current", "러너가 없는 시동 단계는 바로 지운다"),
    resume: cell("join_start", "current", "이미 시동 중이라 그 시동에 붙는다"),
  },
  registering: {
    stop: cell("interrupt_and_terminate", "open", "러너에 멈춤 명령을 보내고 멈춤으로 종료를 올린다. 뒤에 닿는 등록 응답과의 겹침은 뒤 단위가 닫는다"),
    intervene: cell("hold_until_started", "current", "시동이 끝날 때까지 붙든다"),
    delete: cell("stop_then_delete", "current", "러너가 붙은 활성 task라 멈춘 뒤 지운다"),
    resume: cell("join_start", "current", "이미 시동 중이라 그 시동에 붙는다"),
  },
  running: {
    stop: cell("interrupt_and_terminate", "current", "러너에 멈춤 명령을 보내고 멈춤으로 종료를 올린다"),
    intervene: cell("deliver_or_queue", "current", "엔진에 바로 넣어 보고 안 들어가면 대기 줄에 쌓는다"),
    delete: cell("stop_then_delete", "current", "멈춘 뒤 지운다"),
    resume: cell("reject_runner_attached", "current", "러너가 붙어 있으면 새 실행을 시작하지 않는다"),
  },
  replaying: {
    stop: cell("interrupt_and_terminate", "open", "남은 기록을 올리는 중의 멈춤이 기록과 어떻게 겹치는지는 뒤 단위가 닫는다"),
    intervene: cell("deliver_or_queue", "open", "러너가 붙어 있고 도는 중이면 넘긴다. 불러온 상태는 뒤 단위가 닫는다"),
    delete: cell("stop_then_delete", "current", "러너가 붙은 활성 task라 멈춘 뒤 지운다"),
    resume: cell("reject_runner_attached", "open", "러너가 붙어 있으면 새 실행을 시작하지 않는다"),
  },
  stopping: {
    stop: cell("join_stop", "current", "앞선 멈춤에 붙는다"),
    intervene: cell("queue_and_restart", "current", "끝난 세션으로 보고 다시 띄우는 길로 간다"),
    delete: cell("stop_then_delete", "current", "멈춤 마무리를 기다린 뒤 지운다"),
    resume: cell("wait_then_start", "current", "앞 실행의 종료가 끝나기를 기다린 뒤 시작한다"),
  },
  terminating: {
    stop: cell("reject_not_running", "current", "이미 끝난 세션이라 거짓을 돌려준다"),
    intervene: cell("queue_and_restart", "current", "끝난 세션으로 보고 다시 띄우는 길로 간다"),
    delete: cell("delete_row", "current", "줄을 지운다"),
    resume: cell("wait_then_start", "current", "앞 실행의 종료가 끝나기를 기다린 뒤 시작한다"),
  },
  retained_claude_background: {
    stop: cell("reject_not_running", "open", "종료 뒤 보유 중의 멈춤은 지금 거짓을 돌려준다"),
    intervene: cell("queue_and_restart", "open", "보유한 러너로 다시 띄운다"),
    delete: cell("delete_row", "open", "줄을 지운다. 보유한 러너의 거둠은 중앙 확인이 맡는다"),
    resume: cell("start_on_retained_runner", "open", "보유한 러너를 받아 새 실행을 시작한다"),
  },
  retained_codex_command: {
    stop: cell("reject_not_running", "open", "종료 뒤 보유 중의 멈춤은 지금 거짓을 돌려준다"),
    intervene: cell("queue_and_restart", "open", "보유가 풀린 뒤 다시 띄운다"),
    delete: cell("delete_row", "open", "줄을 지운다. 보유한 러너의 거둠은 중앙 확인이 맡는다"),
    resume: cell("wait_then_start", "open", "보유가 풀린 뒤 시작한다"),
  },
  retained_releasing: {
    stop: cell("reject_not_running", "open", "해제 중의 멈춤은 지금 거짓을 돌려준다"),
    intervene: cell("queue_and_restart", "open", "해제가 끝난 뒤 다시 띄운다"),
    delete: cell("delete_row", "open", "줄을 지운다. 해제는 계속된다"),
    resume: cell("wait_then_start", "open", "해제가 끝난 뒤 시작한다"),
  },
};

const REQUEST_EVENT: Readonly<Record<NodeRequestKind, "STOP" | "INTERVENE" | "DELETE" | "RESUME">> = {
  stop: "STOP",
  intervene: "INTERVENE",
  delete: "DELETE",
  resume: "RESUME",
};

export type NodeRequestEventType = (typeof REQUEST_EVENT)[NodeRequestKind];

export interface NodeRequestEvent {
  type: NodeRequestEventType;
}

export const NODE_REQUEST_EVENTS: Readonly<Record<NodeRequestKind, NodeRequestEventType>> =
  REQUEST_EVENT;

function phaseStates() {
  const states: Record<string, unknown> = {};
  for (const phase of NODE_EXECUTION_PHASES) {
    const on: Record<string, unknown> = {};
    for (const request of NODE_REQUEST_KINDS) {
      const entry = NODE_REQUEST_TABLE[phase][request];
      on[REQUEST_EVENT[request]] = {
        actions: {
          type: "verdict",
          params: { disposition: entry.disposition },
        },
        description: entry.note,
      };
    }
    states[phase] = { description: phase, on };
  }
  return states;
}

/**
 * 바깥 요청 칸의 기계다. 상태가 실행 상태이고 사건이 요청이다.
 * 어느 상태도 전이하지 않고 처분만 낸다.
 */
export const nodeRequestMachine = setup({
  types: {
    events: {} as NodeRequestEvent,
  },
  actions: {
    verdict: () => {},
  },
}).createMachine({
  id: "nodeRequest",
  initial: "idle",
  description: "실행 상태마다 멈춤, 지시, 삭제, 재개 요청의 처분을 정한다",
  states: phaseStates() as never,
});
