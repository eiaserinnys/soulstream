import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ChatView,
  DashboardIconCap,
  DragHandle,
  MarkdownDocumentPanel,
  useDashboardStore,
  useGlassSurface,
  type CatalogBoardItem,
  type CatalogFolder,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";
import { ChevronDown, ChevronUp, Minimize2 } from "lucide-react";

import type { MobilePlannerTab } from "./mobile-planner-state";
import type { PlannerTask } from "./planner-data";
import { sessionPanelTitle } from "./v3-session-panel-model";
import { buildRunTree, type RunSessionLoadState } from "./task-workspace-model";
import { buildSuccessionSessionOptions, latestTaskRun } from "./session-succession-model";
import { SessionSuccessionModal } from "./SessionSuccessionModal";
import { useTaskSessionContext } from "./use-task-session-context";
import type { PageSessionDefaults } from "./task-workspace-api";
import {
  V3_NAVIGATION_DEFAULT_WIDTH_PX,
  V3_PANEL_GAP_PX,
  V3_SESSION_PANEL_DEFAULT_WIDTH_PX,
} from "./v3-layout-metrics";
import {
  clampTaskChatWidth,
  clampTaskResourceWidth,
  initialTaskBoardResourceState,
  openTaskBoardResource,
  reconcileTaskBoardResourceState,
  type TaskBoardResourceSelection,
} from "./task-board-model";
import { TaskBoardPane } from "./TaskBoardPane";
import { TaskBoardResourcePane } from "./TaskBoardResourcePane";
import { V3SessionReviewBanner } from "./V3SessionReviewBanner";

