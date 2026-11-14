import { decideNodeStopRequest } from "./node_barrier_decision.js";
import type { NodeExecutionPhase } from "./node_execution_machine.js";
import { decideNodeRequest } from "./node_request_decision.js";
import { NODE_REQUEST_TABLE, type NodeRequestKind } from "./node_request_machine.js";
import {
  NODE_PHASE_LABELS,
  NODE_REQUEST_DISPOSITION_LABELS,
  NODE_REQUEST_LABELS,
  NODE_STOP_DISPOSITION_LABELS,
} from "./node_labels.js";

type PendingName = "없음" | "쌓여 있음" | "러너에 넘기고 결과를 기다림";
type RunnerName = "러너가 살아 있음" | "러너는 끝났거나 죽었고 기록이 남음";

/**
 * 옛 짐작을 닫은 자리다. `request`는 바깥 요청 칸, `barrier`는 장벽 직렬화 판정,
 * `order`는 쌓인 지시 다시 띄우기와 복구 훑기의 순서다. 셋 다 경계 시험으로 닫았다.
 */
export type NodeGuessClosure =
  | { kind: "request"; phase: NodeExecutionPhase; request: NodeRequestKind }
  | { kind: "barrier" }
  | { kind: "order" };

interface GuessSpec {
  oldTable: "C1" | "C2" | "T3";
  state: string;
  pending: PendingName;
  runner: RunnerName;
  /** 옛 결정표가 Task 필드로 접었던 실행 상태다. */
  oldPhase: NodeExecutionPhase;
  closure: NodeGuessClosure;
  /** 운영 코드에서 본 것이다. 옛 짐작과 다른 점을 적는다. */
  observed: string;
  /** 닫은 경계 시험이다. 칸 시험이면 비워 두고 바깥 요청 표의 시험을 쓴다. */
  tests?: readonly string[];
}

export interface NodeGuessCell extends Omit<GuessSpec, "tests"> {
  no: number;
  /** 닫은 자리가 내는 처분이다. */
  verdict: string;
  /** 닫은 경계 시험의 이름이다. `NODE_REQUEST_BOUNDARY_TEST_FILES`에 있다. */
  tests: readonly string[];
}

const LIVE: RunnerName = "러너가 살아 있음";
const DEAD: RunnerName = "러너는 끝났거나 죽었고 기록이 남음";
const NONE: PendingName = "없음";
const QUEUED: PendingName = "쌓여 있음";
const HANDOFF: PendingName = "러너에 넘기고 결과를 기다림";
const REPLAY = "러너의 남은 기록을 서버에 올리는 중";
const ADOPT = "살아 있는 러너를 잇겠다고 알리고 응답을 기다림";
const REGISTER = "실행 등록을 올리고 응답을 기다림";

const REPLAY_RUNNER =
  "끝난 러너의 기록은 살아 있는 러너를 먼저 끝내고 오프라인으로 다시 읽는다(runner_recovery_disposition.ts). 그래서 러너가 살아 있든 죽었든 같은 칸이다";
const ADOPT_PHASE =
  "잇기는 중앙 줄의 실행 등록을 가진 채 러너를 붙여 기다리므로 replaying이 아니라 running으로 투영된다";
const ORDER_OBSERVED =
  "노드 시작 때는 첫 복구 훑기가 먼저다(worker_startup.ts, adapter.ts). 중앙에 종료가 적힌 세션의 남은 등록은 재생 없이 은퇴시키고, 쌓인 지시는 그 뒤에 들어와 한 번 띄운다. 쌓인 지시가 먼저 띄우면 훑기는 실행을 쥔 세션을 건너뛰고 등록을 다음 훑기로 남긴다";
const ORDER_TESTS = [
  "노드 시작 때 쌓인 지시는 복구 훑기가 끝난 뒤 한 번 들어간다",
  "쌓인 지시가 먼저 다시 띄우면 복구 훑기는 그 세션을 건너뛰고 지시는 한 번 들어간다",
] as const;

const request = (phase: NodeExecutionPhase, kind: NodeRequestKind): NodeGuessClosure => ({
  kind: "request",
  phase,
  request: kind,
});

function spec(
  oldTable: GuessSpec["oldTable"],
  state: string,
  pending: PendingName,
  runner: RunnerName,
  oldPhase: NodeExecutionPhase,
  closure: NodeGuessClosure,
  observed: string,
  tests?: readonly string[],
): GuessSpec {
  return { oldTable, state, pending, runner, oldPhase, closure, observed, ...(tests ? { tests } : {}) };
}

/**
 * 옛 노드 결정표(`ref/card1218/charts/node-decision-table.md`)에서 「확인 못 함」이던 20칸이다.
 * 카드 #1266 U5b가 칸마다 그 상태를 운영 코드로 만들고 운영 진입 함수로 요청을 보내 닫았다.
 * 넘기기 중의 지시는 러너가 살아 있을 때만 있으므로 그 조합은 뺀다.
 */
