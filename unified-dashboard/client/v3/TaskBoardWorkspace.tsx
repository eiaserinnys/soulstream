import { useEffect, useRef, useState } from "react";
import {
  ChatView,
  DashboardIconCap,
  MarkdownDocumentPanel,
  useDashboardStore,
  useGlassSurface,
  type CatalogBoardItem,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";
import { Minimize2 } from "lucide-react";

import type { MobilePlannerTab } from "./mobile-planner-state";
import type { PlannerTask } from "./planner-data";
import { sessionPanelTitle } from "./v3-session-panel-model";
import type { RunSessionLoadState } from "./task-workspace-model";
import { TaskBoardPane } from "./TaskBoardPane";
import { TaskBoardResourcePane } from "./TaskBoardResourcePane";
import { V3SessionReviewBanner } from "./V3SessionReviewBanner";

export function TaskBoardWorkspace({
  task,
  projectFolderId,
  projectTitle,
  sessions,
  runSessionLoadStates,
  activeSession,
  chatInputDisabled,
  fileUploadUrl,
  mobileMode,
  mobileTab,
  taskMoveTargets,
  onClose,
  onOpenSession,
  onAcknowledgedReview,
}: {
  task: PlannerTask;
  projectFolderId: string | null;
  projectTitle: string;
  sessions: readonly SessionSummary[];
  runSessionLoadStates: ReadonlyMap<string, RunSessionLoadState>;
  activeSession: SessionSummary | undefined;
  chatInputDisabled: boolean;
  fileUploadUrl: string | undefined;
  mobileMode: boolean;
  mobileTab: MobilePlannerTab;
  taskMoveTargets: readonly PlannerTask[];
  onClose(): void;
  onOpenSession(session: SessionSummary): void;
  onAcknowledgedReview(result: SessionReviewAcknowledgeResult): void;
}) {
  const chatSurfaceRef = useRef<HTMLElement>(null);
  const chatWebglActive = useGlassSurface(chatSurfaceRef, { enabled: true });
  const [boardItems, setBoardItems] = useState<readonly CatalogBoardItem[]>([]);
  const activeBoardDocumentId = useDashboardStore((state) => state.activeBoardDocumentId);
  const activeSessionKey = useDashboardStore((state) => state.activeSessionKey);

  useEffect(() => () => {
    useDashboardStore.getState().setActiveBoardDocument(null);
  }, []);

  const closeWorkspace = () => {
    useDashboardStore.getState().setActiveBoardDocument(null);
    onClose();
  };
  const openSession = (session: SessionSummary) => {
    useDashboardStore.getState().setActiveBoardDocument(null);
    onOpenSession(session);
  };

  return (
    <div
      className="v3-workspace-scrim is-chat-open is-task-board"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeWorkspace(); }}
    >
      <div
        className="v3-workspace is-board-open v3-task-board-workspace"
        data-mobile-view={mobileMode ? mobileTab : undefined}
      >
        <section
          className="v3-detail-pane v3-task-board-resources border border-glass-border glass-strong glass-chrome lg-rim"
          data-testid="v3-task-board-resources"
          aria-label="업무 자료"
        >
          <TaskBoardResourcePane
            taskId={task.taskId}
            taskTitle={task.page.title}
            sessionIds={task.sessionIds}
            sessions={sessions}
            runSessionLoadStates={runSessionLoadStates}
            activeSessionId={activeSessionKey}
            boardItems={boardItems}
            onOpenSession={openSession}
            onOpenDocument={(documentId) => useDashboardStore.getState().setActiveBoardDocument(documentId)}
          />
        </section>

        <main className="v3-task-board-canvas" data-testid="v3-task-board-canvas">
          <TaskBoardPane
            taskId={task.taskId}
            projectFolderId={projectFolderId}
            projectTitle={projectTitle}
            sessions={sessions}
            taskMoveTargets={taskMoveTargets}
            onBoardItemsChanged={setBoardItems}
            onClose={closeWorkspace}
          />
        </main>

        <section
          ref={chatSurfaceRef}
          className="v3-chat-pane v3-task-board-chat border border-glass-border glass-strong glass-chrome lg-rim"
          data-liquid-glass-webgl={chatWebglActive ? "true" : undefined}
          data-testid="v3-task-board-chat"
          aria-label="세션 채팅"
        >
          <header className="v3-chat-header">
            <div className="v3-chat-session-title">
              <strong>{activeSession ? sessionPanelTitle(activeSession) : "선택된 세션 없음"}</strong>
            </div>
            <span className={`v3-chat-status v3-chat-status--${activeSession?.status ?? "unknown"}`}>
              {activeSession ? activeSession.status === "running" ? "실행 중" : "완료" : "대기"}
            </span>
          </header>
          {activeSession ? (
            <V3SessionReviewBanner session={activeSession} onAcknowledged={onAcknowledgedReview} />
          ) : null}
          <div className="v3-chat-content">
            {activeSession ? (
              <ChatView
                chatInputDisabled={chatInputDisabled}
                fileUploadUrl={fileUploadUrl}
                showHeader={false}
              />
            ) : (
              <div className="v3-chat-empty">
                <span className="v3-emoji" aria-hidden="true">💬</span>
                <strong>위임 관계에서 세션을 선택하세요.</strong>
                <p>채팅은 보드와 문서 편집 중에도 이 자리에 유지됩니다.</p>
              </div>
            )}
          </div>
        </section>

        {activeBoardDocumentId ? (
          <LiquidGlassCard
            webglSurface
            cornerRadius={24}
            className="v3-task-board-document-overlay"
            data-testid="v3-task-board-document-overlay"
          >
            <header className="v3-chat-header">
              <div>
                <small>{projectTitle} › {task.page.title}</small>
                <strong>마크다운 문서</strong>
              </div>
              <DashboardIconCap
                label="문서 편집기 접기"
                onClick={() => useDashboardStore.getState().setActiveBoardDocument(null)}
              >
                <Minimize2 className="h-4 w-4" aria-hidden="true" />
              </DashboardIconCap>
            </header>
            <div className="v3-board-document-content"><MarkdownDocumentPanel /></div>
          </LiquidGlassCard>
        ) : null}
      </div>
    </div>
  );
}
