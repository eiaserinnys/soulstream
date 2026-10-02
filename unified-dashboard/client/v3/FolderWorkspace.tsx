import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  ChatView,
  DashboardIconCap,
  useDashboardStore,
  useGlassSurface,
  type CatalogFolder,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
  type SessionProviderConnectionStatus,
} from "@seosoyoung/soul-ui";

import { X } from "lucide-react";

import type { PlannerFolder } from "./planner-data";
import type { PageSessionDefaults } from "./folder-workspace-page-api";
import {
  DEFAULT_WORKSPACE_SPLIT,
  clampWorkspaceSplit,
  isFolderWorkspaceChatVisible,
  type RunSessionLoadState,
  workspaceSplitForKey,
} from "./folder-workspace-run-model";
import { FolderDetailPane } from "./FolderDetailPane";
import type { FolderSectionFocusRequest } from "./FolderSectionNavigation";
import { FolderBoardWorkspace } from "./FolderBoardWorkspace";
import { V3SessionReviewBanner } from "./V3SessionReviewBanner";
import { SessionPanelHeader } from "./WorkspacePanelHeaders";
import type { MobilePlannerTab } from "./mobile-planner-state";

export function FolderWorkspace({
  task,
  folderSections,
  parentFolder,
  onOpenParent,
  folderResolutionError,
  projectTitle,
  projectFolderId,
  folders,
  contextInvalidationKey,
  sessions,
  runSessionLoadStates,
  runHistoryTotal,
  runHistoryHasMore,
  runHistoryLoading,
  onLoadMoreRuns,
  activeSession,
  focusRequest,
  onFocusRequestHandled,
  chatOpen,
  chatInputDisabled,
  fileUploadUrl,
  sessionDefaults,
  mobileMode,
  mobileTab,
  historyEnabled,
  sessionStreamActive,
  sessionConnectionStatus,
  reconnectSession,
  onChatVisibilityChange,
  folderMoveTargets,
  folderInToday,
  onReturnToToday,
  onToggleFolderToday,
  onCloseWorkspace,
  onCloseChat,
  onOpenSession,
  onRenameFolderTitle,
  onSaveDescription,
  onFolderBlocksChanged,
  onAcknowledgedReview,
  forceBoardOpen = false,
  onCloseBoard,
  onArchiveFolder,
  markdownDocumentsRevision,
  onMarkdownDocumentEditorClosed,
}: {
  task: PlannerFolder | null;
  folderSections: ReactNode;
  parentFolder: CatalogFolder | null;
  onOpenParent(folder: CatalogFolder): void;
  folderResolutionError: string | null;
  projectTitle: string;
  projectFolderId: string | null;
  folders: readonly CatalogFolder[];
  contextInvalidationKey: number;
  sessions: readonly SessionSummary[];
  runSessionLoadStates: ReadonlyMap<string, RunSessionLoadState>;
  runHistoryTotal: number;
  runHistoryHasMore: boolean;
  runHistoryLoading: boolean;
  onLoadMoreRuns(): Promise<void>;
  activeSession: SessionSummary | undefined;
  focusRequest: FolderSectionFocusRequest | null;
  onFocusRequestHandled(requestId: number): void;
  chatOpen: boolean;
  chatInputDisabled: boolean;
  fileUploadUrl: string | undefined;
  sessionDefaults: PageSessionDefaults | null;
  mobileMode: boolean;
  mobileTab: MobilePlannerTab;
  historyEnabled: boolean;
  sessionStreamActive: boolean;
  sessionConnectionStatus: SessionProviderConnectionStatus;
  reconnectSession(): void;
  onChatVisibilityChange(visible: boolean): void;
  folderMoveTargets: readonly PlannerFolder[];
  folderInToday: boolean;
  onReturnToToday(): void;
  onToggleFolderToday(): Promise<void>;
  onCloseWorkspace(): void;
  onCloseChat(): void;
  onOpenSession(session: SessionSummary): void;
  onRenameFolderTitle(title: string): Promise<string>;
  onSaveDescription(markdown: string): Promise<void>;
  onFolderBlocksChanged(blocks: PlannerFolder["blocks"]): void;
  onAcknowledgedReview(result: SessionReviewAcknowledgeResult): void;
  forceBoardOpen?: boolean;
  onCloseBoard(): void;
  onArchiveFolder?: () => Promise<void>;
  markdownDocumentsRevision: number;
  onMarkdownDocumentEditorClosed(): void;
}) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const chatSurfaceRef = useRef<HTMLElement>(null);
  const draggingPointer = useRef<number | null>(null);
  const [splitPercent, setSplitPercent] = useState(DEFAULT_WORKSPACE_SPLIT);
  const [boardOpen, setBoardOpen] = useState(false);
  const [visibleTitle, setVisibleTitle] = useState(task?.page.title ?? "");
  const chatWebglActive = useGlassSurface(chatSurfaceRef, { enabled: chatOpen && !boardOpen });
  const activeSessionKey = useDashboardStore((state) => state.activeSessionKey);
  const setActiveBoardDocument = useDashboardStore((state) => state.setActiveBoardDocument);
  const chatVisible = isFolderWorkspaceChatVisible({
    hasActiveSession: activeSession !== undefined,
    hasFolder: task !== null,
    boardOpen,
    chatOpen,
    mobileMode,
    mobileChatTab: mobileTab === "chat",
  });

  useEffect(() => {
    onChatVisibilityChange(chatVisible);
    return () => onChatVisibilityChange(false);
  }, [chatVisible, onChatVisibilityChange]);

  useEffect(() => {
    setBoardOpen(false);
    setVisibleTitle(task?.page.title ?? "");
  }, [task?.page.id, task?.page.title]);

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

  const closeWorkspaceInspector = () => {
    onCloseChat();
  };

  const divider = (label: string) => (
    <div
      className="v3-workspace-divider"
      role="separator"
      tabIndex={0}
      aria-label={label}
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
  );

  if (!task) {
    return (
      <div className="v3-workspace-scrim is-chat-open" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCloseWorkspace(); }}>
        <div
          ref={workspaceRef}
          className="v3-workspace is-chat-open"
          data-mobile-view={mobileMode ? mobileTab : undefined}
          style={!mobileMode ? { gridTemplateColumns: `minmax(0, calc(${splitPercent}% - 8px)) 16px minmax(0, 1fr)` } : undefined}
        >
          <section className="v3-detail-pane border border-glass-border glass-strong glass-chrome lg-rim" data-testid="v3-standalone-task-empty" aria-label="빈 폴더 창">
            <header className="v3-workspace-toolbar">
              <strong>폴더</strong>
              <span className="v3-spacer" />
              <DashboardIconCap label="폴더 창 닫기" onClick={onCloseWorkspace}>
                <X className="h-4 w-4" aria-hidden="true" />
              </DashboardIconCap>
            </header>
            <div className="v3-chat-empty">
              <strong>{folderResolutionError ?? "연결된 폴더가 없습니다."}</strong>
              <p>{folderResolutionError
                ? "폴더 귀속을 다시 확인해 주세요. 이 세션의 채팅은 그대로 확인할 수 있습니다."
                : "이 세션의 채팅은 그대로 확인할 수 있습니다."}</p>
            </div>
          </section>
          {divider("폴더와 채팅 너비 조절")}
          <section
            ref={chatSurfaceRef}
            className="v3-chat-pane border border-glass-border glass-strong glass-chrome lg-rim"
            data-liquid-glass-webgl={chatWebglActive ? "true" : undefined}
            data-testid="v3-standalone-session-chat"
            aria-label="세션 채팅"
          >
            <SessionPanelHeader session={activeSession} streamActive={sessionStreamActive}
                connectionStatus={sessionConnectionStatus} reconnect={reconnectSession} emptyTitle="세션" onClose={onCloseWorkspace}/>
            {activeSession ? <V3SessionReviewBanner session={activeSession} onAcknowledged={onAcknowledgedReview} /> : null}
            <div className="v3-chat-content">
              {activeSession ? <ChatView chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} historyEnabled={historyEnabled} /> : <div className="v3-chat-empty"><strong>세션을 찾을 수 없습니다.</strong></div>}
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (boardOpen || forceBoardOpen) {
    return (
      <FolderBoardWorkspace
        task={visibleTitle === task.page.title ? task : { ...task, page: { ...task.page, title: visibleTitle } }}
        projectFolderId={projectFolderId}
        projectTitle={projectTitle}
        sessions={sessions}
        runSessionLoadStates={runSessionLoadStates}
        runHistoryTotal={runHistoryTotal}
        runHistoryHasMore={runHistoryHasMore}
        runHistoryLoading={runHistoryLoading}
        activeSession={activeSession}
        chatInputDisabled={chatInputDisabled}
        fileUploadUrl={fileUploadUrl}
        mobileMode={mobileMode}
        mobileTab={mobileTab}
        historyEnabled={historyEnabled}
        sessionStreamActive={sessionStreamActive}
        sessionConnectionStatus={sessionConnectionStatus}
        reconnectSession={reconnectSession}
        folderMoveTargets={folderMoveTargets}
        folders={folders}
        contextInvalidationKey={contextInvalidationKey}
        markdownDocumentsRevision={markdownDocumentsRevision}
        sessionDefaults={sessionDefaults}
        onMarkdownDocumentEditorClosed={onMarkdownDocumentEditorClosed}
        onClose={() => { setBoardOpen(false); onCloseBoard(); }}
        onOpenSession={onOpenSession}
        onLoadMoreRuns={onLoadMoreRuns}

        onAcknowledgedReview={onAcknowledgedReview}
      />
    );
  }

  return (
    <div className={`v3-workspace-scrim${chatOpen ? " is-chat-open" : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCloseWorkspace(); }}>
      <div
        ref={workspaceRef}
        className={`v3-workspace${chatOpen ? " is-chat-open" : ""}`}
        data-mobile-view={mobileMode ? mobileTab : undefined}
        style={chatOpen && !mobileMode ? { gridTemplateColumns: `minmax(0, calc(${splitPercent}% - 8px)) 16px minmax(0, 1fr)` } : undefined}
      >
        <FolderDetailPane
          task={visibleTitle === task.page.title ? task : { ...task, page: { ...task.page, title: visibleTitle } }}
          folderSections={folderSections}
          parentFolder={parentFolder}
          onOpenParent={onOpenParent}
          projectFolderId={projectFolderId}
          folders={folders}
          contextInvalidationKey={contextInvalidationKey}
          sessions={sessions}
          runSessionLoadStates={runSessionLoadStates}
          runHistoryTotal={runHistoryTotal}
          runHistoryHasMore={runHistoryHasMore}
          runHistoryLoading={runHistoryLoading}
          activeSessionId={activeSessionKey}
          markdownDocumentsRevision={markdownDocumentsRevision}
          focusRequest={focusRequest}
          onFocusRequestHandled={onFocusRequestHandled}
          onLoadMoreRuns={onLoadMoreRuns}
          sessionDefaults={sessionDefaults}
          folderMoveTargets={folderMoveTargets}
          folderInToday={folderInToday}
          onReturnToToday={onReturnToToday}
          onToggleFolderToday={onToggleFolderToday}
          onOpenBoard={() => {
            const state = useDashboardStore.getState();
            state.setActiveBoardDocument(null);
            state.setActiveCustomView(null);
            setBoardOpen(true);
          }}
          onOpenSession={onOpenSession}
          onRenameFolderTitle={async (title) => {
            const renamedTitle = await onRenameFolderTitle(title);
            setVisibleTitle(renamedTitle);
          }}
          onSaveDescription={onSaveDescription}

          onFolderBlocksChanged={onFolderBlocksChanged}
          onArchiveFolder={onArchiveFolder}
        />
        {chatOpen ? (
          <>
            {divider("상세와 채팅 너비 조절")}
            <section
              ref={chatSurfaceRef}
              className="v3-chat-pane border border-glass-border glass-strong glass-chrome lg-rim"
              data-liquid-glass-webgl={chatWebglActive ? "true" : undefined}
              aria-label="세션 채팅"
            >
              <SessionPanelHeader session={activeSession} streamActive={sessionStreamActive}
                connectionStatus={sessionConnectionStatus} reconnect={reconnectSession}/>
              {activeSession ? <V3SessionReviewBanner session={activeSession} onAcknowledged={onAcknowledgedReview} /> : null}
              <div className="v3-chat-content">
                {activeSession ? (
                  <ChatView chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} historyEnabled={historyEnabled} />
                ) : (
                  <div className="v3-chat-empty" data-testid="v3-chat-empty">
                    <span className="v3-emoji" aria-hidden="true">💬</span>
                    <strong>선택된 세션이 없습니다.</strong>
                    <p>폴더 탭에서 세션을 선택하거나 새 세션을 시작하세요.</p>
                    <button type="button" className="v3-button v3-button--soft" onClick={closeWorkspaceInspector}>폴더 탭으로</button>
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
