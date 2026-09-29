import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DashboardIconCap, FolderChecklistCard, retainEqualValue, useGlassSurface, type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import { ArrowLeft, LayoutDashboard, MoreHorizontal, Star } from "lucide-react";

import type { PlannerFolder } from "./planner-data";
import type { FolderMoveTarget } from "./folder-move-targets";
import { plannerStatusPresentation } from "./planner-model";
import { singleLinePreview } from "./session-preview";
import type { PageSessionDefaults } from "./folder-workspace-page-api";
import {
  descriptionMarkdown,
  reconcileFolderSessions,
  type RunSessionLoadState,
} from "./folder-workspace-run-model";
import { FolderDescriptionPanel } from "./FolderDescriptionPanel";
import { FolderInlineBoard } from "./FolderInlineBoard";
import { FolderSessionHistory } from "./FolderSessionHistory";
import {
  FolderSectionNavigation,
  type FolderSectionFocusRequest,
  type FolderSectionRefs,
} from "./FolderSectionNavigation";
import { FolderTitleEditor } from "./FolderTitleEditor";
import { FolderTodayToggle } from "./FolderTodayToggle";
import "./v3-context-succession.css";
import { useFolderStar } from "./use-folder-star";
import {
  mergeProjectContextPages,
} from "./project-context-inheritance";
import { parseProjectPageDetails } from "./project-page-details";
import { useProjectContextInheritance } from "./use-project-context-inheritance";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";

