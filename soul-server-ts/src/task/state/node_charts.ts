import { toMermaid, type ChartSpec } from "@soulstream/statechart";

import { decideNodeStopRequest } from "./node_barrier_decision.js";
import { nodeBarrierMachine, NODE_BARRIER_STATES } from "./node_barrier_machine.js";
import { NODE_EXECUTION_PHASES, nodeExecutionMachine } from "./node_execution_machine.js";
import { nodeGuessCells, nodeGuessPhaseLabel } from "./node_guess_cells.js";
import {
  NODE_BARRIER_KIND_LABELS,
  NODE_BARRIER_STATE_LABELS,
  NODE_CELL_LABELS,
  NODE_PHASE_LABELS,
  NODE_REQUEST_LABELS,
  NODE_STOP_DISPOSITION_LABELS,
} from "./node_labels.js";
import { NODE_REQUEST_KINDS, nodeRequestMachine } from "./node_request_machine.js";
import { decideNodeResponse } from "./node_response_decision.js";
import { nodeResponseMachine } from "./node_response_machine.js";
import {
  NODE_RESPONSE_COMBINATIONS,
  allNodeResponseFacts,
  nodeBarrierTransitionRows,
  nodeIntentRows,
  nodeRequestRows,
  nodeResponseCellRows,
  nodeScenarioRows,
} from "./node_tables.js";

function projectionRules(): { target: string; description: string }[] {
  const transitions = nodeExecutionMachine.root.states.project?.on.PROJECT;
  if (!transitions) throw new Error("node execution machine has no PROJECT transitions");
  return transitions.map((entry) => {
    const target = entry.target?.[0]?.key;
    if (target === undefined || entry.description === undefined) {
      throw new Error("node execution projection rule lacks target or description");
    }
    return { target, description: entry.description };
  });
}

interface ChartPlan {
  id: string;
  title: string;
  note: string;
  root: Parameters<typeof toMermaid>[0];
  spec: ChartSpec;
}

function chartPlans(): ChartPlan[] {
  return [
    {
      id: "01-execution-phase",
      title: "실행 상태 투영",
      note: "위에서부터 처음 맞는 상태로 간다.",
      root: nodeExecutionMachine.root,
      spec: { include: ["nodeExecution"] },
    },
    {
      id: "02-response-cell",
      title: "응답을 받은 칸",
      note: "응답 길과 사유와 정본 투영으로 위에서부터 처음 맞는 칸으로 간다.",
      root: nodeResponseMachine.root,
      spec: { include: ["nodeResponse"] },
    },
    {
      id: "03-barrier",
      title: "장벽 직렬화",
      note: "넘기기 장벽을 기다린 멈춤은 장벽이 풀리면 멈춤 장벽으로 올라 보통 멈춤 길을 탄다. 장벽을 지우고 돌아가는 화살표는 없다.",
      root: nodeBarrierMachine.root,
      spec: { include: ["nodeBarrier"] },
    },
  ];
}

function validateDescriptions(): void {
  const walk = (node: typeof nodeBarrierMachine.root): void => {
    for (const transitions of Object.values(node.on)) {
      for (const transition of transitions) {
        if (transition.description === undefined) {
          throw new Error(`Missing transition description: ${node.id} ${transition.eventType}`);
        }
      }
    }
    Object.values(node.states).forEach(walk);
  };
  for (const machine of [
    nodeExecutionMachine,
    nodeResponseMachine,
    nodeBarrierMachine,
    nodeRequestMachine,
  ]) {
    walk(machine.root as typeof nodeBarrierMachine.root);
  }
}

const cellsRow = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;

