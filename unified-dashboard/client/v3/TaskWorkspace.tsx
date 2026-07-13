import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ChatView,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

import type { PlannerTask } from "./planner-data";
import type { PageSessionDefaults } from "./task-workspace-api";
import {
  DEFAULT_WORKSPACE_SPLIT,
  buildRunTree,
  clampWorkspaceSplit,
  workspaceSplitForKey,
} from "./task-workspace-model";
import { TaskDetailPane } from "./TaskDetailPane";
import { V3SessionReviewBanner } from "./V3SessionReviewBanner";
import type { MobilePlannerTab } from "./mobile-planner-state";

export function TaskWorkspace({
  task,
  projectTitle,
  sessions,
  activeSession,
  chatOpen,
  chatInputDisabled,
  fileUploadUrl,
  sessionDefaults,
  mobileMode,
  mobileTab,
  onReturnToPlanner,
  onCloseChat,
  onOpenBoard,
  onOpenSession,
  onSaveDescription,
  onPromoteDocument,
  onAcknowledgedReview,
}: {
  task: PlannerTask;
  projectTitle: string;
  sessions: readonly SessionSummary[];
  activeSession: SessionSummary | undefined;
  chatOpen: boolean;
  chatInputDisabled: boolean;
  fileUploadUrl: string | undefined;
  sessionDefaults: PageSessionDefaults | null;
  mobileMode: boolean;
  mobileTab: MobilePlannerTab;
  onReturnToPlanner(): void;
  onCloseChat(): void;
  onOpenBoard(): void;
  onOpenSession(session: SessionSummary): void;
  onSaveDescription(markdown: string): Promise<void>;
  onPromoteDocument(blockId: string): Promise<void>;
  onAcknowledgedReview(result: SessionReviewAcknowledgeResult): void;
}) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const draggingPointer = useRef<number | null>(null);
  const [splitPercent, setSplitPercent] = useState(DEFAULT_WORKSPACE_SPLIT);

  useEffect(() => {
    if (!chatOpen) draggingPointer.current = null;
  }, [chatOpen]);

  const updateFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const bounds = workspace.getBoundingClientRect();
    setSplitPercent(clampWorkspaceSplit(((event.clientX - bounds.left) / bounds.width) * 100));
  };
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    draggingPointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFromPointer(event);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingPointer.current === event.pointerId) updateFromPointer(event);
  };
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingPointer.current !== event.pointerId) return;
    draggingPointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className={`v3-workspace-scrim${chatOpen ? " is-chat-open" : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onReturnToPlanner(); }}>
      <div
        ref={workspaceRef}
        className={`v3-workspace${chatOpen ? " is-chat-open" : ""}`}
        data-mobile-view={mobileMode ? mobileTab : undefined}
        style={chatOpen && !mobileMode ? { gridTemplateColumns: `minmax(0, calc(${splitPercent}% - 4px)) 8px minmax(0, 1fr)` } : undefined}
      >
        <TaskDetailPane
          task={task}
          sessions={sessions}
          sessionDefaults={sessionDefaults}
          onReturnToPlanner={onReturnToPlanner}
          onOpenBoard={onOpenBoard}
          onOpenSession={onOpenSession}
          onSaveDescription={onSaveDescription}
          onPromoteDocument={onPromoteDocument}
        />
        {chatOpen ? (
          <>
            <div
              className="v3-workspace-divider"
              role="separator"
              tabIndex={0}
              aria-label="상세와 채팅 너비 조절"
              aria-orientation="vertical"
              aria-valuemin={25}
              aria-valuemax={75}
              aria-valuenow={Math.round(splitPercent)}
              onPointerDown={beginDrag}
              onPointerMove={moveDrag}
              onPointerUp={finishDrag}
              onPointerCancel={finishDrag}
              onDoubleClick={() => setSplitPercent(DEFAULT_WORKSPACE_SPLIT)}
              onKeyDown={(event) => {
                const next = workspaceSplitForKey(splitPercent, event.key);
                if (next === null) return;
                event.preventDefault();
                setSplitPercent(next);
              }}
            ><span /></div>
            <section className="v3-chat-pane" aria-label="Run 채팅">
              <header className="v3-chat-header">
                <div><small>{projectTitle} › {task.page.title}</small><strong>{activeSession ? runLabel(task, activeSession, sessions) : "선택된 run 없음"}</strong></div>
                <span className={`v3-chat-status v3-chat-status--${activeSession?.status ?? "unknown"}`}>{activeSession ? activeSession.status === "running" ? "실행 중" : "완료" : "대기"}</span>
                <button type="button" aria-label="채팅 닫기" onClick={onCloseChat}>×</button>
              </header>
              {activeSession ? <V3SessionReviewBanner session={activeSession} onAcknowledged={onAcknowledgedReview} /> : null}
              <div className="v3-chat-content">
                {activeSession ? (
                  <ChatView chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} showHeader={false} />
                ) : (
                  <div className="v3-chat-empty" data-testid="v3-chat-empty">
                    <span className="v3-emoji" aria-hidden="true">💬</span>
                    <strong>이 업무에는 아직 run이 없습니다.</strong>
                    <p>업무 탭에서 새 세션을 시작하면 채팅이 열립니다.</p>
                    <button type="button" className="v3-button v3-button--soft" onClick={onCloseChat}>업무 탭으로</button>
                  </div>
                )}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function runLabel(
  task: PlannerTask,
  session: SessionSummary | undefined,
  sessions: readonly SessionSummary[],
): string {
  if (!session) return "Run";
  const roots = buildRunTree(task.sessionIds, sessions);
  const root = roots.find((node) => node.session.agentSessionId === session.agentSessionId);
  if (root?.runNumber) return `run #${root.runNumber}`;
  return session.displayName ?? session.agentName ?? "위임 세션";
}
