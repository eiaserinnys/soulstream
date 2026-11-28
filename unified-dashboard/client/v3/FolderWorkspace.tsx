import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
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
import { SessionFilesPane } from "./SessionFilesPanel";
import { useSessionFilesToggle } from "./use-session-files-toggle";
import { FolderDetailPane } from "./FolderDetailPane";
import type { FolderSectionFocusRequest } from "./FolderSectionNavigation";
import { V3SessionReviewBanner } from "./V3SessionReviewBanner";
import { SessionPanelHeader } from "./WorkspacePanelHeaders";
import type { MobilePlannerTab } from "./mobile-planner-state";
import { PersistentSessionChatView } from "./PersistentSessionChatView";

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
  runHistoryFailed = false,
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
  onReturnToToday,
  onCloseWorkspace,
  onCloseChat,
  onOpenSession,
  onRenameFolderTitle,
  onSaveDescription,
  onFolderBlocksChanged,
  onAcknowledgedReview,
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
  runHistoryFailed?: boolean;
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
  onReturnToToday(): void;
  onCloseWorkspace(): void;
  onCloseChat(): void;
  onOpenSession(session: SessionSummary): void;
  onRenameFolderTitle(title: string): Promise<string>;
  onSaveDescription(markdown: string): Promise<void>;
  onFolderBlocksChanged(blocks: PlannerFolder["blocks"]): void;
  onAcknowledgedReview(result: SessionReviewAcknowledgeResult): void;
  onArchiveFolder?: () => Promise<void>;
  markdownDocumentsRevision: number;
  onMarkdownDocumentEditorClosed(): void;
}) {
  const { t } = useTranslation();
  const files = useSessionFilesToggle();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const chatSurfaceRef = useRef<HTMLElement>(null);
  const draggingPointer = useRef<number | null>(null);
  const [splitPercent, setSplitPercent] = useState(DEFAULT_WORKSPACE_SPLIT);
  const [visibleTitle, setVisibleTitle] = useState(task?.page.title ?? "");
  const chatWebglActive = useGlassSurface(chatSurfaceRef, { enabled: chatOpen });
  const activeSessionKey = useDashboardStore((state) => state.activeSessionKey);
  const chatVisible = isFolderWorkspaceChatVisible({
    hasActiveSession: activeSession !== undefined,
    hasFolder: task !== null,
    chatOpen,
    mobileMode,
    mobileChatTab: mobileTab === "chat",
  });

  useEffect(() => {
    onChatVisibilityChange(chatVisible);
    return () => onChatVisibilityChange(false);
  }, [chatVisible, onChatVisibilityChange]);

  useEffect(() => {
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
          data-mobile-files={mobileMode && mobileTab === "chat" && files.open ? "true" : undefined}
          style={!mobileMode ? { gridTemplateColumns: `minmax(0, calc(${splitPercent}% - 8px)) 16px minmax(0, 1fr)` } : undefined}
        >
          <div className={files.open && activeSession ? "v3-files-detail-hidden" : "v3-files-detail-visible"}><section className="v3-detail-pane border border-glass-border glass-strong glass-chrome lg-rim" data-testid="v3-standalone-task-empty" aria-label={t("folders.workspace.emptyWindow")}>
            <header className="v3-workspace-toolbar">
              <strong>{t("folders.common.folder")}</strong>
              <span className="v3-spacer" />
              <DashboardIconCap label={t("folders.workspace.close")} onClick={onCloseWorkspace}>
                <X className="h-4 w-4" aria-hidden="true" />
              </DashboardIconCap>
            </header>
            <div className="v3-chat-empty">
              <strong>{folderResolutionError ?? t("folders.workspace.noFolder")}</strong>
              <p>{folderResolutionError
                ? t("folders.workspace.checkFolder")
                : t("folders.workspace.chatAvailable")}</p>
            </div>
          </section></div>
          {files.open && activeSession && <SessionFilesPane sessionId={activeSession.agentSessionId} onClose={files.close} scrollTop={files.readScroll(activeSession.agentSessionId)} onScroll={position=>files.saveScroll(activeSession.agentSessionId,position)} initiallyExpanded={files.readExpanded(activeSession.agentSessionId)} onExpandedChange={value=>files.saveExpanded(activeSession.agentSessionId,value)} initiallySessionOpen={files.readSection(activeSession.agentSessionId, "session")} initiallyOtherOpen={files.readSection(activeSession.agentSessionId, "other")} onSectionChange={(section,value)=>files.saveSection(activeSession.agentSessionId,section,value)}/>}
          {divider(t("folders.workspace.resizeFolder"))}
          <section
            ref={chatSurfaceRef}
            className="v3-chat-pane border border-glass-border glass-strong glass-chrome lg-rim"
            data-liquid-glass-webgl={chatWebglActive ? "true" : undefined}
            data-testid="v3-standalone-session-chat"
            aria-label={t("folders.workspace.sessionChat")}
          >
            <SessionPanelHeader session={activeSession} streamActive={sessionStreamActive}
                connectionStatus={sessionConnectionStatus} reconnect={reconnectSession} emptyTitle={t("folders.common.session")} filesOpen={files.open} onToggleFiles={files.toggle} onClose={onCloseWorkspace}/>
            {activeSession ? <V3SessionReviewBanner session={activeSession} onAcknowledged={onAcknowledgedReview} /> : null}
            <div className="v3-chat-content">
              {activeSession ? <PersistentSessionChatView sessionId={activeSession.agentSessionId} chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} historyEnabled={historyEnabled} /> : <div className="v3-chat-empty"><strong>{t("folders.workspace.missingSession")}</strong></div>}
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className={`v3-workspace-scrim${chatOpen ? " is-chat-open" : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCloseWorkspace(); }}>
      <div
        ref={workspaceRef}
        className={`v3-workspace${chatOpen ? " is-chat-open" : ""}`}
        data-mobile-view={mobileMode ? mobileTab : undefined}
          data-mobile-files={mobileMode && mobileTab === "chat" && files.open ? "true" : undefined}
        style={chatOpen && !mobileMode ? { gridTemplateColumns: `minmax(0, calc(${splitPercent}% - 8px)) 16px minmax(0, 1fr)` } : undefined}
      >
        <div className={files.open && activeSession && chatOpen ? "v3-files-detail-hidden" : "v3-files-detail-visible"}><FolderDetailPane
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
          runHistoryFailed={runHistoryFailed}
          activeSessionId={activeSessionKey}
          markdownDocumentsRevision={markdownDocumentsRevision}
          focusRequest={focusRequest}
          onFocusRequestHandled={onFocusRequestHandled}
          onLoadMoreRuns={onLoadMoreRuns}
          sessionDefaults={sessionDefaults}
          folderMoveTargets={folderMoveTargets}
          onReturnToToday={onReturnToToday}
          onOpenSession={onOpenSession}
          onRenameFolderTitle={async (title) => {
            const renamedTitle = await onRenameFolderTitle(title);
            setVisibleTitle(renamedTitle);
          }}
          onSaveDescription={onSaveDescription}

          onFolderBlocksChanged={onFolderBlocksChanged}
          onArchiveFolder={onArchiveFolder}
        /></div>
        {files.open && activeSession && chatOpen && <SessionFilesPane sessionId={activeSession.agentSessionId} onClose={files.close} scrollTop={files.readScroll(activeSession.agentSessionId)} onScroll={position=>files.saveScroll(activeSession.agentSessionId,position)} initiallyExpanded={files.readExpanded(activeSession.agentSessionId)} onExpandedChange={value=>files.saveExpanded(activeSession.agentSessionId,value)} initiallySessionOpen={files.readSection(activeSession.agentSessionId, "session")} initiallyOtherOpen={files.readSection(activeSession.agentSessionId, "other")} onSectionChange={(section,value)=>files.saveSection(activeSession.agentSessionId,section,value)}/>}
        {chatOpen ? (
          <>
            {divider(t("folders.workspace.resizeDetail"))}
            <section
              ref={chatSurfaceRef}
              className="v3-chat-pane border border-glass-border glass-strong glass-chrome lg-rim"
              data-liquid-glass-webgl={chatWebglActive ? "true" : undefined}
              aria-label={t("folders.workspace.sessionChat")}
            >
              <SessionPanelHeader session={activeSession} streamActive={sessionStreamActive}
                connectionStatus={sessionConnectionStatus} reconnect={reconnectSession} filesOpen={files.open} onToggleFiles={files.toggle}/>
              {activeSession ? <V3SessionReviewBanner session={activeSession} onAcknowledged={onAcknowledgedReview} /> : null}
              <div className="v3-chat-content">
                {activeSession ? (
                  <PersistentSessionChatView sessionId={activeSession.agentSessionId} chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} historyEnabled={historyEnabled} />
                ) : (
                  <div className="v3-chat-empty" data-testid="v3-chat-empty">
                    <span className="v3-emoji" aria-hidden="true">💬</span>
                    <strong>{t("folders.workspace.noSession")}</strong>
                    <p>{t("folders.workspace.selectSession")}</p>
                    <button type="button" className="v3-button v3-button--soft" onClick={closeWorkspaceInspector}>{t("folders.workspace.goFolderTab")}</button>
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
