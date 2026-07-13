import { useMemo, useState } from "react";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import {
  buildRunTree,
  isRunResumable,
  type RunTreeNode,
} from "./task-workspace-model";
import { latestTaskRun } from "./session-succession-model";
import type { PageSessionDefaults } from "./task-workspace-api";
import { SessionSuccessionModal } from "./SessionSuccessionModal";

export function TaskRunHistory({
  taskTitle,
  taskPageId,
  runbookId,
  contextCount,
  sessionDefaults,
  predecessorSessionId,
  sessionIds,
  sessions,
  onOpenSession,
  onSessionCreated,
}: {
  taskTitle: string;
  taskPageId: string;
  runbookId: string;
  contextCount: number;
  sessionDefaults: PageSessionDefaults | null;
  predecessorSessionId: string | null;
  sessionIds: readonly string[];
  sessions: readonly SessionSummary[];
  onOpenSession(session: SessionSummary): void;
  onSessionCreated(session: SessionSummary): void;
}) {
  const tree = useMemo(() => buildRunTree(sessionIds, sessions), [sessionIds, sessions]);
  const currentSession = useMemo(() => latestTaskRun(sessionIds, sessions), [sessionIds, sessions]);
  const [expandedSummary, setExpandedSummary] = useState<string | null>(null);
  const [successionOpen, setSuccessionOpen] = useState(false);

  return (
    <section className="v3-detail-section v3-runs">
      <div className="v3-detail-section-head">
        <h3>Run 히스토리</h3><span>{tree.length}회</span><span className="v3-spacer" />
        <button type="button" className="v3-button v3-button--soft" onClick={() => setSuccessionOpen(true)}>▶ 새 세션</button>
      </div>
      {tree.length === 0 ? <p className="v3-detail-empty">아직 실행된 세션이 없습니다.</p> : null}
      <div className="v3-run-list">
        {tree.map((node) => (
          <RunNode
            key={node.session.agentSessionId}
            node={node}
            depth={0}
            expandedSummary={expandedSummary}
            onToggleSummary={(sessionId) => setExpandedSummary((current) => current === sessionId ? null : sessionId)}
            onOpenSession={onOpenSession}
          />
        ))}
      </div>
      {successionOpen ? (
        <SessionSuccessionModal
          taskTitle={taskTitle}
          taskPageId={taskPageId}
          runbookId={runbookId}
          contextCount={contextCount}
          pageDefaults={sessionDefaults}
          currentSession={currentSession}
          predecessorSessionId={predecessorSessionId}
          onClose={() => setSuccessionOpen(false)}
          onCreated={onSessionCreated}
        />
      ) : null}
    </section>
  );
}

function RunNode({
  node,
  depth,
  expandedSummary,
  onToggleSummary,
  onOpenSession,
}: {
  node: RunTreeNode;
  depth: number;
  expandedSummary: string | null;
  onToggleSummary(sessionId: string): void;
  onOpenSession(session: SessionSummary): void;
}) {
  const { session } = node;
  const label = node.runNumber === null
    ? session.displayName ?? session.agentName ?? "위임 세션"
    : `run #${node.runNumber}`;
  const status = session.status === "running" ? "실행 중" : session.status === "completed" ? "완료" : session.status;
  const expanded = expandedSummary === session.agentSessionId;
  return (
    <div className={depth > 0 ? "v3-run-children" : undefined}>
      <div className="v3-run-row" data-depth={depth}>
        <button type="button" className="v3-run-open" onClick={() => onOpenSession(session)}>
          <span className={`v3-run-status v3-run-status--${session.status}`} aria-hidden="true" />
          <span><strong>{label}</strong><small>{status} · {formatSessionTime(session)}</small></span>
        </button>
        {isRunResumable(session) ? (
          <button type="button" className="v3-run-action" onClick={() => onOpenSession(session)}>재개</button>
        ) : null}
        <button type="button" className="v3-run-action" aria-label={`${label} 요약`} aria-expanded={expanded} onClick={() => onToggleSummary(session.agentSessionId)}>ⓘ</button>
      </div>
      {expanded ? <div className="v3-run-summary">{session.awaySummary?.trim() || "요약 없음"}</div> : null}
      {node.children.map((child) => (
        <RunNode
          key={child.session.agentSessionId}
          node={child}
          depth={depth + 1}
          expandedSummary={expandedSummary}
          onToggleSummary={onToggleSummary}
          onOpenSession={onOpenSession}
        />
      ))}
    </div>
  );
}

function formatSessionTime(session: SessionSummary): string {
  const value = session.completedAt ?? session.updatedAt ?? session.createdAt;
  if (!value) return "시각 미상";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "시각 미상"
    : new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
