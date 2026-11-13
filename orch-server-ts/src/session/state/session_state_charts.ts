import { toMermaid, type ChartSpec } from "../../statechart/mermaid.js";
import {
  SESSION_COMMAND_LABELS,
  SESSION_COMMAND_RULES,
  SESSION_FACT_LABELS,
  SESSION_REASON_LABELS,
  SESSION_REVIEW_LABELS,
  SESSION_STATUS_LABELS,
  factValueLabel,
  stateValueLabel,
} from "./session_decision_labels.js";
import { SESSION_COMMANDS, type SessionDecisionCommand } from "./session_decision_facts.js";
import { sessionDecisionMachine } from "./session_decision_machine.js";
import {
  checkSessionPromises,
  type SessionPromiseResult,
} from "./session_machine_promises.js";
import {
  sessionDecisionTable,
  type SessionDecisionRow,
} from "./session_decision_table.js";
import {
  SESSION_SQL_PREDICATES,
  type SessionClassifierName,
} from "./session_state_classifiers.js";
import {
  SESSION_DIRECT_WRITES,
  SESSION_SQL_WRITERS,
  SESSION_STATUS_LITERAL_ALLOWLIST,
  SESSION_STATUS_LITERAL_COMPARE_PATTERN,
  SESSION_STATUS_LITERAL_LIST_PATTERN,
  SESSION_STATUS_LITERAL_SQL_PATTERN,
} from "./session_state_writes.js";
import {
  SESSION_REVIEW_STATES,
  SESSION_STATUS_LEAVES,
  stateValueToColumns,
  type SessionStateValue,
} from "./session_state_value.js";

const SCIENTIFIC_BASE_COMMIT = "4df27484";

interface ChartPlan {
  id: string;
  title: string;
  spec: ChartSpec;
  events: SessionDecisionCommand[];
}

const ALL_COMMANDS = SESSION_COMMANDS;

const plans: ChartPlan[] = [
  {
    id: "01-status",
    title: "세션 상태",
    events: [
      "register",
      "execution_registration",
      "running_transition",
      "terminal_transition",
      "node_disconnect_cleanup",
      "startup_reconcile_missing",
      "startup_reconcile_restore",
      "session_update_status",
      "delete",
    ],
    spec: { include: ["sessionStatus"] },
  },
  {
    id: "02-termination",
    title: "종료 리비전 기록",
    events: [
      "execution_registration",
      "running_transition",
      "terminal_transition",
      "node_disconnect_cleanup",
      "startup_reconcile_missing",
      "startup_reconcile_restore",
      "delete",
    ],
    spec: { include: ["sessionTermination"] },
  },
  {
    id: "03-review",
    title: "검수 상태",
    events: [
      "register",
      "execution_registration",
      "running_transition",
      "terminal_transition",
      "node_disconnect_cleanup",
      "startup_reconcile_missing",
      "startup_reconcile_restore",
      "acknowledge_review",
      "delete",
    ],
    spec: { include: ["sessionReview"] },
  },
  {
    id: "04-reservation",
    title: "한도 재개 예약",
    events: [],
    spec: { include: ["sessionReservation"] },
  },
];

function validateDescriptions(node: any): void {
  for (const transitions of Object.values(node.on ?? {})) {
    for (const transition of transitions as any[]) {
      if (!transition.description || !transition.meta?.label) {
        throw new Error(`전이 설명이 없다: ${node.id} ${transition.eventType}`);
      }
    }
  }
  for (const child of Object.values(node.states ?? {})) {
    validateDescriptions(child);
  }
}

const classifierLabels: Record<SessionClassifierName, string> = {
  isSessionRunning: "실행 중인가",
  isSessionActive: "초기화 중이거나 실행 중인가",
  isSessionTerminal: "종료 상태인가",
  isDisconnectedInterrupted: "종료 리비전 없이 중단됐는가",
  hasRecordedTermination: "종료 리비전이 기록됐는가",
  isLimitTerminated: "한도 종료인가",
  isSessionReviewPending: "검수 대기인가",
  isSessionStartupTarget: "시작 정리 대상인가",
};

function factCell(row: SessionDecisionRow): string {
  const entries = Object.entries(row.facts).filter(
    ([key]) => key !== "reviewNext" && key !== "target",
  );
  if (entries.length === 0) return "없음";
  return entries
    .map(([key, value]) => `${key}=${factValueLabel(key, String(value))}`)
    .join("<br>");
}

function decisionCell(row: SessionDecisionRow): string {
  return row.decision.kind === "apply"
    ? "적용"
    : row.decision.kind === "noop"
    ? "무시"
    : "거절";
}

function nextCell(row: SessionDecisionRow): string {
  return row.decision.kind === "apply"
    ? stateValueLabel(row.decision.next)
    : "그대로";
}