const GUESS_SPECS: readonly GuessSpec[] = [
  spec("C1", REPLAY, NONE, LIVE, "replaying", request("replaying", "intervene"), REPLAY_RUNNER),
  spec("C1", REPLAY, NONE, DEAD, "replaying", request("replaying", "intervene"),
    "재생 손잡이에 넣어 결과를 모름으로 잃던 것을 대기 줄에 쌓도록 고쳤다"),
  spec("C1", REPLAY, QUEUED, LIVE, "replaying", request("replaying", "intervene"), REPLAY_RUNNER),
  spec("C1", REPLAY, QUEUED, DEAD, "replaying", request("replaying", "intervene"),
    "앞서 쌓인 지시 뒤에 쌓고 재생이 끝난 뒤 함께 다시 띄운다"),
  spec("C1", REPLAY, HANDOFF, LIVE, "replaying", request("replaying", "intervene"),
    "앞선 넘기기 뒤에 차례로 쌓는다. 러너는 재생 전에 끝난다"),
  spec("C1", ADOPT, NONE, LIVE, "replaying", request("running", "intervene"), ADOPT_PHASE,
    ["잇기 응답을 기다리는 중에 지시가 오면 이은 러너의 엔진에 넘긴다"]),
  spec("C1", ADOPT, QUEUED, LIVE, "replaying", request("running", "intervene"), ADOPT_PHASE,
    ["잇기 응답을 기다리는 중에 지시가 오면 이은 러너의 엔진에 넘긴다"]),
  spec("C2", REGISTER, NONE, LIVE, "registering", request("registering", "stop"),
    "등록 응답이 먼저 닿아 running으로 투영해도 뒤이은 종료 응답이 멈춤으로 닫는다"),
  spec("C2", REGISTER, NONE, DEAD, "registering", request("registering", "stop"),
    "죽은 러너는 멈춤 명령이 실패해 멈춤 확인 실패로 종료를 올리고 거짓을 돌려준다. 종료는 한 번이다"),
  spec("C2", REGISTER, QUEUED, LIVE, "registering", request("registering", "stop"),
    "멈춤 길(cancelRunningTask)은 대기 줄을 보지 않아 쌓인 지시가 없을 때와 같은 칸이다"),
  spec("C2", REGISTER, QUEUED, DEAD, "registering", request("registering", "stop"),
    "멈춤 길은 대기 줄을 보지 않아 9번과 같은 칸이다"),
  spec("C2", REPLAY, NONE, LIVE, "replaying", request("replaying", "stop"), REPLAY_RUNNER),
  spec("C2", REPLAY, NONE, DEAD, "replaying", request("replaying", "stop"),
    "재생은 멈춤 마무리를 기다린 뒤 끝나 종료를 다시 올리지 않는다"),
  spec("C2", REPLAY, QUEUED, LIVE, "replaying", request("replaying", "stop"), REPLAY_RUNNER),
  spec("C2", REPLAY, QUEUED, DEAD, "replaying", request("replaying", "stop"),
    "멈춤 길은 대기 줄을 보지 않아 13번과 같은 칸이다"),
  spec("C2", REPLAY, HANDOFF, LIVE, "replaying", { kind: "barrier" },
    "재생 손잡이로의 넘기기가 끝난 뒤 보통 멈춤 길로 멈춘다",
    ["남은 기록을 올리는 중 넘기기를 기다리던 멈춤은 넘기기가 끝난 뒤 멈춤으로 닫힌다"]),
  spec("C2", ADOPT, NONE, LIVE, "replaying", request("running", "stop"), ADOPT_PHASE,
    ["잇기 응답을 기다리는 중에 멈춤이 오면 멈춤 하나로 닫힌다"]),
  spec("C2", ADOPT, QUEUED, LIVE, "replaying", request("running", "stop"), ADOPT_PHASE,
    ["잇기 응답을 기다리는 중에 멈춤이 오면 멈춤 하나로 닫힌다"]),
  spec("T3", "주인 없음", QUEUED, LIVE, "idle", { kind: "order" },
    ORDER_OBSERVED, ORDER_TESTS),
  spec("T3", "주인 없음", QUEUED, DEAD, "idle", { kind: "order" },
    ORDER_OBSERVED, ORDER_TESTS),
];

const ORDER_VERDICT =
  "노드 시작 때는 복구 훑기가 끝난 뒤 쌓인 지시를 다시 띄운다. 쌓인 지시가 먼저 띄우면 복구 훑기는 실행을 쥔 세션을 건너뛴다. 어느 순서에서도 지시는 한 번 들어간다";

function verdictOf(closure: NodeGuessClosure): string {
  switch (closure.kind) {
    case "request":
      return NODE_REQUEST_DISPOSITION_LABELS[decideNodeRequest(closure.phase, closure.request)];
    case "barrier":
      return NODE_STOP_DISPOSITION_LABELS[decideNodeStopRequest("intervention_handoff")];
    case "order":
      return ORDER_VERDICT;
  }
}

function testsOf(item: GuessSpec): readonly string[] {
  if (item.tests) return item.tests;
  if (item.closure.kind !== "request") {
    throw new Error(`guess cell closure without a boundary test: ${item.state}`);
  }
  return [NODE_REQUEST_TABLE[item.closure.phase][item.closure.request].test];
}

export function nodeGuessCells(): NodeGuessCell[] {
  return GUESS_SPECS.map((item, index) => ({
    oldTable: item.oldTable,
    state: item.state,
    pending: item.pending,
    runner: item.runner,
    oldPhase: item.oldPhase,
    closure: item.closure,
    observed: item.observed,
    no: index + 1,
    verdict: verdictOf(item.closure),
    tests: testsOf(item),
  }));
}

/** 닫은 자리를 사람이 읽는 말로 적는다. */
export function nodeGuessClosureLabel(cell: NodeGuessCell): string {
  switch (cell.closure.kind) {
    case "request":
      return `${NODE_PHASE_LABELS[cell.closure.phase]}의 ${NODE_REQUEST_LABELS[cell.closure.request]} 칸`;
    case "barrier":
      return "장벽 직렬화(넘기기를 기다리는 멈춤)";
    case "order":
      return "쌓인 지시 다시 띄우기와 복구 훑기의 순서";
  }
}

export function nodeGuessPhaseLabel(cell: NodeGuessCell): string {
  return NODE_PHASE_LABELS[cell.oldPhase];
}
