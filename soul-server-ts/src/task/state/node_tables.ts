import { stepNodeBarrier } from "./node_barrier_decision.js";
import {
  NODE_BARRIER_EVENTS,
  NODE_BARRIER_STATES,
  nodeBarrierMachine,
  type NodeBarrierState,
} from "./node_barrier_machine.js";
import { NODE_EXECUTION_PHASES } from "./node_execution_machine.js";
import {
  NODE_CALL_LABELS,
  NODE_CELL_LABELS,
  NODE_INTENT_LABELS,
  NODE_PHASE_LABELS,
  NODE_REASON_LABELS,
  NODE_REQUEST_DISPOSITION_LABELS,
  NODE_REQUEST_LABELS,
  NODE_ROUTE_LABELS,
  NODE_STOP_DISPOSITION_LABELS,
  NODE_TERMINATION_LABELS,
} from "./node_labels.js";
import { decideNodeRequest } from "./node_request_decision.js";
import {
  NODE_REQUEST_KINDS,
  NODE_REQUEST_TABLE,
  type NodeRequestBasis,
} from "./node_request_machine.js";
import { decideNodeResponse, decideNodeResponseCell } from "./node_response_decision.js";
import {
  NODE_CENTRAL_SESSIONS,
  NODE_REGISTRATION_MATCHES,
  NODE_RESPONSE_CALLS,
  NODE_RESPONSE_ROUTES,
  NODE_TERMINATION_PROJECTIONS,
  NODE_WIRE_REASONS,
  type NodeResponseCell,
  type NodeResponseFacts,
} from "./node_response_machine.js";

export const NODE_RESPONSE_COMBINATIONS = NODE_RESPONSE_CALLS.length
  * NODE_RESPONSE_ROUTES.length
  * NODE_WIRE_REASONS.length
  * NODE_REGISTRATION_MATCHES.length
  * NODE_TERMINATION_PROJECTIONS.length
  * NODE_CENTRAL_SESSIONS.length
  * 2;

/** 응답을 받은 칸의 입력 조합 전부다. */
export function* allNodeResponseFacts(): Generator<NodeResponseFacts> {
  for (const call of NODE_RESPONSE_CALLS) {
    for (const route of NODE_RESPONSE_ROUTES) {
      for (const reason of NODE_WIRE_REASONS) {
        for (const registration of NODE_REGISTRATION_MATCHES) {
          for (const termination of NODE_TERMINATION_PROJECTIONS) {
            for (const centralSession of NODE_CENTRAL_SESSIONS) {
              for (const retained of [false, true]) {
                yield { call, route, reason, registration, termination, centralSession, retained };
              }
            }
          }
        }
      }
    }
  }
}

export interface NodeResponseCellRow {
  route: string;
  call: string;
  reason: string;
  termination: string;
  cell: NodeResponseCell;
}

/** 조건에 드는 모든 입력이 같은 칸을 내는지 보고 그 칸을 돌려준다. 갈리면 던진다. */
function uniqueCell(
  label: string,
  include: (facts: NodeResponseFacts) => boolean,
): NodeResponseCell {
  const cells = new Set<NodeResponseCell>();
  for (const facts of allNodeResponseFacts()) {
    if (include(facts)) cells.add(decideNodeResponseCell(facts));
  }
  if (cells.size !== 1) throw new Error(`response cell is not unique: ${label}`);
  return [...cells][0]!;
}

/** 응답을 받은 칸 표다. 같은 칸으로 모이는 입력은 한 줄로 접고 접은 줄은 전수로 확인한다. */
export function nodeResponseCellRows(): NodeResponseCellRow[] {
  const rows: NodeResponseCellRow[] = [];
  // 종료 호출에서 정본의 종료 사건이 우리 종료이면 응답 길과 사유를 보지 않는다.
  const ourTermination = (facts: NodeResponseFacts): boolean =>
    facts.call === "termination" && facts.termination === "same";
  rows.push({
    route: "모든 응답 길",
    call: NODE_CALL_LABELS.termination,
    reason: "모든 사유",
    termination: NODE_TERMINATION_LABELS.same,
    cell: uniqueCell("our termination", ourTermination),
  });
  for (const route of NODE_RESPONSE_ROUTES) {
    if (route === "applied_false") continue;
    rows.push({
      route: NODE_ROUTE_LABELS[route],
      call: "모든 호출",
      reason: "모든 사유",
      termination: "모든 경우(종료에서 우리 종료와 같은 경우는 위 줄)",
      cell: uniqueCell(route, (facts) => facts.route === route && !ourTermination(facts)),
    });
  }
  for (const reason of NODE_WIRE_REASONS) {
    for (const group of ["termination", "other"] as const) {
      const inGroup = (facts: NodeResponseFacts): boolean =>
        facts.route === "applied_false"
        && facts.reason === reason
        && (group === "termination") === (facts.call === "termination");
      if (group === "termination") {
        for (const projection of NODE_TERMINATION_PROJECTIONS) {
          if (projection === "same") continue;
          rows.push({
            route: NODE_ROUTE_LABELS.applied_false,
            call: NODE_CALL_LABELS.termination,
            reason: NODE_REASON_LABELS[reason],
            termination: NODE_TERMINATION_LABELS[projection],
            cell: uniqueCell(`${reason}/${group}/${projection}`, (facts) =>
              inGroup(facts) && facts.termination === projection),
          });
        }
      } else {
        rows.push({
          route: NODE_ROUTE_LABELS.applied_false,
          call: "종료 밖의 여섯 호출",
          reason: NODE_REASON_LABELS[reason],
          termination: "해당 없음",
          cell: uniqueCell(`${reason}/${group}`, inGroup),
        });
      }
    }
  }
  return rows;
}

