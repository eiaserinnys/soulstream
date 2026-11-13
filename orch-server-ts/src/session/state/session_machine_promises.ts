import type { SessionDecisionRow } from "./session_decision_table.js";
import { sessionDecisionTable } from "./session_decision_table.js";
import {
  SESSION_COMMAND_LABELS,
  SESSION_REASON_LABELS,
  stateValueLabel,
} from "./session_decision_labels.js";

export interface SessionPromiseDefinition {
  id: string;
  statement: string;
  knownHole?: string;
  breaks: (row: SessionDecisionRow) => boolean;
}

export interface SessionPromiseResult extends SessionPromiseDefinition {
  violations: number;
  examples: string[];
}

const ACTIVE = new Set(["initializing", "running"]);
const TERMINAL = new Set(["completed", "error", "interrupted"]);

export const SESSION_PROMISES: SessionPromiseDefinition[] = [
  {
    id: "terminal_revision_monotonic",
    statement:
      "종료 리비전이 이미 기록된 줄은 새 사건 번호가 기존 번호보다 클 때만 새 종료를 받는다.",
    breaks: (row) =>
      row.command.type === "terminal_transition"
      && row.decision.kind === "apply"
      && row.state.termination === "recorded"
      && (row.facts.revision === "equal" || row.facts.revision === "greater"),
  },
  {
    id: "interrupted_accepts_recorded_terminal",
    statement:
      "종료 리비전 없이 중단된 줄은 기존 종료 기록이 없으므로 새 종료 사건을 받아 리비전을 남긴다.",
    breaks: (row) =>
      row.command.type === "terminal_transition"
      && row.state.status === "interrupted"
      && row.state.termination === "none"
      && row.facts.revision === "none"
      && row.facts.owner !== "mismatch"
      && (
        row.decision.kind !== "apply"
        || row.decision.next.termination !== "recorded"
      ),
  },
  {
    id: "cleanup_only_active",
    statement:
      "노드 끊김 정리는 활성 줄만 중단으로 옮기고, 시작 정리 되살림은 종료 리비전 없이 중단된 줄만 실행 중으로 되돌린다.",
    breaks: (row) => {
      const command = row.command.type;
      if (
        (command === "node_disconnect_cleanup"
          || command === "startup_reconcile_missing")
        && row.decision.kind === "apply"
      ) {
        return !ACTIVE.has(row.state.status);
      }
      if (
        command === "startup_reconcile_restore"
        && row.decision.kind === "apply"
      ) {
        return !(
          row.state.status === "interrupted"
          && row.state.termination === "none"
        );
      }
      return false;
    },
  },
  {
    id: "running_requires_worktree",
    statement:
      "실행 등록, 실행 중 전환, 시작 정리 되살림이 실행 중으로 옮길 때는 워크트리 게이트를 지난다.",
    breaks: (row) => {
      if (
        !["execution_registration", "running_transition", "startup_reconcile_restore"]
          .includes(row.command.type)
        || row.decision.kind !== "apply"
        || row.decision.next.status !== "running"
      ) {
        return false;
      }
      if (row.facts.worktree !== undefined) {
        return row.facts.worktree === "not_ready"
          || row.facts.worktree === "setup_required"
          || row.facts.worktreeBusy === true;
      }
      return row.facts.worktreeReady !== true;
    },
  },
  {
    id: "terminal_to_running_only_resume",
    statement:
      "종료 상태에서 실행 중으로 가는 길은 종료 재개를 기록하는 두 함수와 시작 정리 되살림, 잇기 되살림뿐이다.",
    knownHole:
      "session_update_status가 종료 줄의 상태를 running으로 쓸 수 있다. SQL session_update가 status를 허용 열로 받기 때문이다.",
    breaks: (row) =>
      TERMINAL.has(row.state.status)
      && row.decision.kind === "apply"
      && row.decision.next.status === "running"
      && ![
        "execution_registration",
        "running_transition",
        "startup_reconcile_restore",
      ].includes(row.command.type),
  },
  {
    id: "owner_node_gate",
    statement: "소유 노드가 다른 상태 사건은 세션 줄을 바꾸지 않는다.",
    breaks: (row) =>
      row.facts.owner === "mismatch" && row.decision.kind === "apply",
  },
  {
    id: "disconnected_revived_only_by_adoption",
    statement:
      "끊김 중단은 실행 등록, 초기 시동, 일반 재개로 되살아나지 않고 잇기로만 되살아난다.",
    knownHole:
      "실행 등록과 잇기 아닌 실행 중 전환의 종료 재개 칸은 기대 종료 번호가 NULL과 같을 때 SQL이 되살린다. 일반 재개는 expected_terminal_event_id=null을 보내므로(soul-server-ts task_auto_resume_transition), 종료 번호가 NULL인 끊김 중단은 사용자 후속 글의 일반 재개로도 종료 재개 칸을 타고 되살아난다. 이것은 기존 동작이고 이번 물결은 adopt=거짓 판정을 바꾸지 않는다. 시작 정리 되살림은 이전 물결이 정한 되살림 길이며 아직 배선되지 않았다.",
    breaks: (row) => {
      if (
        ![
          "execution_registration",
          "running_transition",
          "startup_reconcile_restore",
        ].includes(row.command.type)
        || row.decision.kind !== "apply"
        || row.decision.next.status !== "running"
        || row.state.status !== "interrupted"
        || row.state.termination !== "none"
      ) {
        return false;
      }
      return !(
        row.command.type === "running_transition" && row.facts.adopt === true
      );
    },
  },
  {
    id: "active_delete_needs_stop",
    statement:
      "활성 줄은 노드가 실제로 지웠을 때만 사라지고, 노드가 못 지우거나 연결이 없으면 멈춘 뒤에만 지운다.",
    breaks: (row) =>
      row.command.type === "delete"
      && row.decision.kind === "apply"
      && ACTIVE.has(row.state.status)
      && row.facts.path !== "deleted",
  },
  {
    id: "limit_resume_chain",
    statement:
      "한도 재개는 예약의 한도 창과 종료 사슬이 이어질 때만 실행한다.",
    breaks: (row) =>
      row.command.type === "resume_dispatch"
      && row.decision.kind === "apply"
      && row.facts.chainContinued !== true,
  },
];

function example(row: SessionDecisionRow): string {
  const facts = Object.entries(row.facts)
    .filter(([key]) => key !== "reviewNext" && key !== "target")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
  return `${stateValueLabel(row.state)} / ${
    SESSION_COMMAND_LABELS[row.command.type]
  }${facts ? ` / ${facts}` : ""} → ${
    SESSION_REASON_LABELS[row.decision.reason] ?? row.decision.reason
  }`;
}

export function checkSessionPromises(
  rows: readonly SessionDecisionRow[] = sessionDecisionTable(),
): SessionPromiseResult[] {
  return SESSION_PROMISES.map((promise) => {
    const violating = rows.filter(promise.breaks);
    return {
      ...promise,
      violations: violating.length,
      examples: violating.slice(0, 3).map(example),
    };
  });
}