export function generateNodeStateDocument() {
  validateDescriptions();
  const rules = projectionRules();
  const responseRows = nodeResponseCellRows();
  const intentRows = nodeIntentRows();
  const scenarioRows = nodeScenarioRows();
  const requestRows = nodeRequestRows();
  const barrierRows = nodeBarrierTransitionRows();
  const guessCells = nodeGuessCells();
  const charts = chartPlans().map((plan) => ({
    ...plan,
    ...toMermaid(plan.root, plan.spec),
  }));
  for (const chart of charts) {
    if (chart.warnings.length > 0) {
      throw new Error(`${chart.id}: ${chart.warnings.join(", ")}`);
    }
  }
  // 모든 입력 조합에 칸이 있는지 문서를 만들 때 한 번 더 센다.
  let responseCount = 0;
  for (const facts of allNodeResponseFacts()) {
    decideNodeResponse(facts);
    responseCount += 1;
  }

  const lines: string[] = [
    "# 노드 상태",
    "",
    "이 문서는 `soul-server-ts/src/task/state/`의 XState 정의에서 만든 생성물이다. 정의를 고치면 아래 명령으로 다시 만든다. 리포의 파일과 생성 결과가 다르면 시험이 실패한다.",
    "",
    "멈춤 단위(카드 #1266 U4)가 장벽 직렬화 판정과 실행 상태 투영을 멈춤과 삭제 길에 이었다. 응답을 받은 칸은 종료 경로 단위가, 지시 경로는 지시 경로 단위가 운영 코드에 잇는다. 턴 고리 전체를 접지 않는다.",
    "",
    "## 실행 상태",
    "",
    "Task의 `status`, `runner`, `executionRegistration`, `runnerTerminalFact`, `runnerRetainedForDetachedWork`, `runnerReleaseClaim`, `hydratedFromDb`, `terminationEventRecorded`, `runnerIsOfflineReplay`, `executionActivation`, `executionPromise`에 흩어진 사실을 아래 상태 하나로 투영한다. 판정 순서는 표의 순서다. 응답을 기다리는 중인 상태(등록 대기, 잇기 대기)는 Task 필드에 보이지 않아 각각 `registering`, `replaying`으로 접힌다. 멈춤 장벽과 보유 종류는 Task에 표지가 없어 호출자가 입력으로 준다.",
    "",
    "| 순서 | 상태 | 뜻 | 조건 |",
    "| :-- | :-- | :-- | :-- |",
  ];
  rules.forEach((rule, index) => {
    lines.push(
      cellsRow([
        String(index + 1),
        `\`${rule.target}\``,
        NODE_PHASE_LABELS[rule.target as keyof typeof NODE_PHASE_LABELS],
        rule.description,
      ]),
    );
  });
  lines.push(
    "",
    "## 응답을 받은 칸",
    "",
    "서버 응답이 노드에 닿는 길은 다섯이고 호출은 일곱이다. 적용 응답(applied=true)은 이 칸을 거치지 않는다. 입력은 호출 종류, 응답 길, 와이어 사유, 거절된 등록이 지금 등록과 같은가, 정본 투영의 termination_event_id와 우리 종료의 관계, 중앙 세션 유무, 정상 보유 여부다. 출력은 적용됨이나 칸 넷 가운데 하나와 그 칸이 할 정리의 의도 목록이다.",
    "",
    `입력 조합 ${NODE_RESPONSE_COMBINATIONS}가지 모두에 칸이 있으며 빈 칸은 없다. 사유 분류는 \`task/state/node_adopt_rejection.ts\`가 정본이고 already_terminal, session_missing, owner_node_changed가 다시 될 까닭 없는 사유다.`,
    "",
    "### 칸 결정표",
    "",
    "같은 칸으로 모이는 입력은 한 줄로 접었다. 접은 줄은 모든 조합이 같은 칸을 내는지 문서를 만들 때 확인한다.",
    "",
    "| 응답 길 | 호출 | 사유 | 정본의 종료 사건 | 칸 |",
    "| :-- | :-- | :-- | :-- | :-- |",
  );
  for (const row of responseRows) {
    lines.push(
      cellsRow([row.route, row.call, row.reason, row.termination, NODE_CELL_LABELS[row.cell]]),
    );
  }
  lines.push(
    "",
    "### 정리 의도의 규칙",
    "",
    "- 영구 거절과 격리의 정리는 거절된 그 등록과 그 실행 명령에만 건다. 중앙 상태를 오류로 덮는 의도는 이 둘의 종료 밖 호출에서만 나온다.",
    "- owner_node_changed나 낡은 등록의 거절은 새 실행의 중앙 상태를 오류로 덮는 의도를 내지 않는다. 낡은 등록의 거절은 러너 거둠도 내지 않는다.",
    "- 종료의 영구 거절, 격리, 다시 될 까닭이 없는 종료 거절은 완료 정산 미결 닫기와 거절된 그 러너 등록 은퇴를 함께 내고 같은 종료를 다시 올리는 의도를 내지 않는다.",
    "- 중앙 세션 없음이 확인되면 로컬 소유 정리를 낸다. 받아 줄 세션이 없으므로 다시 시도하는 의도는 함께 내지 않는다.",
    "- 사유 없는 거절은 옛 서버 호환으로 다시 될 수 있는 거절이다. 단 종료 거절에 사유가 없을 때 정본의 종료 사건이 우리 종료와 같으면 적용됨, 다른 종료가 이미 있으면 already_terminal 사유의 다시 될 까닭이 없는 거절이다.",
    "- 정상 보유 중이면 러너 거둠 의도를 내지 않는다.",
    "",
    "### 호출과 칸마다 기본 정리 의도",
    "",
    "거절된 등록이 우리 등록이고 중앙 세션이 있고 정상 보유가 아닐 때다. 다시 될 까닭이 없는 거절의 사유는 already_terminal로 두었다.",
    "",
    "| 호출 | 칸 | 정리 의도 |",
    "| :-- | :-- | :-- |",
  );
  for (const row of intentRows) lines.push(cellsRow([row.call, row.cell, row.intents]));
  lines.push(
    "",
    "### 규칙이 드러나는 입력",
    "",
    "| 입력 | 칸 | 정리 의도 |",
    "| :-- | :-- | :-- |",
  );
  for (const row of scenarioRows) lines.push(cellsRow([row.scenario, row.cell, row.intents]));
  lines.push(
    "",
    "## 바깥 요청 칸",
    "",
    "실행 상태마다 멈춤, 지시, 삭제, 재개 요청의 처분이다. 괄호는 칸의 근거다. 설계는 설계가 정한 처분, 지금 동작은 지금 코드를 그대로 적은 것, 확인 못 함은 옛 결정표에서 확인 못 함이었거나 설계가 정하지 않아 뒤 단위가 코드로 닫을 칸이다. 러너 없이 올린 활성 task의 멈춤과 삭제는 SESSION_NOT_RUNNING 답이나 조용한 삭제가 아니라 종료 기록을 만드는 처분이다.",
    "",
    `모든 실행 상태 ${NODE_EXECUTION_PHASES.length}개와 요청 ${NODE_REQUEST_KINDS.length}개의 조합에 처분이 있으며 빈 칸은 없다.`,
    "",
    cellsRow(["실행 상태", ...NODE_REQUEST_KINDS.map((request) => NODE_REQUEST_LABELS[request])]),
    cellsRow([":--", ...NODE_REQUEST_KINDS.map(() => ":--")]),
  );
  for (const row of requestRows) lines.push(cellsRow([row.phase, ...row.cells]));
  lines.push(
    "",
    "## 장벽 직렬화",
    "",
    "장벽 종류는 실행 시작, 지시 넘기기, 멈춤이다. 멈춤 요청이 앞선 장벽을 만나면 곧바로 멈춤, 넘기기가 끝난 뒤 보통 멈춤 길로, 이미 멈추는 중 가운데 하나를 받는다. 넘기기 장벽을 기다린 멈춤이 아무 일 없이 돌아가는 처분은 없다.",
    "",
    "| 앞선 장벽 | 멈춤 요청의 처분 |",
    "| :-- | :-- |",
  );
  for (const state of ["none", "execution_start", "intervention_handoff", "stop"] as const) {
    lines.push(
      cellsRow([
        NODE_BARRIER_STATE_LABELS[state],
        NODE_STOP_DISPOSITION_LABELS[decideNodeStopRequest(state)],
      ]),
    );
  }
  lines.push(
    "",
    `장벽 종류: ${(Object.keys(NODE_BARRIER_KIND_LABELS) as (keyof typeof NODE_BARRIER_KIND_LABELS)[]).map((kind) => NODE_BARRIER_KIND_LABELS[kind]).join(", ")}.`,
    "",
    "| 장벽 | 사건 | 다음 장벽 | 멈춤 처분 | 뜻 |",
    "| :-- | :-- | :-- | :-- | :-- |",
  );
  for (const row of barrierRows) {
    lines.push(
      cellsRow([
        NODE_BARRIER_STATE_LABELS[row.from],
        row.event,
        NODE_BARRIER_STATE_LABELS[row.to],
        row.stop,
        row.description,
      ]),
    );
  }
  lines.push(
    "",
    "## 옛 결정표의 짐작 20칸",
    "",
    "옛 노드 결정표(카드 #1218의 `charts/node-decision-table.md`)에서 코드를 끝까지 따라가지 못해 모형이 짐작으로 둔 20칸이다. 칸마다 지금 판정과 그 칸을 운영 코드로 닫을 단위를 적었다. 닫을 단위는 종료 경로, 지시 경로, 멈춤 가운데 하나다. 지금 판정은 이 문서의 정의가 내는 값이며 운영 코드의 동작이 이와 같다는 뜻이 아니다. 운영 코드로 닫는 일이 그 확인이다.",
    "",
    "| 번호 | 옛 표 | 옛 실행 상태 | 기다리는 지시 | 노드가 보는 러너 | 투영 상태 | 지금 판정 | 닫을 단위 |",
    "| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |",
  );
  for (const cell of guessCells) {
    lines.push(
      cellsRow([
        String(cell.no),
        cell.oldTable,
        cell.state,
        cell.pending,
        cell.runner,
        nodeGuessPhaseLabel(cell),
        cell.current,
        cell.unit,
      ]),
    );
  }
  lines.push("", "## 그림", "");
  for (const chart of charts) {
    lines.push(
      `### ${chart.title}`,
      "",
      "```mermaid",
      chart.mermaid,
      "```",
      "",
      `${chart.note} 전이 화살표 ${chart.edgeCount}개.`,
      "",
    );
  }
  lines.push(
    "## 다시 만들기",
    "",
    "```bash",
    "corepack pnpm@10.32.1 --dir soul-server-ts exec tsx scripts/node-state-charts.ts",
    "```",
    "",
    `응답을 받은 칸은 입력 ${responseCount}가지, 바깥 요청 칸은 ${requestRows.length * NODE_REQUEST_KINDS.length}칸, 짐작 칸은 ${guessCells.length}칸이다.`,
    "",
  );
  return {
    markdown: lines.join("\n"),
    charts,
    responseRows,
    intentRows,
    scenarioRows,
    requestRows,
    barrierRows,
    guessCells,
    responseCount,
  };
}