export interface NodeIntentRow {
  call: string;
  cell: string;
  intents: string;
}

const BASE_FACTS = {
  reason: "none",
  registration: "same",
  termination: "absent",
  centralSession: "present",
  retained: false,
} as const satisfies Partial<NodeResponseFacts>;

const CELL_ROUTE_REASON: Readonly<
  Record<Exclude<NodeResponseCell, "applied">, Pick<NodeResponseFacts, "route" | "reason">>
> = {
  retryable: { route: "no_response", reason: "none" },
  no_retry: { route: "applied_false", reason: "already_terminal" },
  permanent: { route: "dead_letter", reason: "none" },
  quarantine: { route: "transport_quarantine", reason: "none" },
};

function intentText(intents: readonly string[]): string {
  return intents.length === 0
    ? "없음"
    : intents.map((intent) => NODE_INTENT_LABELS[intent as keyof typeof NODE_INTENT_LABELS]).join(", ");
}

/** 호출 종류와 칸마다 기본 사실(우리 등록, 중앙 세션 있음, 정상 보유 아님)에서의 정리 의도다. */
export function nodeIntentRows(): NodeIntentRow[] {
  const rows: NodeIntentRow[] = [];
  for (const call of NODE_RESPONSE_CALLS) {
    for (const cell of Object.keys(CELL_ROUTE_REASON) as (keyof typeof CELL_ROUTE_REASON)[]) {
      const decision = decideNodeResponse({
        ...BASE_FACTS,
        ...CELL_ROUTE_REASON[cell],
        call,
      });
      if (decision.cell !== cell) throw new Error(`intent row cell drifted: ${call}/${cell}`);
      rows.push({
        call: NODE_CALL_LABELS[call],
        cell: NODE_CELL_LABELS[cell],
        intents: intentText(decision.intents),
      });
    }
  }
  return rows;
}

export interface NodeScenarioRow {
  scenario: string;
  cell: string;
  intents: string;
}

