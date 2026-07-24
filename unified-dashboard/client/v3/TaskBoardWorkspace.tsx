import { useCallback, useEffect, useMemo, useRef, useState, type AnimationEvent as ReactAnimationEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
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
import { ChevronDown, ChevronUp, X } from "lucide-react";

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

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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
  // 🔴23: 이 task의 마지막 보드 레이아웃(dashboard-store persist)을 최초 1회만 읽어 복원 시드로 쓴다.
  const layoutKey = task.page.id;
  const initialLayoutRef = useRef(useDashboardStore.getState().taskBoardLayouts[layoutKey] ?? null);

  const chatSurfaceRef = useRef<HTMLElement>(null);
  const chatWebglActive = useGlassSurface(chatSurfaceRef, { enabled: true });
  const workspaceRef = useRef<HTMLDivElement>(null);
  const resourceWidthRef = useRef<number>(
    clampTaskResourceWidth(initialLayoutRef.current?.resourceWidth ?? V3_NAVIGATION_DEFAULT_WIDTH_PX),
  );
  const chatWidthRef = useRef<number>(
    clampTaskChatWidth(initialLayoutRef.current?.chatWidth ?? V3_SESSION_PANEL_DEFAULT_WIDTH_PX),
  );
  const overlayRef = useRef<HTMLDivElement>(null);
  const overlayOffsetRef = useRef<number>(initialLayoutRef.current?.overlayOffsetX ?? 0);
  const didRestoreRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [boardItems, setBoardItems] = useState<readonly CatalogBoardItem[]>([]);
  const [resourceState, setResourceState] = useState(() => {
    const snap = initialLayoutRef.current;
    if (snap?.openedResources && snap.openedResources.length > 0) {
      return {
        openedResources: snap.openedResources.map((resource) => ({
          kind: resource.kind,
          resourceId: resource.resourceId,
        })) as TaskBoardResourceSelection[],
        activeTabId: snap.activeTabId ?? "checklist",
      };
    }
    return initialTaskBoardResourceState();
  });
  const [overlayExpanded, setOverlayExpanded] = useState(false);
  const [overlayClosing, setOverlayClosing] = useState(false);
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

  // 🔴23: persist 시점에 최신 값을 읽기 위한 미러 ref. 매 렌더 동기화(값 비용 없음).
  const resourceStateRef = useRef(resourceState);
  resourceStateRef.current = resourceState;
  const overlayExpandedRef = useRef(overlayExpanded);
  overlayExpandedRef.current = overlayExpanded;

  // 🔴23: 이 task의 보드 레이아웃을 디바운스 저장한다. 여러 소유자(폭·탭·오버레이)가
  // 같은 키에 부분 병합 기록하므로 stable하게 유지한다(deps=layoutKey).
  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      const store = useDashboardStore.getState();
      store.setTaskBoardLayout(layoutKey, {
        resourceWidth: Math.round(resourceWidthRef.current),
        chatWidth: Math.round(chatWidthRef.current),
        activeTabId: resourceStateRef.current.activeTabId,
        openedResources: resourceStateRef.current.openedResources.map((resource) => ({
          kind: resource.kind,
          resourceId: resource.resourceId,
        })),
        overlayExpanded: overlayExpandedRef.current,
        overlayOffsetX: Math.round(overlayOffsetRef.current),
        overlayOpen: store.activeBoardDocumentId != null,
        overlayDocumentId: store.activeBoardDocumentId,
        activeSessionKey: store.activeSessionKey,
      });
    }, 300);
  }, [layoutKey]);

  // 좌측 자료 패널 폭은 기존 `--v3-navigation-width`, 오른쪽 채팅 폭은 기존
  // `--v3-session-panel-width` 토큰(그리드 좌·우 컬럼)에 세션 로컬로 반영한다.
  // contract test가 JSX inline style 리터럴을 금지하므로 ref의 setProperty로
  // 적용한다. 두 폭은 서로 독립이며 그리드 중앙 1fr가 여백을 흡수한다.
  const applyResourceWidth = useCallback((widthPx: number) => {
    const clamped = clampTaskResourceWidth(widthPx);
    resourceWidthRef.current = clamped;
    workspaceRef.current?.style.setProperty("--v3-navigation-width", `${clamped}px`);
    schedulePersist();
  }, [schedulePersist]);

  const applyChatWidth = useCallback((widthPx: number) => {
    const clamped = clampTaskChatWidth(widthPx);
    chatWidthRef.current = clamped;
    workspaceRef.current?.style.setProperty("--v3-session-panel-width", `${clamped}px`);
    schedulePersist();
  }, [schedulePersist]);

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

  // 오버레이를 닫으면 다음에 열 때 다시 기본 높이(40%)에서 시작한다. 문서가 바뀌면
  // 진행 중인 닫힘 애니메이션도 취소한다(새 문서 열림이 닫힘보다 우선).
  useEffect(() => {
    if (!activeBoardDocumentId) setOverlayExpanded(false);
    setOverlayClosing(false);
  }, [activeBoardDocumentId]);

  // 🔴13/14/15: 닫기(X)·중앙 보드 클릭은 🔴13 애니메이션을 태운다. reduced-motion이면
  // 애니메이션 없이 즉시 닫는다. 닫힘 애니메이션 종료 시 실제로 오버레이를 해제한다.
  const requestCloseOverlay = useCallback(() => {
    if (prefersReducedMotion()) {
      useDashboardStore.getState().setActiveBoardDocument(null);
      return;
    }
    setOverlayClosing(true);
  }, []);
  const handleOverlayAnimationEnd = useCallback((event: ReactAnimationEvent<HTMLDivElement>) => {
    // 자식 요소 애니메이션 버블은 무시하고 오버레이 자체의 닫힘 애니메이션에만 반응.
    if (event.target !== event.currentTarget) return;
    if (overlayClosing) useDashboardStore.getState().setActiveBoardDocument(null);
  }, [overlayClosing]);

  // 🔴20: 오버레이 바깥(보드 영역) 상호작용은 닫지 않고 기본 높이(40%)로 축소한다.
  // 이미 40%면 그대로 유지(축소만, 닫힘 아님). 완전 닫기는 X 버튼(requestCloseOverlay)만.
  const requestShrinkOverlay = useCallback(() => {
    setOverlayExpanded(false);
  }, []);

  // 🔴22: 오버레이 가로 오프셋을 보드 영역(중앙 canvas) 안으로 clamp하여 CSS var로 반영.
  // 오버레이 폭이 보드보다 넓으면(narrow desktop) maxOffset=0이라 이동하지 않아 채팅 열을 침범하지 않는다.
  const applyOverlayOffset = useCallback((offsetPx: number) => {
    const canvas = workspaceRef.current?.querySelector<HTMLElement>('[data-testid="v3-task-board-canvas"]');
    const overlay = overlayRef.current;
    let clamped = offsetPx;
    if (canvas && overlay) {
      const maxOffset = Math.max(0, (canvas.clientWidth - overlay.offsetWidth) / 2);
      clamped = Math.max(-maxOffset, Math.min(maxOffset, offsetPx));
    }
    overlayOffsetRef.current = clamped;
    overlay?.style.setProperty("--v3-overlay-offset-x", `${clamped}px`);
  }, []);

  // 🔴22: 탑바(헤더) 드래그로 오버레이를 좌우로 옮긴다. 버튼 위 mousedown은 이동 시작 아님.
  const handleOverlayHeaderMouseDown = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (!target || target.closest("button")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startOffset = overlayOffsetRef.current;
    const handleMove = (moveEvent: MouseEvent) => {
      applyOverlayOffset(startOffset + (moveEvent.clientX - startX));
    };
    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      schedulePersist();
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }, [applyOverlayOffset, schedulePersist]);

  // 🔴22/23: 오버레이가 열릴 때 저장된 가로 오프셋을 적용한다(마운트/문서 전환 시).
  useEffect(() => {
    if (activeBoardDocumentId) applyOverlayOffset(overlayOffsetRef.current);
  }, [activeBoardDocumentId, applyOverlayOffset]);

  // 🔴23: 오버레이 확장 상태·활성 문서·활성 세션·탭 변경을 저장한다.
  useEffect(() => {
    schedulePersist();
  }, [schedulePersist, resourceState, overlayExpanded, activeBoardDocumentId, activeSessionKey]);

  // 🔴23: 재진입 시 마지막 활성 채팅 세션과 편집 오버레이 문서를 복원한다. 대상이 아직
  // 로딩 중이면 다음 렌더까지 대기하고, 목록이 로드됐는데도 없으면 삭제된 것으로 보고 건너뛴다.
  useEffect(() => {
    if (didRestoreRef.current) return;
    const snap = initialLayoutRef.current;
    if (!snap) { didRestoreRef.current = true; return; }
    const wantSessionKey = snap.activeSessionKey ?? null;
    const wantDocId = snap.overlayOpen ? (snap.overlayDocumentId ?? null) : null;
    const restoredSession = wantSessionKey
      ? sessions.find((candidate) => candidate.agentSessionId === wantSessionKey)
      : undefined;
    const docExists = wantDocId
      ? boardItems.some((item) => item.itemType === "markdown" && item.itemId === wantDocId)
      : false;
    // 로딩 대기: 참조 대상이 안 보이는데 목록도 비어 있으면 아직 로딩 중일 수 있다.
    if (wantSessionKey && !restoredSession && sessions.length === 0) return;
    if (wantDocId && !docExists && boardItems.length === 0) return;
    // 활성 세션 먼저(오버레이를 닫는 부작용 대비), 그다음 오버레이 문서를 마지막에 복원.
    if (restoredSession) onOpenSession(restoredSession);
    if (wantDocId && docExists) {
      useDashboardStore.getState().setActiveBoardDocument(wantDocId);
      if (snap.overlayExpanded) setOverlayExpanded(true);
    }
    didRestoreRef.current = true;
  }, [boardItems, sessions, onOpenSession]);

  useEffect(() => () => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
  }, []);

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
    // 로딩 중(빈 배열)엔 reconcile을 건너뛰어 복원된 탭을 보존한다. 실제 항목이 도착하면
    // 삭제된 자료 탭을 정리한다(🔴23 안전 폴백).
    setResourceState((current) => (
      items.length === 0 ? current : reconcileTaskBoardResourceState(current, items)
    ));
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

        <main
          className="v3-task-board-canvas"
          data-testid="v3-task-board-canvas"
          onMouseDownCapture={() => { if (activeBoardDocumentId) requestShrinkOverlay(); }}
        >
          <TaskBoardPane
            taskId={task.taskId}
            projectFolderId={projectFolderId}
            projectTitle={projectTitle}
            sessions={sessions}
            taskMoveTargets={taskMoveTargets}
            viewportPersistenceKey={layoutKey}
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
            ref={overlayRef}
            webglSurface
            cornerRadius={24}
            className={`v3-task-board-document-overlay${overlayExpanded ? " is-expanded" : ""}${overlayClosing ? " is-closing" : ""}`}
            data-testid="v3-task-board-document-overlay"
            data-state={overlayClosing ? "closing" : "open"}
            onAnimationEnd={handleOverlayAnimationEnd}
          >
            <header className="v3-chat-header" onMouseDown={handleOverlayHeaderMouseDown}>
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
                label="문서 편집기 닫기"
                data-testid="v3-task-board-document-overlay-close"
                onClick={requestCloseOverlay}
              >
                <X className="h-4 w-4" aria-hidden="true" />
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