export function FolderDetailPane({
  task,
  folderSections,
  checklistEnabled,
  parentFolder,
  onOpenParent,
  onToggleChecklist,
  projectFolderId,
  folders,
  contextInvalidationKey,
  sessions,
  runSessionLoadStates,
  runHistoryTotal,
  runHistoryHasMore,
  runHistoryLoading,
  activeSessionId,
  markdownDocumentsRevision,
  focusRequest,
  onFocusRequestHandled,
  onLoadMoreRuns,
  sessionDefaults,
  onReturnToToday,
  folderInToday,
  onToggleFolderToday,
  onOpenBoard,
  folderMoveTargets,
  onOpenSession,
  onRenameFolderTitle,
  onSaveDescription,
  onRenameSession,
  onDeleteSessions,
  onMoveSession,
  onFolderBlocksChanged,
}: {
  task: PlannerFolder;
  folderSections: ReactNode;
  checklistEnabled: boolean;
  parentFolder: CatalogFolder | null;
  onOpenParent(folder: CatalogFolder): void;
  onToggleChecklist(enabled: boolean): Promise<void>;
  projectFolderId: string | null;
  folders: readonly CatalogFolder[];
  contextInvalidationKey: number;
  sessions: readonly SessionSummary[];
  runSessionLoadStates: ReadonlyMap<string, RunSessionLoadState>;
  runHistoryTotal: number;
  runHistoryHasMore: boolean;
  runHistoryLoading: boolean;
  activeSessionId: string | null;
  markdownDocumentsRevision: number;
  focusRequest: FolderSectionFocusRequest | null;
  onFocusRequestHandled(requestId: number): void;
  onLoadMoreRuns(): Promise<void>;
  sessionDefaults: PageSessionDefaults | null;
  onReturnToToday(): void;
  folderInToday: boolean;
  onToggleFolderToday(): Promise<void>;
  onOpenBoard(): void;
  folderMoveTargets: readonly PlannerFolder[];
  onOpenSession(session: SessionSummary): void;
  onRenameFolderTitle(title: string): Promise<void>;
  onSaveDescription(markdown: string): Promise<void>;
  onRenameSession(sessionId: string, displayName: string | null): Promise<void>;
  onDeleteSessions(sessionIds: string[]): Promise<void>;
  onMoveSession(sessionId: string, targetTask: FolderMoveTarget): Promise<void>;
  onFolderBlocksChanged(blocks: PlannerFolder["blocks"]): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const informationSectionRef = useRef<HTMLElement>(null);
  const checklistSectionRef = useRef<HTMLElement>(null);
  const boardSectionRef = useRef<HTMLDivElement>(null);
  const sessionsSectionRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useMemo<FolderSectionRefs>(() => ({
    information: informationSectionRef,
    checklist: checklistSectionRef,
    board: boardSectionRef,
    sessions: sessionsSectionRef,
  }), []);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });
  const description = useMemo(
    () => descriptionMarkdown(task.page, task.blocks),
    [task.blocks, task.page],
  );
  const status = plannerStatusPresentation(task.status);
  const folderStar = useFolderStar(task.page);
  const api = useMemo(() => createPageApiClient(), []);
  const [folderMenu, setFolderMenu] = useState<V3ContextMenuTarget | null>(null);
  const [contextBlocks, setContextBlocks] = useState(task.blocks);
  const [boardDocuments, setBoardDocuments] = useState<Array<{ pageId: string; title: string }>>([]);
  const [createdSessions, setCreatedSessions] = useState<SessionSummary[]>([]);
  const reconciledSessionsRef = useRef<ReturnType<typeof reconcileFolderSessions> | null>(null);
  const inheritedContext = useProjectContextInheritance({
    folderId: parentFolder?.id ?? "",
    folders,
    invalidationKey: contextInvalidationKey,
  });
  useEffect(() => {
    setContextBlocks(task.blocks);
    setCreatedSessions([]);
  }, [task.blocks, task.page.id]);
  useEffect(() => setBoardDocuments([]), [task.page.id]);
  const folderContext = useMemo(
    () => parseProjectPageDetails(contextBlocks),
    [contextBlocks],
  );
  const effectiveContext = useMemo(() => mergeProjectContextPages([
    ...(inheritedContext.status === "ready" ? inheritedContext.data.pages : []),
    {
      source: { folderId: task.folderId, folderName: "이 업무", pageId: task.page.id },
      details: folderContext,
    },
  ]), [inheritedContext, task.page.id, folderContext]);
  const contextItems = useMemo(() => [
    ...effectiveContext.guidance.map((guidance) => ({
      id: `${guidance.source.pageId}:${guidance.blockId}`,
      kind: "guidance" as const,
      blockId: guidance.blockId,
      direct: guidance.source.pageId === task.page.id,
      icon: "✦",
      contentLabel: singleLinePreview(guidance.text, 96) ?? guidance.text,
      sourceLabel: contextSourceLabel(guidance.source.folderName),
      label: `${singleLinePreview(guidance.text, 96) ?? guidance.text} · ${contextSourceLabel(guidance.source.folderName)}`,
    })),
    ...effectiveContext.atomReferences.map((reference) => ({
      id: `${reference.source.pageId}:${reference.blockId}`,
      kind: "atom" as const,
      blockId: reference.blockId,
      direct: reference.source.pageId === task.page.id,
      reference,
      icon: "⚛",
      contentLabel: reference.nodeTitle,
      sourceLabel: contextSourceLabel(reference.source.folderName),
      label: `${reference.nodeTitle} · ${contextSourceLabel(reference.source.folderName)}`,
    })),
    ...contextBlocks.flatMap((block) => {
      const match = /^\[\[([^\[\]]+)\]\]$/.exec(block.text.trim());
      return match ? [{
        id: block.id,
        kind: "page" as const,
        blockId: block.id,
        direct: true,
        icon: "📄",
        contentLabel: match[1],
        sourceLabel: "이 업무",
        label: `${match[1]} · 이 업무`,
      }] : [];
    }),
  ], [contextBlocks, effectiveContext]);
  const sourcedDefaults = effectiveContext.sessionDefaults.at(-1);
  const effectiveSessionDefaults = sourcedDefaults ? {
    agentId: sourcedDefaults.agentId,
    nodeId: sourcedDefaults.nodeId,
    modelPreset: sourcedDefaults.modelPreset,
    sourcePageId: sourcedDefaults.source.pageId,
    sourceBlockId: sourcedDefaults.blockId,
  } : sessionDefaults;
  const reconciledSessions = useMemo(() => {
    const next = reconcileFolderSessions({
      serverSessionIds: task.sessionIds,
      serverSessions: sessions,
      optimisticSessions: createdSessions,
    });
    reconciledSessionsRef.current = retainEqualValue(reconciledSessionsRef.current ?? undefined, next);
    return reconciledSessionsRef.current;
  }, [createdSessions, sessions, task.sessionIds]);
  const allSessions = reconciledSessions.sessions;
  const allSessionIds = reconciledSessions.sessionIds;
  const focusTargetReady = !focusRequest?.sessionId || (
    allSessions.some((session) => session.agentSessionId === focusRequest.sessionId)
      && runSessionLoadStates.get(focusRequest.sessionId) === "ready"
  );
  const folderStarLabel = `별표 ${folderStar.starred ? "해제" : "추가"}`;

  return (
    <article
      ref={surfaceRef}
      className="v3-detail-pane border border-glass-border glass-strong glass-chrome lg-rim"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
    >
      <header className="v3-workspace-toolbar">
        <DashboardIconCap label={parentFolder ? "상위 폴더로 이동" : "오늘 플래너로 돌아가기"} onClick={() => parentFolder ? onOpenParent(parentFolder) : onReturnToToday()}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
        <span className="v3-spacer" />
        <DashboardIconCap
          className="v3-task-detail-star"
          label={folderStarLabel}
          aria-pressed={folderStar.starred}
          disabled={folderStar.pending}
          tooltip={folderStar.error ? `${folderStarLabel} — ${folderStar.error}` : undefined}
          onClick={() => { void folderStar.toggle(); }}
        >
          <Star className="h-4 w-4" fill={folderStar.starred ? "currentColor" : "none"} aria-hidden="true" />
        </DashboardIconCap>
        <FolderTodayToggle inToday={folderInToday} onToggle={onToggleFolderToday} />
        <DashboardIconCap label="업무 보드 열기" onClick={onOpenBoard}>
          <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
        <DashboardIconCap label="폴더 메뉴" onClick={(event) => setFolderMenu({ x: event.clientX, y: event.clientY })}>
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
        <V3ContextMenu target={folderMenu} onClose={() => setFolderMenu(null)} actions={[{
          label: checklistEnabled ? "체크리스트 숨기기" : "체크리스트 보이기",
          onSelect: () => onToggleChecklist(!checklistEnabled),
        }]} />
      </header>
      <div ref={scrollRef} className="v3-detail-scroll">
        <div className="v3-task-detail-layout">
          <FolderSectionNavigation
            scrollRef={scrollRef}
            sectionRefs={sectionRefs}
            checklistEnabled={checklistEnabled}
            focusRequest={focusRequest}
            focusTargetReady={focusTargetReady}
            onFocusRequestHandled={onFocusRequestHandled}
          />
          <div className="v3-task-detail-content">
            <div className="v3-detail-title">
              {checklistEnabled ? <span className={`v3-status-chip v3-status-chip--${task.status}`}>{status.icon} {status.label}</span> : null}
              <FolderTitleEditor title={task.page.title} onRename={onRenameFolderTitle} />
            </div>

            <section ref={informationSectionRef} className="v3-detail-section" data-task-section="information">
              <div className="v3-detail-section-head"><h3>정보</h3></div>
              <FolderDescriptionPanel markdown={description} onSave={onSaveDescription} />
              {folderSections}
            </section>

            {checklistEnabled ? <section ref={checklistSectionRef} className="v3-detail-section" data-task-section="checklist" data-testid="v3-task-checklist">
              <div className="v3-detail-section-head"><h3>체크리스트</h3><span>업무</span></div>
              <div className="v3-task-checklist">
                <FolderChecklistCard
                  folderId={task.folderId}
                  fallbackTitle={task.page.title}
                  editable
                  textSize="session"
                />
              </div>
            </section> : null}

            <div ref={boardSectionRef} data-task-section="board">
              <FolderInlineBoard
                folderId={task.folderId}
                api={api}
                folderMoveTargets={folderMoveTargets}
                markdownDocumentsRevision={markdownDocumentsRevision}
                onMarkdownDocumentsChanged={setBoardDocuments}
              />
            </div>

            <div ref={sessionsSectionRef} data-task-section="sessions">
              <FolderSessionHistory
                folderTitle={task.page.title}
                folderPageId={task.page.id}
                folderId={task.folderId}
                contextItems={contextItems}
                documentOptions={boardDocuments}
                contextPending={inheritedContext.status === "loading"}
                sessionDefaults={effectiveSessionDefaults}
                sessionIds={allSessionIds}
                sessions={allSessions}
                runSessionLoadStates={runSessionLoadStates}
                runHistoryTotal={Math.max(
                  runHistoryTotal + reconciledSessions.optimisticOnlyCount,
                  allSessionIds.length,
                )}
                runHistoryHasMore={runHistoryHasMore}
                runHistoryLoading={runHistoryLoading}
                activeSessionId={activeSessionId}
                onLoadMoreRuns={onLoadMoreRuns}
                moveTargets={folderMoveTargets}
                onOpenSession={onOpenSession}
                onRenameSession={onRenameSession}
                onDeleteSessions={onDeleteSessions}
                onMoveSession={onMoveSession}
                onSessionCreated={(session) => {
                  setCreatedSessions((current) => [
                    ...current.filter((candidate) => candidate.agentSessionId !== session.agentSessionId),
                    session,
                  ]);
                  onOpenSession(session);
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function contextSourceLabel(folderName: string): string {
  return folderName === "이 업무" ? folderName : `${folderName}에서 상속`;
}