/** 정리 의도의 규칙마다 그 규칙이 드러나는 입력 하나씩이다. */
export function nodeScenarioRows(): NodeScenarioRow[] {
  const scenarios: { scenario: string; facts: NodeResponseFacts }[] = [
    {
      scenario: "종료가 dead letter로 영구 거절됨",
      facts: { ...BASE_FACTS, call: "termination", route: "dead_letter" },
    },
    {
      scenario: "종료가 사유 없이 거절됐고 정본의 종료 사건이 우리 종료",
      facts: { ...BASE_FACTS, call: "termination", route: "applied_false", termination: "same" },
    },
    {
      scenario: "종료가 사유 없이 거절됐고 다른 종료가 이미 있음",
      facts: { ...BASE_FACTS, call: "termination", route: "applied_false", termination: "different" },
    },
    {
      scenario: "종료가 사유 없이 거절됐고 정본에 종료 사건이 없음(옛 서버)",
      facts: { ...BASE_FACTS, call: "termination", route: "applied_false" },
    },
    {
      scenario: "실행 등록이 dead letter로 영구 거절됨",
      facts: { ...BASE_FACTS, call: "execution_registration", route: "dead_letter" },
    },
    {
      scenario: "실행 등록이 owner_node_changed로 영구 거절됨",
      facts: {
        ...BASE_FACTS,
        call: "execution_registration",
        route: "dead_letter",
        reason: "owner_node_changed",
      },
    },
    {
      scenario: "낡은 등록의 실행 등록이 영구 거절됨",
      facts: {
        ...BASE_FACTS,
        call: "execution_registration",
        route: "dead_letter",
        registration: "different",
      },
    },
    {
      scenario: "시동 복구 잇기가 owner_node_changed로 거절됨",
      facts: {
        ...BASE_FACTS,
        call: "startup_recovery_adopt",
        route: "applied_false",
        reason: "owner_node_changed",
      },
    },
    {
      scenario: "같은 거절인데 정상 보유 중",
      facts: {
        ...BASE_FACTS,
        call: "startup_recovery_adopt",
        route: "applied_false",
        reason: "owner_node_changed",
        retained: true,
      },
    },
    {
      scenario: "붙은 러너 잇기가 worktree_busy로 거절됨",
      facts: {
        ...BASE_FACTS,
        call: "attached_runner_adopt",
        route: "applied_false",
        reason: "worktree_busy",
      },
    },
    {
      scenario: "붙은 러너 잇기가 사유 없이 거절됨(옛 서버)",
      facts: { ...BASE_FACTS, call: "attached_runner_adopt", route: "applied_false" },
    },
    {
      scenario: "첫 메시지가 격리됨",
      facts: { ...BASE_FACTS, call: "first_message", route: "transport_quarantine" },
    },
    {
      scenario: "종료 거절 뒤 중앙 세션 없음이 확인됨",
      facts: {
        ...BASE_FACTS,
        call: "termination",
        route: "applied_false",
        reason: "already_terminal",
        centralSession: "absent",
      },
    },
    {
      scenario: "종료가 응답 없이 끝났는데 중앙 세션 없음이 확인됨",
      facts: {
        ...BASE_FACTS,
        call: "termination",
        route: "no_response",
        centralSession: "absent",
      },
    },
    {
      scenario: "종료가 dead letter로 영구 거절됐는데 정본의 종료 사건이 우리 종료",
      facts: { ...BASE_FACTS, call: "termination", route: "dead_letter", termination: "same" },
    },
    {
      scenario: "다시 될 수 있는 거절인데 중앙 세션 없음이 확인됨",
      facts: {
        ...BASE_FACTS,
        call: "resume",
        route: "applied_false",
        centralSession: "absent",
      },
    },
  ];
  return scenarios.map(({ scenario, facts }) => {
    const decision = decideNodeResponse(facts);
    return { scenario, cell: NODE_CELL_LABELS[decision.cell], intents: intentText(decision.intents) };
  });
}

export interface NodeRequestRow {
  phase: string;
  cells: string[];
}

const BASIS_LABELS: Readonly<Record<NodeRequestBasis, string>> = {
  design: "설계",
  current: "운영 확인",
};

/** 바깥 요청 칸 표다. 모든 상태와 요청 조합에 기계가 처분을 낸다. 없으면 던진다. */
export function nodeRequestRows(): NodeRequestRow[] {
  return NODE_EXECUTION_PHASES.map((phase) => ({
    phase: NODE_PHASE_LABELS[phase],
    cells: NODE_REQUEST_KINDS.map((request) => {
      const disposition = decideNodeRequest(phase, request);
      const basis = NODE_REQUEST_TABLE[phase][request].basis;
      return `${NODE_REQUEST_DISPOSITION_LABELS[disposition]} (${BASIS_LABELS[basis]})`;
    }),
  }));
}

export interface NodeRequestTestRow {
  phase: string;
  request: string;
  test: string;
}

/** 바깥 요청 칸마다 그 칸을 운영 진입 함수로 확인하는 경계 시험이다. */
export function nodeRequestTestRows(): NodeRequestTestRow[] {
  return NODE_EXECUTION_PHASES.flatMap((phase) =>
    NODE_REQUEST_KINDS.map((request) => ({
      phase: NODE_PHASE_LABELS[phase],
      request: NODE_REQUEST_LABELS[request],
      test: NODE_REQUEST_TABLE[phase][request].test,
    })));
}

export interface NodeBarrierTransitionRow {
  from: NodeBarrierState;
  event: string;
  to: NodeBarrierState;
  stop: string;
  description: string;
}

/** 장벽 기계가 정의한 전이 전부와 멈춤 처분이다. */
export function nodeBarrierTransitionRows(): NodeBarrierTransitionRow[] {
  const rows: NodeBarrierTransitionRow[] = [];
  for (const from of NODE_BARRIER_STATES) {
    for (const event of NODE_BARRIER_EVENTS) {
      const defined = nodeBarrierMachine.root.states[from]?.on[event];
      if (!defined || defined.length === 0) continue;
      const step = stepNodeBarrier(from, event);
      rows.push({
        from,
        event,
        to: step.state,
        stop: step.stop === null ? "-" : NODE_STOP_DISPOSITION_LABELS[step.stop],
        description: defined[0]?.description ?? "",
      });
    }
  }
  return rows;
}