const TASK_PANEL_KEYBOARD_STEP_PX = 24;

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
  folders,
  contextInvalidationKey,
  sessionDefaults,
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
  folders: readonly CatalogFolder[];
  contextInvalidationKey: number;
  sessionDefaults: PageSessionDefaults | null;
  onClose(): void;
  onOpenSession(session: SessionSummary): void;
  onAcknowledgedReview(result: SessionReviewAcknowledgeResult): void;
}) {
  const chatSurfaceRef = useRef<HTMLElement>(null);
  const chatWebglActive = useGlassSurface(chatSurfaceRef, { enabled: true });
  const workspaceRef = useRef<HTMLDivElement>(null);
  const resourceWidthRef = useRef<number>(V3_NAVIGATION_DEFAULT_WIDTH_PX);
  const chatWidthRef = useRef<number>(V3_SESSION_PANEL_DEFAULT_WIDTH_PX);
  const [boardItems, setBoardItems] = useState<readonly CatalogBoardItem[]>([]);
  const [resourceState, setResourceState] = useState(initialTaskBoardResourceState);
  const [overlayExpanded, setOverlayExpanded] = useState(false);
  const [successionOpen, setSuccessionOpen] = useState(false);
  const activeBoardDocumentId = useDashboardStore((state) => state.activeBoardDocumentId);
  const activeSessionKey = useDashboardStore((state) => state.activeSessionKey);

  // 새 세션 흐름은 업무 패널(TaskRunHistory)과 동일한 컨텍스트 상속 경로·다이얼로그를
  // 재사용한다(useTaskSessionContext + SessionSuccessionModal, container=task).
  const sessionContext = useTaskSessionContext({
    taskPageId: task.page.id,
    projectFolderId,
    folders,
    contextInvalidationKey,
    sessionDefaults,
    contextBlocks: task.blocks,
  });
  const runTree = useMemo(
    () => buildRunTree(task.sessionIds, sessions, runSessionLoadStates),
    [task.sessionIds, sessions, runSessionLoadStates],
  );
  const predecessorOptions = useMemo(
    () => buildSuccessionSessionOptions(runTree),
    [runTree],
  );
  const currentSession = useMemo(
    () => latestTaskRun(task.sessionIds, sessions),
    [task.sessionIds, sessions],
  );
  const documentOptions = useMemo(
    () => boardItems
      .filter((item) => item.itemType === "markdown")
      .map((item) => {
        const metadataTitle = item.metadata?.title;
        return {
          pageId: item.itemId,
          title: typeof metadataTitle === "string" && metadataTitle.trim() ? metadataTitle.trim() : "문서",
        };
      }),
    [boardItems],
  );

  useEffect(() => () => {
    useDashboardStore.getState().setActiveBoardDocument(null);
  }, []);

  // 좌측 자료 패널 폭은 기존 `--v3-navigation-width`, 오른쪽 채팅 폭은 기존
  // `--v3-session-panel-width` 토큰(그리드 좌·우 컬럼)에 세션 로컬로 반영한다.
  // contract test가 JSX inline style 리터럴을 금지하므로 ref의 setProperty로
  // 적용한다. 두 폭은 서로 독립이며 그리드 중앙 1fr가 여백을 흡수한다.
  const applyResourceWidth = useCallback((widthPx: number) => {
    const clamped = clampTaskResourceWidth(widthPx);
    resourceWidthRef.current = clamped;
    workspaceRef.current?.style.setProperty("--v3-navigation-width", `${clamped}px`);
  }, []);

  const applyChatWidth = useCallback((widthPx: number) => {
    const clamped = clampTaskChatWidth(widthPx);
    chatWidthRef.current = clamped;
    workspaceRef.current?.style.setProperty("--v3-session-panel-width", `${clamped}px`);
  }, []);

  useEffect(() => {
    applyResourceWidth(resourceWidthRef.current);
    applyChatWidth(chatWidthRef.current);
  }, [applyChatWidth, applyResourceWidth]);

  const resizeResources = useCallback((deltaPercent: number) => {
    const deltaPx = (document.documentElement.clientWidth * deltaPercent) / 100;
    applyResourceWidth(resourceWidthRef.current + deltaPx);
  }, [applyResourceWidth]);

  // 오른쪽 채팅은 왼쪽에 있으므로 핸들을 왼쪽으로 끌면(음의 deltaPx) 넓어진다.
  // 기존 세션 패널 리사이즈(`current - deltaPx`)와 동일한 부호 규약을 따른다.
  const resizeChat = useCallback((deltaPercent: number) => {
    const deltaPx = (document.documentElement.clientWidth * deltaPercent) / 100;
    applyChatWidth(chatWidthRef.current - deltaPx);
  }, [applyChatWidth]);

  const handleResourceResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      applyResourceWidth(resourceWidthRef.current - TASK_PANEL_KEYBOARD_STEP_PX);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      applyResourceWidth(resourceWidthRef.current + TASK_PANEL_KEYBOARD_STEP_PX);
    }
  }, [applyResourceWidth]);

  const handleChatResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      applyChatWidth(chatWidthRef.current + TASK_PANEL_KEYBOARD_STEP_PX);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      applyChatWidth(chatWidthRef.current - TASK_PANEL_KEYBOARD_STEP_PX);
    }
  }, [applyChatWidth]);

  // 오버레이를 닫으면 다음에 열 때 다시 기본 높이(40%)에서 시작한다.
  useEffect(() => {
    if (!activeBoardDocumentId) setOverlayExpanded(false);
  }, [activeBoardDocumentId]);

  const closeWorkspace = () => {
    useDashboardStore.getState().setActiveBoardDocument(null);
    onClose();
  };
  const openSession = (session: SessionSummary) => {
    useDashboardStore.getState().setActiveBoardDocument(null);
    onOpenSession(session);
  };
  const handleBoardItemsChanged = useCallback((items: readonly CatalogBoardItem[]) => {
    setBoardItems(items);
    setResourceState((current) => reconcileTaskBoardResourceState(current, items));
  }, []);
  const openResource = useCallback((resource: TaskBoardResourceSelection) => {
    setResourceState((current) => openTaskBoardResource(current, resource));
  }, []);

  return (
    <div
      className="v3-workspace-scrim is-chat-open is-task-board"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeWorkspace(); }}
    >
      <div
        ref={workspaceRef}
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
            openedResources={resourceState.openedResources}
            activeTabId={resourceState.activeTabId}
            onOpenSession={openSession}
            onOpenDocument={(documentId) => useDashboardStore.getState().setActiveBoardDocument(documentId)}
            onActiveTabChange={(activeTabId) => {
              setResourceState((current) => (
                current.activeTabId === activeTabId
                  ? current
                  : { ...current, activeTabId }
              ));
            }}
            onNewSession={() => setSuccessionOpen(true)}
          />
        </section>

        <div
          className="v3-task-board-resize v3-task-board-resize--left"
          data-testid="v3-task-board-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="업무 자료 패널 크기 조절"
          tabIndex={0}
          onKeyDown={handleResourceResizeKeyDown}
        >
          <DragHandle onDrag={resizeResources} widthPx={V3_PANEL_GAP_PX} />
        </div>

        <main className="v3-task-board-canvas" data-testid="v3-task-board-canvas">
          <TaskBoardPane
            taskId={task.taskId}
            projectFolderId={projectFolderId}
            projectTitle={projectTitle}
            sessions={sessions}
            taskMoveTargets={taskMoveTargets}
            onBoardItemsChanged={handleBoardItemsChanged}
            onOpenMarkdownDocument={(documentId) => {
              openResource({ kind: "document", resourceId: documentId });
            }}
            onOpenCustomView={(customViewId) => {
              openResource({ kind: "custom_view", resourceId: customViewId });
            }}
            onClose={closeWorkspace}
          />
        </main>

        <div
          className="v3-task-board-resize v3-task-board-resize--right"
          data-testid="v3-task-board-chat-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="채팅 패널 크기 조절"
          tabIndex={0}
          onKeyDown={handleChatResizeKeyDown}
        >
          <DragHandle onDrag={resizeChat} widthPx={V3_PANEL_GAP_PX} />
        </div>

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
            className={`v3-task-board-document-overlay${overlayExpanded ? " is-expanded" : ""}`}
            data-testid="v3-task-board-document-overlay"
          >
            <header className="v3-chat-header">
              <div>
                <small>{projectTitle} › {task.page.title}</small>
                <strong>마크다운 문서</strong>
              </div>
              <DashboardIconCap
                label={overlayExpanded ? "문서 편집기 높이 축소" : "문서 편집기 높이 확장"}
                aria-pressed={overlayExpanded}
                data-testid="v3-task-board-document-overlay-expand"
                onClick={() => setOverlayExpanded((current) => !current)}
              >
                {overlayExpanded ? (
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <ChevronUp className="h-4 w-4" aria-hidden="true" />
                )}
              </DashboardIconCap>
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

      {successionOpen ? (
        <SessionSuccessionModal
          taskTitle={task.page.title}
          taskPageId={task.page.id}
          taskId={task.taskId}
          contextItems={sessionContext.contextItems}
          documentOptions={documentOptions}
          pageContextSources={sessionContext.pageContextSources}
          contextPending={sessionContext.contextPending}
          predecessorOptions={predecessorOptions}
          pageDefaults={sessionContext.effectiveSessionDefaults}
          currentSession={currentSession}
          onClose={() => setSuccessionOpen(false)}
          onCreated={(session) => {
            setSuccessionOpen(false);
            openSession(session);
          }}
        />
      ) : null}
    </div>
  );
}