function commandCounts(rows: readonly SessionDecisionRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.command.type;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface SessionStateReport {
  rows: SessionDecisionRow[];
  promises: SessionPromiseResult[];
}

export function renderSessionCharts(promises: SessionPromiseResult[]) {
  validateDescriptions(sessionDecisionMachine.root);
  return plans.map((plan) => {
    const chart = toMermaid(sessionDecisionMachine.root as any, {
      ...plan.spec,
      parallel: "stack",
      hideEvents: ALL_COMMANDS.filter((command) => !plan.events.includes(command)),
    });
    if (chart.warnings.length > 0) {
      throw new Error(
        `${plan.id}: 차트 경고 ${chart.warnings.join(", ")}`,
      );
    }
    if (chart.edgeCount > 25) {
      throw new Error(`${plan.id}: 전이 화살표가 너무 많다 (${chart.edgeCount})`);
    }
    return { ...plan, ...chart };
  });
}

export function generateSessionStateDocument(
  report: SessionStateReport = {
    rows: sessionDecisionTable(),
    promises: checkSessionPromises(),
  },
) {
  const charts = renderSessionCharts(report.promises);
  const counts = commandCounts(report.rows);
  const lines = [
    "# 세션 상태 결정 규칙",
    "",
    `이 문서는 세션 결정 기계와 시험 세계에서 만든 생성물이다. 동작 기준 커밋은 ${SCIENTIFIC_BASE_COMMIT}이다. 저장 칸, SQL 함수, 판정 함수가 실제로 가르는 것만 사실로 두고 그림과 표와 검사를 함께 생성한다.`,
    "",
    "세션 하나는 한 줄이다. 상태, 종료 리비전 기록, 검수 상태가 저장 영역이고 한도 재개 예약은 이번 물결에서 읽기 전용 투영이다. 연결 여부, 워크트리 준비, 노드 보고는 저장 영역이 아니라 판정 사실이다.",
    "",
    `결정표 ${report.rows.length}줄. 모든 명령이 모든 표 상태 값에서 판정을 낸다. 빈 칸은 없다.`,
    "",
    "## 저장 상태 값",
    "",
    "| 상태 | status | termination_event_id | review_state |",
    "| :-- | :-- | :-- | :-- |",
  ];

  const representative: Array<[SessionStateValue["status"], SessionStateValue["termination"], SessionStateValue["review"]]> = [
    ["none", "none", "not_required"],
    ["initializing", "none", "not_required"],
    ["running", "none", "acknowledged"],
    ["completed", "recorded", "needs_review"],
    ["error", "recorded", "needs_review"],
    ["interrupted", "none", "needs_review"],
    ["interrupted", "recorded", "needs_review"],
  ];
  for (const [status, termination, review] of representative) {
    const value: SessionStateValue = {
      status,
      termination,
      review,
      reservation: "none",
      verdict: "ready",
    };
    const columns = stateValueToColumns(value);
    lines.push(
      `| ${stateValueLabel(value)} | ${columns.status ?? "null"} | ${
        columns.termination_event_id ?? "null"
      } | ${columns.review_state} |`,
    );
  }
  lines.push(
    "",
    "종료 리비전 기록은 값이 아니라 사실이다. 실제 종료 사건 번호는 명령이 나르며 기계는 번호를 저장하지 않는다. 검수 칸은 검수 필요 여부와 별개 칸이라 같은 상태에서도 세 값이 모두 가능하다.",
    "",
    "## 그림",
    "",
  );

  const chartNotes: Record<string, string> = {
    "01-status": "상태를 옮기는 명령만 보인다. 같은 상태로 다시 쓰는 전이는 화살표가 생기지 않는다.",
    "02-termination": "종료 리비전을 쓰거나 지우는 명령만 보인다. 실행 등록과 실행 중 전환은 종료 재개일 때만 기록을 지운다.",
    "03-review": "검수 칸을 쓰는 명령만 보인다. 검수 확인은 needs_review에서만 acknowledged로 쓴다.",
    "04-reservation": "이번 물결에는 예약을 쓰는 명령이 없다. 예약 영역은 읽기 전용 투영이다.",
  };
  for (const chart of charts) {
    lines.push(
      `### ${chart.id.replace(/^\d+-/, "")} ${chart.title}`,
      "",
      "```mermaid",
      chart.mermaid,
      "```",
      "",
      `${chartNotes[chart.id] ?? ""} 전이 화살표 ${chart.edgeCount}개.`,
      "",
    );
  }

  lines.push(
    "## 명령",
    "",
    "| 명령 | 하는 일 |",
    "| :-- | :-- |",
  );
  for (const command of SESSION_COMMANDS) {
    lines.push(
      `| ${SESSION_COMMAND_LABELS[command]} | ${SESSION_COMMAND_RULES[command]} |`,
    );
  }

  lines.push(
    "",
    "## 결정표",
    "",
    "상태 칸은 저장 상태 값, 사실 칸은 그 명령이 읽는 환경과 입력이다. 판정이 적용이 아니면 저장 상태는 그대로다.",
    "",
    "| 상태 | 사실 | 판정 | 사유 | 다음 상태 |",
    "| :-- | :-- | :-- | :-- | :-- |",
  );
  for (const row of report.rows) {
    lines.push(
      `| ${stateValueLabel(row.state)} | ${factCell(row)} | ${decisionCell(row)} | ${
        SESSION_REASON_LABELS[row.decision.reason] ?? row.decision.reason
      } | ${nextCell(row)} |`,
    );
  }

  lines.push(
    "",
    "## 명령별 줄 수",
    "",
    "| 명령 | 줄 수 |",
    "| :-- | --: |",
  );
  for (const command of SESSION_COMMANDS) {
    lines.push(`| ${SESSION_COMMAND_LABELS[command]} | ${counts.get(command) ?? 0} |`);
  }

  lines.push(
    "",
    "## 약속",
    "",
    "| 약속 | 위반 수 | 예시 |",
    "| :-- | --: | :-- |",
  );
  for (const promise of report.promises) {
    lines.push(
      `| ${promise.statement} | ${promise.violations} | ${
        promise.examples.join("<br>") || "없음"
      } |`,
    );
  }
  lines.push("");
  const holes = report.promises.filter((promise) => promise.violations > 0);
  if (holes.length === 0) {
    lines.push("알려진 구멍은 없다. 모든 약속의 위반 수가 0이다.");
  } else {
    lines.push("알려진 구멍.");
    for (const promise of holes) {
      lines.push(
        "",
        `- ${promise.knownHole ?? promise.statement} 위반 ${promise.violations}줄.`,
      );
    }
  }

  lines.push(
    "",
    "## 읽기 분류",
    "",
    "복합 분류 함수는 두지 않는다. 호출부가 필요한 낱개 조건을 고른다.",
    "",
    "| 함수 | 뜻 | SQL 조건 |",
    "| :-- | :-- | :-- |",
  );
  for (const [name, label] of Object.entries(classifierLabels) as Array<
    [SessionClassifierName, string]
  >) {
    lines.push(`| ${name} | ${label} | \`${SESSION_SQL_PREDICATES[name]("s")}\` |`);
  }

  lines.push(
    "",
    "## 쓰기 목록",
    "",
    "### SQL 함수",
    "",
    "| 함수 | 상태를 쓰는가 | 정의 | 호출지 | 뜻 |",
    "| :-- | :-- | :-- | :-- | :-- |",
  );
  for (const writer of SESSION_SQL_WRITERS) {
    const calls = writer.callSites.length === 0
      ? "없음"
      : writer.callSites.map((site) => `${site.file}:${site.line}`).join("<br>");
    lines.push(
      `| ${writer.name} | ${writer.writesStatus ? "예" : "아니오"} | ${writer.definition} | ${calls} | ${writer.note} |`,
    );
  }
  lines.push(
    "",
    "### 직접 UPDATE",
    "",
    "| 파일:줄 | 상태를 쓰는가 | 뜻 |",
    "| :-- | :-- | :-- |",
  );
  for (const write of SESSION_DIRECT_WRITES) {
    lines.push(
      `| ${write.file}:${write.line} | ${write.writesStatus ? "예" : "아니오"} | ${write.note} |`,
    );
  }
  lines.push(
    "",
    "시험은 이 목록 밖의 UPDATE sessions, INSERT INTO sessions, SQL 함수 호출을 발견하면 실패한다.",
    "",
    "## 상태 글자 허용 목록",
    "",
    "세션 상태 글자를 직접 비교하거나 목록에 넣으면 시험이 이 표와 대조한다. 다른 뜻이면 표의 뜻 칸에 적는다. 기계 디렉토리 안의 파일은 글자 비교의 정본이므로 검사에서 뺀다.",
    "",
    `- 비교식: \`${SESSION_STATUS_LITERAL_COMPARE_PATTERN}\``,
    `- 목록식: \`${SESSION_STATUS_LITERAL_LIST_PATTERN}\``,
    `- SQL 조건식: \`${SESSION_STATUS_LITERAL_SQL_PATTERN}\``,
    "",
    "| 파일 | 비교 | 목록 | SQL | 뜻 |",
    "| :-- | --: | --: | --: | :-- |",
  );
  for (const entry of SESSION_STATUS_LITERAL_ALLOWLIST) {
    lines.push(
      `| ${entry.file} | ${entry.comparisons} | ${entry.lists} | ${entry.sql} | ${entry.note} |`,
    );
  }
  const totals = SESSION_STATUS_LITERAL_ALLOWLIST.reduce(
    (sum, entry) => ({
      comparisons: sum.comparisons + entry.comparisons,
      lists: sum.lists + entry.lists,
      sql: sum.sql + entry.sql,
    }),
    { comparisons: 0, lists: 0, sql: 0 },
  );
  lines.push(
    "",
    `파일 ${SESSION_STATUS_LITERAL_ALLOWLIST.length}개, 비교 ${totals.comparisons}줄, 목록 ${totals.lists}줄, SQL ${totals.sql}줄이다.`,
  );

  lines.push(
    "",
    "## 다시 만들기",
    "",
    "```bash",
    "corepack pnpm@10.32.1 --dir orch-server-ts exec tsx scripts/session-state-charts.ts docs/sessions/generated",
    "```",
    "",
  );

  return { markdown: lines.join("\n"), charts, report };
}

export { SESSION_STATUS_LEAVES, SESSION_REVIEW_STATES };
