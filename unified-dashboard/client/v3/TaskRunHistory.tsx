import { useMemo, useState, type MouseEvent } from "react";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  ProfileAvatar,
  SessionContextMenu,
  type SessionContextMenuState,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

import {
  buildRunTree,
  type RunSessionLoadState,
  type RunTreeNode,
} from "./task-workspace-model";
import { latestTaskRun } from "./session-succession-model";
import type { PageSessionDefaults } from "./task-workspace-api";
import type { PlannerTask } from "./planner-data";
import { SessionSuccessionModal } from "./SessionSuccessionModal";
import "./v3-run-history.css";

export function TaskRunHistory({
  taskTitle,
  taskPageId,
  runbookId,
  contextCount,
  sessionDefaults,
  predecessorSessionId,
  sessionIds,
  sessions,
  runSessionLoadStates,
  moveTargets,
  onOpenSession,
  onSessionCreated,
  onRenameSession,
  onDeleteSessions,
  onMoveSession,
}: {
  taskTitle: string;
  taskPageId: string;
  runbookId: string;
  contextCount: number;
  sessionDefaults: PageSessionDefaults | null;
  predecessorSessionId: string | null;
  sessionIds: readonly string[];
  sessions: readonly SessionSummary[];
  runSessionLoadStates: ReadonlyMap<string, RunSessionLoadState>;
  moveTargets: readonly PlannerTask[];
  onOpenSession(session: SessionSummary): void;
  onSessionCreated(session: SessionSummary): void;
  onRenameSession(sessionId: string, displayName: string | null): Promise<void>;
  onDeleteSessions(sessionIds: string[]): Promise<void>;
  onMoveSession(sessionId: string, targetTask: PlannerTask): Promise<void>;
}) {
  const tree = useMemo(
    () => buildRunTree(sessionIds, sessions, runSessionLoadStates),
    [runSessionLoadStates, sessionIds, sessions],
  );
  const currentSession = useMemo(() => latestTaskRun(sessionIds, sessions), [sessionIds, sessions]);
  const [successionOpen, setSuccessionOpen] = useState(false);
  const [targetedSuccessionId, setTargetedSuccessionId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const [moveSessionId, setMoveSessionId] = useState<string | null>(null);
  const [movePending, setMovePending] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const targetedSuccession = targetedSuccessionId
    ? sessions.find((session) => session.agentSessionId === targetedSuccessionId) ?? null
    : currentSession;
  const visibleMoveTargets = [...new Map(
    moveTargets
      .filter((task) => task.runbookId !== runbookId)
      .map((task) => [task.runbookId, task]),
  ).values()];

  const openRunContextMenu = (session: SessionSummary, event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, sessionId: session.agentSessionId });
  };

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
            onOpenSession={onOpenSession}
            onContextMenu={openRunContextMenu}
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
          currentSession={targetedSuccession}
          predecessorSessionId={targetedSuccessionId ?? predecessorSessionId}
          onClose={() => { setSuccessionOpen(false); setTargetedSuccessionId(null); }}
          onCreated={onSessionCreated}
        />
      ) : null}
      <SessionContextMenu
        contextMenu={contextMenu}
        onClose={() => setContextMenu(null)}
        onRenameSession={onRenameSession}
        onDeleteSessions={onDeleteSessions}
        getSessionName={(sessionId) => sessionTitle(sessions.find((session) => session.agentSessionId === sessionId) ?? ({ agentSessionId: sessionId } as SessionSummary))}
        resolveSessionIds={(sessionId) => [sessionId]}
        extraActions={[
          {
            label: "▶ 이어서 새 세션 (승계)",
            onClick: () => {
              if (!contextMenu) return;
              setTargetedSuccessionId(contextMenu.sessionId);
              setContextMenu(null);
              setSuccessionOpen(true);
            },
          },
          {
            label: "다른 업무로 이동",
            disabled: visibleMoveTargets.length === 0,
            onClick: () => {
              if (!contextMenu) return;
              setMoveSessionId(contextMenu.sessionId);
              setMoveError(null);
              setContextMenu(null);
            },
          },
        ]}
      />
      <Dialog open={moveSessionId !== null} onOpenChange={(open) => { if (!open && !movePending) setMoveSessionId(null); }}>
        <DialogPopup className="max-w-sm">
          <DialogHeader><DialogTitle>다른 업무로 이동</DialogTitle></DialogHeader>
          <DialogPanel>
            <div className="v3-run-move-targets">
              {visibleMoveTargets.map((target) => (
                <button
                  type="button"
                  key={target.runbookId}
                  disabled={movePending}
                  onClick={() => {
                    if (!moveSessionId) return;
                    setMovePending(true);
                    setMoveError(null);
                    void onMoveSession(moveSessionId, target)
                      .then(() => setMoveSessionId(null))
                      .catch((error: unknown) => setMoveError(error instanceof Error ? error.message : String(error)))
                      .finally(() => setMovePending(false));
                  }}
                >
                  <strong>{target.page.title}</strong><small>{target.runbookId.slice(0, 8)}</small>
                </button>
              ))}
            </div>
            {moveError ? <p className="v3-load-error" role="alert">{moveError}</p> : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </section>
  );
}

