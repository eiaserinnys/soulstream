import { decideNodeStopRequest } from "./node_barrier_decision.js";
import type { NodeExecutionPhase } from "./node_execution_machine.js";
import { decideNodeRequest } from "./node_request_decision.js";
import type { NodeRequestKind } from "./node_request_machine.js";
import {
  NODE_PHASE_LABELS,
  NODE_REQUEST_DISPOSITION_LABELS,
  NODE_STOP_DISPOSITION_LABELS,
} from "./node_labels.js";

/** 짐작 칸을 코드로 닫을 뒤 단위다. */
export type NodeGuessUnit = "종료 경로" | "지시 경로" | "멈춤";

type PendingName = "없음" | "쌓여 있음" | "러너에 넘기고 결과를 기다림";
type RunnerName = "러너가 살아 있음" | "러너는 끝났거나 죽었고 기록이 남음";

interface GuessSpec {
  oldTable: "C1" | "C2" | "T3";
  state: string;
  pending: PendingName;
  runner: RunnerName;
  phase: NodeExecutionPhase;
  /** 옛 표의 칸이 받는 사건이다. T3는 요청이 아니라 노드가 스스로 보는 쌓인 지시다. */
  request: NodeRequestKind | "queued_scan";
  unit: NodeGuessUnit;
}

export interface NodeGuessCell extends GuessSpec {
  no: number;
  /** 지금 판정. 칸을 낸 정의에서 읽은 처분이다. */
  current: string;
}

const LIVE: RunnerName = "러너가 살아 있음";
const DEAD: RunnerName = "러너는 끝났거나 죽었고 기록이 남음";
const NONE: PendingName = "없음";
const QUEUED: PendingName = "쌓여 있음";
const HANDOFF: PendingName = "러너에 넘기고 결과를 기다림";
const REPLAY = "러너의 남은 기록을 서버에 올리는 중";
const ADOPT = "살아 있는 러너를 잇겠다고 알리고 응답을 기다림";
const REGISTER = "실행 등록을 올리고 응답을 기다림";

function spec(
  oldTable: GuessSpec["oldTable"],
  state: string,
  pending: PendingName,
  runner: RunnerName,
  phase: NodeExecutionPhase,
  request: GuessSpec["request"],
  unit: NodeGuessUnit,
): GuessSpec {
  return { oldTable, state, pending, runner, phase, request, unit };
}

/**
 * 옛 노드 결정표(`ref/card1218/charts/node-decision-table.md`)에서 「확인 못 함」이던 20칸이다.
 * 지시가 온다 7칸, 멈춤 요청이 온다 11칸, 쌓인 지시가 있다 2칸이다.
 * 넘기기 중의 지시는 러너가 살아 있을 때만 있으므로 그 조합은 뺀다.
 * 실행 등록과 잇기를 기다리는 상태는 Task 필드로 보이지 않아 투영에서는
 * 각각 `registering`과 `replaying`으로 접힌다.
 */
const GUESS_SPECS: readonly GuessSpec[] = [
  spec("C1", REPLAY, NONE, LIVE, "replaying", "intervene", "지시 경로"),
  spec("C1", REPLAY, NONE, DEAD, "replaying", "intervene", "지시 경로"),
  spec("C1", REPLAY, QUEUED, LIVE, "replaying", "intervene", "지시 경로"),
  spec("C1", REPLAY, QUEUED, DEAD, "replaying", "intervene", "지시 경로"),
  spec("C1", REPLAY, HANDOFF, LIVE, "replaying", "intervene", "지시 경로"),
  spec("C1", ADOPT, NONE, LIVE, "replaying", "intervene", "지시 경로"),
  spec("C1", ADOPT, QUEUED, LIVE, "replaying", "intervene", "지시 경로"),
  spec("C2", REGISTER, NONE, LIVE, "registering", "stop", "종료 경로"),
  spec("C2", REGISTER, NONE, DEAD, "registering", "stop", "종료 경로"),
  spec("C2", REGISTER, QUEUED, LIVE, "registering", "stop", "종료 경로"),
  spec("C2", REGISTER, QUEUED, DEAD, "registering", "stop", "종료 경로"),
  spec("C2", REPLAY, NONE, LIVE, "replaying", "stop", "종료 경로"),
  spec("C2", REPLAY, NONE, DEAD, "replaying", "stop", "종료 경로"),
  spec("C2", REPLAY, QUEUED, LIVE, "replaying", "stop", "종료 경로"),
  spec("C2", REPLAY, QUEUED, DEAD, "replaying", "stop", "종료 경로"),
  spec("C2", REPLAY, HANDOFF, LIVE, "replaying", "stop", "멈춤"),
  spec("C2", ADOPT, NONE, LIVE, "replaying", "stop", "종료 경로"),
  spec("C2", ADOPT, QUEUED, LIVE, "replaying", "stop", "종료 경로"),
  spec("T3", "주인 없음", QUEUED, LIVE, "idle", "queued_scan", "지시 경로"),
  spec("T3", "주인 없음", QUEUED, DEAD, "idle", "queued_scan", "지시 경로"),
];

function currentVerdict(item: GuessSpec): string {
  if (item.request === "queued_scan") {
    return "다시 띄우기와 복구 훑기 가운데 어느 쪽이 먼저인지는 정의가 정하지 않는다. 처분: "
      + NODE_REQUEST_DISPOSITION_LABELS[decideNodeRequest(item.phase, "intervene")]
      + "(남은 러너 등록의 복구 훑기와 겹침)";
  }
  if (item.request === "stop" && item.pending === HANDOFF) {
    return NODE_STOP_DISPOSITION_LABELS[decideNodeStopRequest("intervention_handoff")];
  }
  return NODE_REQUEST_DISPOSITION_LABELS[decideNodeRequest(item.phase, item.request)];
}

export function nodeGuessCells(): NodeGuessCell[] {
  return GUESS_SPECS.map((item, index) => ({
    ...item,
    no: index + 1,
    current: currentVerdict(item),
  }));
}

export function nodeGuessPhaseLabel(cell: NodeGuessCell): string {
  return NODE_PHASE_LABELS[cell.phase];
}
