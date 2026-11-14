import { setup } from "xstate";

import { NODE_EXECUTION_PHASES, type NodeExecutionPhase } from "./node_execution_machine.js";

/** 바깥에서 오는 요청 넷이다. */
export const NODE_REQUEST_KINDS = ["stop", "intervene", "delete", "resume"] as const;
export type NodeRequestKind = (typeof NODE_REQUEST_KINDS)[number];

export const NODE_STOP_REQUEST_DISPOSITIONS = [
  "reject_not_running",
  "already_converged",
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
 * 칸의 근거다. `design`은 설계가 정한 처분, `current`는 운영 코드의 동작을 경계 시험으로
 * 확인한 처분이다. 확인 못 한 칸(옛 `open`)은 카드 #1266 U5b가 모두 닫았고 다시 두지 않는다.
 */
export type NodeRequestBasis = "design" | "current";

export interface NodeRequestCell {
  disposition: NodeRequestDisposition;
  basis: NodeRequestBasis;
  note: string;
  /**
   * 이 칸을 운영 진입 함수로 확인하는 경계 시험의 이름이다. 시험은
   * `NODE_REQUEST_BOUNDARY_TEST_FILES` 가운데 하나에 있고, 표와 시험이 어긋나면 시험이 실패한다.
   */
  test: string;
}

/** 바깥 요청 칸과 닫은 짐작 칸의 경계 시험 파일이다(리포 루트 기준). */
export const NODE_REQUEST_BOUNDARY_TEST_FILES = [
  "soul-server-ts/tests/task/card1266_request_cells.test.ts",
  "soul-server-ts/tests/task/card1266_request_cells_replay.test.ts",
  "soul-server-ts/tests/task/card1266_request_cells_retained.test.ts",
] as const;

type PhaseRow = Record<NodeRequestKind, NodeRequestCell>;

const cell = (
  disposition: NodeRequestDisposition,
  basis: NodeRequestBasis,
  note: string,
  test: string,
): NodeRequestCell => ({ disposition, basis, note, test });

/**
 * 실행 상태 x 요청 종류의 처분 표다. 기계는 이 표에서 만든다. 칸을 빼면 형 검사가 막는다.
 * 요청의 운영 진입 함수는 멈춤 `TaskManager.cancelTask`, 지시 `addIntervention`,
 * 삭제 `deleteTask`, 재개 `ensureRunning`(명시적 시작 의도)이다.
 * 러너 없이 올린 활성 task의 멈춤과 삭제는 종료 기록을 만드는 처분이다.
 */
export const NODE_REQUEST_TABLE: Readonly<Record<NodeExecutionPhase, PhaseRow>> = {
  idle: {
    stop: cell(
      "already_converged",
      "current",
      "끝났고 러너도 실행 등록도 없어 멈춤이 이미 수렴한 것으로 보고 참을 돌려준다",
      "주인 없음에 멈춤이 오면 이미 수렴한 멈춤으로 참을 돌려준다",
    ),
    intervene: cell(
      "queue_and_restart",
      "current",
      "대기 줄에 넣고 다시 띄운다",
      "주인 없음에 지시가 오면 대기 줄에 넣고 다시 띄운다",
    ),
    delete: cell(
      "delete_row",
      "current",
      "종료 기록 없이 줄을 지운다",
      "주인 없음을 지우면 종료 기록 없이 줄을 지운다",
    ),
    resume: cell(
      "start_execution",
      "current",
      "새 실행을 시작한다",
      "주인 없음에 재개가 오면 새 실행을 시작한다",
    ),
  },
  hydrated_active: {
    stop: cell(
      "terminate_without_runner",
      "current",
      "SESSION_NOT_RUNNING으로 돌려보내지 않고 종료 기록을 만든다",
      "러너 없이 올린 활성 task를 멈추면 종료 기록을 만든다",
    ),
    intervene: cell(
      "queue_and_restart",
      "current",
      "살아 있는 실행이 없어 대기 줄에 넣고 다시 띄운다",
      "러너 없이 올린 활성 task에 지시가 오면 대기 줄에 넣고 다시 띄운다",
    ),
    delete: cell(
      "terminate_without_runner_then_delete",
      "current",
      "조용히 지우지 않고 종료 기록을 만든 뒤 지운다",
      "러너 없이 올린 활성 task를 지우면 종료 기록을 만든 뒤 지운다",
    ),
    resume: cell(
      "start_execution",
      "current",
      "살아 있는 실행이 없어 새 실행을 시작한다",
      "러너 없이 올린 활성 task에 재개가 오면 새 실행을 시작한다",
    ),
  },
  starting: {
    stop: cell(
      "reject_not_running",
      "current",
      "러너가 붙어 있지 않아 거짓을 돌려준다",
      "시동 중에 멈춤이 오면 거짓을 돌려준다",
    ),
    intervene: cell(
      "hold_until_started",
      "current",
      "시동이 끝날 때까지 붙든다",
      "시동 중에 지시가 오면 시동이 끝날 때까지 붙든다",
    ),
    delete: cell(
      "delete_row",
      "current",
      "러너가 없는 시동 단계는 바로 지운다",
      "시동 중인 task를 지우면 바로 줄을 지운다",
    ),
    resume: cell(
      "join_start",
      "current",
      "이미 시동 중이라 그 시동에 붙는다",
      "시동 중에 재개가 오면 그 시동에 붙는다",
    ),
  },
  registering: {
    stop: cell(
      "interrupt_and_terminate",
      "current",
      "러너에 멈춤 명령을 보내고 멈춤으로 종료를 올린다. 등록 응답이 먼저 닿아 running으로 투영해도 뒤이은 종료 응답이 멈춤으로 닫는다",
      "등록 응답을 기다리는 중에 멈춤이 오면 멈춤 하나로 닫힌다",
    ),
    intervene: cell(
      "hold_until_started",
      "current",
      "시동이 끝날 때까지 붙든다",
      "등록 응답을 기다리는 중에 지시가 오면 등록이 끝날 때까지 붙든다",
    ),
    delete: cell(
      "stop_then_delete",
      "current",
      "러너가 붙은 활성 task라 멈춘 뒤 지운다",
      "등록 응답을 기다리는 중에 지우면 멈춘 뒤 지운다",
    ),
    resume: cell(
      "join_start",
      "current",
      "이미 시동 중이라 그 시동에 붙는다",
      "등록 응답을 기다리는 중에 재개가 오면 그 시동에 붙는다",
    ),
  },
  running: {
    stop: cell(
      "interrupt_and_terminate",
      "current",
      "러너에 멈춤 명령을 보내고 멈춤으로 종료를 올린다. 잇기 응답을 기다리는 중도 같다",
      "턴을 도는 중에 멈춤이 오면 러너를 멈추고 멈춤으로 닫는다",
    ),
    intervene: cell(
      "deliver_or_queue",
      "current",
      "엔진에 바로 넣어 보고 안 들어가면 대기 줄에 쌓는다. 잇기 응답을 기다리는 중도 같다",
      "턴을 도는 중에 지시가 오면 엔진에 넘긴다",
    ),
    delete: cell(
      "stop_then_delete",
      "current",
      "멈춘 뒤 지운다",
      "턴을 도는 중에 지우면 멈춘 뒤 지운다",
    ),
    resume: cell(
      "reject_runner_attached",
      "current",
      "살아 있는 실행이 있어 새 실행을 시작하지 않고 그 실행을 돌려준다",
      "턴을 도는 중에 재개가 오면 새 실행을 시작하지 않는다",
    ),
  },
  replaying: {
    stop: cell(
      "interrupt_and_terminate",
      "current",
      "재생 손잡이에 멈춤 명령을 보낸다. 손잡이 뒤에는 러너가 없어 명령이 실패하므로, 멈춤 확인 실패로 종료를 한 번 올리고 거짓을 돌려준다. 재생은 멈춤 마무리를 기다린 뒤 끝나 종료를 다시 올리지 않는다",
      "남은 기록을 올리는 중에 멈춤이 오면 멈춤 하나로 닫힌다",
    ),
    intervene: cell(
      "deliver_or_queue",
      "current",
      "기록을 다시 읽는 손잡이에는 받을 엔진이 없어 넣지 않고 대기 줄에 쌓는다. 재생이 끝나면 쌓인 지시로 다시 띄운다",
      "남은 기록을 올리는 중에 지시가 오면 대기 줄에 쌓았다가 재생이 끝난 뒤 다시 띄운다",
    ),
    delete: cell(
      "stop_then_delete",
      "current",
      "러너가 붙은 활성 task라 멈춘 뒤 지운다. 멈춤 명령은 실패하지만 종료를 한 번 올리고 줄을 지운다",
      "남은 기록을 올리는 중에 지우면 멈춘 뒤 지운다",
    ),
    resume: cell(
      "reject_runner_attached",
      "current",
      "실행 등록이 남아 있어 새 실행을 시작하지 않고 그 실행을 돌려준다",
      "남은 기록을 올리는 중에 재개가 오면 새 실행을 시작하지 않는다",
    ),
  },
  stopping: {
    stop: cell(
      "join_stop",
      "current",
      "앞선 멈춤에 붙는다",
      "멈추는 중에 멈춤이 오면 앞선 멈춤에 붙는다",
    ),
    intervene: cell(
      "queue_and_restart",
      "current",
      "끊길 턴에 넣지 않고 멈춤 장벽도 건드리지 않은 채 대기 줄에 쌓는다. 멈춤이 끝나면 그 지시로 한 번 다시 띄우고, 뒤이은 삭제가 있으면 띄우지 않는다",
      "멈추는 중에 지시가 오면 대기 줄에 쌓았다가 멈춤이 끝난 뒤 다시 띄운다",
    ),
    delete: cell(
      "stop_then_delete",
      "current",
      "멈춤 마무리를 기다린 뒤 지운다",
      "멈추는 중에 지우면 멈춤 마무리를 기다린 뒤 지운다",
    ),
    resume: cell(
      "wait_then_start",
      "current",
      "끝나 가는 실행으로 답하지 않는다. 멈춤이 끝난 뒤 그 프롬프트로 새 실행을 시작하고, 시작하지 못하면 오류로 돌려준다",
      "멈추는 중에 재개가 오면 멈춤이 끝난 뒤 그 프롬프트로 새 실행을 시작한다",
    ),
  },
  terminating: {
    stop: cell(
      "reject_not_running",
      "current",
      "이미 끝난 세션이라 거짓을 돌려준다",
      "종료를 올리는 중에 멈춤이 오면 거짓을 돌려준다",
    ),
    intervene: cell(
      "queue_and_restart",
      "current",
      "끝난 세션으로 보고 종료 정리가 끝나기를 기다린 뒤 다시 띄운다",
      "종료를 올리는 중에 지시가 오면 종료가 끝난 뒤 다시 띄운다",
    ),
    delete: cell(
      "delete_row",
      "current",
      "줄을 지운다",
      "종료를 올리는 중에 지우면 줄을 지운다",
    ),
    resume: cell(
      "wait_then_start",
      "current",
      "끝나 가는 실행으로 답하지 않는다. 종료가 끝난 뒤 그 프롬프트로 새 실행을 시작하고, 시작하지 못하면 오류로 돌려준다",
      "종료를 올리는 중에 재개가 오면 종료가 끝난 뒤 그 프롬프트로 새 실행을 시작한다",
    ),
  },
  retained_claude_background: {
    stop: cell(
      "reject_not_running",
      "current",
      "종료 뒤 보유 중의 멈춤은 거짓을 돌려준다. 보유한 러너는 그대로 둔다",
      "클로드 보유 중에 멈춤이 오면 거짓을 돌려준다",
    ),
    intervene: cell(
      "queue_and_restart",
      "current",
      "보유한 러너로 다시 띄운다",
      "클로드 보유 중에 지시가 오면 보유한 러너로 다시 띄운다",
    ),
    delete: cell(
      "delete_row",
      "current",
      "보유한 러너를 닫고 등록을 은퇴시킨 뒤 줄을 지운다",
      "클로드 보유 중에 지우면 보유한 러너를 닫고 줄을 지운다",
    ),
    resume: cell(
      "start_on_retained_runner",
      "current",
      "보유한 러너를 받아 새 실행을 시작한다",
      "클로드 보유 중에 재개가 오면 보유한 러너로 새 실행을 시작한다",
    ),
  },
  retained_codex_command: {
    stop: cell(
      "reject_not_running",
      "current",
      "종료 뒤 보유 중의 멈춤은 거짓을 돌려준다. 보유한 러너는 그대로 둔다",
      "코덱스 보유 중에 멈춤이 오면 거짓을 돌려준다",
    ),
    intervene: cell(
      "queue_and_restart",
      "current",
      "보유가 풀리기를 기다리지 않고 보유한 러너로 다시 띄운다",
      "코덱스 보유 중에 지시가 오면 보유한 러너로 다시 띄운다",
    ),
    delete: cell(
      "delete_row",
      "current",
      "보유한 러너를 닫고 등록을 은퇴시킨 뒤 줄을 지운다",
      "코덱스 보유 중에 지우면 보유한 러너를 닫고 줄을 지운다",
    ),
    resume: cell(
      "start_on_retained_runner",
      "current",
      "보유가 풀리기를 기다리지 않고 보유한 러너를 받아 새 실행을 시작한다",
      "코덱스 보유 중에 재개가 오면 보유한 러너로 새 실행을 시작한다",
    ),
  },
  retained_releasing: {
    stop: cell(
      "reject_not_running",
      "current",
      "해제 중의 멈춤은 거짓을 돌려준다",
      "러너 해제 중에 멈춤이 오면 거짓을 돌려준다",
    ),
    intervene: cell(
      "queue_and_restart",
      "current",
      "해제가 끝난 뒤 새 러너로 다시 띄운다",
      "러너 해제 중에 지시가 오면 해제가 끝난 뒤 다시 띄운다",
    ),
    delete: cell(
      "delete_row",
      "current",
      "러너를 닫고 등록을 은퇴시킨 뒤 줄을 지운다",
      "러너 해제 중에 지우면 러너를 닫고 줄을 지운다",
    ),
    resume: cell(
      "wait_then_start",
      "current",
      "해제가 끝난 뒤 새 러너로 시작한다",
      "러너 해제 중에 재개가 오면 해제가 끝난 뒤 시작한다",
    ),
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