function RunNode({
  node,
  depth,
  onOpenSession,
  onContextMenu,
}: {
  node: RunTreeNode;
  depth: number;
  onOpenSession(session: SessionSummary): void;
  onContextMenu(session: SessionSummary, event: MouseEvent<HTMLDivElement>): void;
}) {
  const { session } = node;
  if (node.loadState === "loading") {
    return (
      <div className={depth > 0 ? "v3-run-children" : undefined}>
        <div className="v3-run-row v3-run-row--loading" data-depth={depth} aria-label="세션 정보 불러오는 중" aria-busy="true">
          <span className="v3-run-skeleton v3-run-skeleton--avatar" />
          <span className="v3-run-skeleton-copy">
            <span className="v3-run-skeleton v3-run-skeleton--title" />
            <span className="v3-run-skeleton v3-run-skeleton--preview" />
          </span>
          <span className="v3-run-skeleton v3-run-skeleton--badge" />
        </div>
      </div>
    );
  }
  const failed = node.loadState === "failed";
  const title = failed ? runNumberLabel(node.runNumber) : sessionTitle(session);
  const status = failed ? "조회 실패" : statusLabel(session.status);
  const portraitUrl = failed ? null : sessionPortraitUrl(session);
  const preview = failed
    ? "세션 정보를 불러오지 못했습니다."
    : session.lastMessage?.preview?.trim() || session.prompt?.trim() || "아직 표시할 메시지가 없습니다.";
  return (
    <div className={depth > 0 ? "v3-run-children" : undefined}>
      <div
        className={`v3-run-row${failed ? " v3-run-row--failed" : ""}`}
        data-depth={depth}
        data-load-state={node.loadState}
        data-session-id={failed ? undefined : session.agentSessionId}
        onContextMenu={failed ? undefined : (event) => onContextMenu(session, event)}
      >
        <button type="button" className="v3-run-open" disabled={failed} onClick={() => onOpenSession(session)}>
          <span className="v3-run-avatar">
            <ProfileAvatar role="assistant" hasPortrait={Boolean(portraitUrl)} portraitUrl={portraitUrl} fallbackEmoji="🤖" />
          </span>
          <span className="v3-run-copy">
            <span className="v3-run-title-line">
              <strong>{title}</strong>
              {!failed && node.runNumber !== null ? <span className="v3-run-number">run #{node.runNumber}</span> : null}
            </span>
            <span className="v3-run-agent-line">
              <span>{failed ? "세션 상세 없음" : session.agentName ?? session.agentId ?? "에이전트 미상"}</span>
              {!failed ? <span>{session.nodeId ?? "노드 미상"}</span> : null}
            </span>
            <small>{preview}</small>
          </span>
          <span className="v3-run-trailing">
            <span className={`v3-run-status-badge v3-run-status-badge--${failed ? "failed" : session.status}`}>
              <span className={`v3-run-status v3-run-status--${failed ? "error" : session.status}`} aria-hidden="true" />
              {status}
            </span>
            <time>{failed ? "" : formatRelativeSessionTime(session)}</time>
          </span>
        </button>
      </div>
      {node.children.map((child) => (
        <RunNode
          key={child.session.agentSessionId}
          node={child}
          depth={depth + 1}
          onOpenSession={onOpenSession}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  );
}

function sessionTitle(session: SessionSummary): string {
  const title = (session as SessionSummary & { title?: string }).title;
  return session.displayName?.trim()
    || title?.trim()
    || session.prompt?.replace(/\s+/g, " ").trim()
    || session.agentSessionId;
}

function sessionPortraitUrl(session: SessionSummary): string | null {
  if (session.agentPortraitUrl) return session.agentPortraitUrl;
  if (!session.nodeId || !session.agentId) return null;
  return `/api/nodes/${encodeURIComponent(session.nodeId)}/agents/${encodeURIComponent(session.agentId)}/portrait`;
}

function statusLabel(status: SessionSummary["status"]): string {
  if (status === "running") return "실행 중";
  if (status === "completed") return "완료";
  if (status === "error") return "오류";
  if (status === "interrupted") return "중단";
  return "대기";
}

function runNumberLabel(runNumber: number | null): string {
  return runNumber === null ? "run" : `run #${runNumber}`;
}

function formatRelativeSessionTime(session: SessionSummary): string {
  const value = session.lastMessage?.timestamp
    ?? session.completedAt
    ?? session.updatedAt
    ?? session.createdAt;
  if (!value) return "시각 미상";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "시각 미상";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "방금 전";
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.round(hours / 24)}일 전`;
}
