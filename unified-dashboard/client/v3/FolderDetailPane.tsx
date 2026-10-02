import { FolderCardSection } from "./FolderCardSection";
import { useEffect, useMemo, useRef, useState, type RefObject, type ReactNode } from "react";
import { Button, DashboardIconCap, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle, retainEqualValue, useGlassSurface, type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import { LayoutDashboard, MoreHorizontal, Star } from "lucide-react";

import type { PlannerFolder } from "./planner-data";
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
import { FolderPanelHeader } from "./WorkspacePanelHeaders";
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
  parentFolder,
  onOpenParent,
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
  onFolderBlocksChanged,
  placement = "overlay",
  scrollContainerRef,
  onArchiveFolder,
}: {
  task: PlannerFolder;
  folderSections: ReactNode;
  parentFolder: CatalogFolder | null;
  onOpenParent(folder: CatalogFolder): void;
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
  onFolderBlocksChanged(blocks: PlannerFolder["blocks"]): void;
  placement?: "inline" | "overlay";
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  onArchiveFolder?: () => Promise<void>;
}) {
  const inline = placement === "inline";
  const surfaceRef = useRef<HTMLElement>(null);
  const ownScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = scrollContainerRef ?? ownScrollRef;
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const informationSectionRef = useRef<HTMLElement>(null);
  const cardsSectionRef = useRef<HTMLElement>(null);
  const boardSectionRef = useRef<HTMLDivElement>(null);
  const sessionsSectionRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useMemo<FolderSectionRefs>(() => ({
    information: informationSectionRef,
    cards: cardsSectionRef,
    board: boardSectionRef,
    sessions: sessionsSectionRef,
  }), []);
  const webglActive = useGlassSurface(surfaceRef, { enabled: !inline });
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
      source: { folderId: task.folderId, folderName: "이 폴더", pageId: task.page.id },
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
        sourceLabel: "이 폴더",
        label: `${match[1]} · 이 폴더`,
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
  const backLabel = parentFolder ? "상위 폴더로 이동" : "오늘 플래너로 돌아가기";
  const goBack = () => parentFolder ? onOpenParent(parentFolder) : onReturnToToday();
  const actions = <>
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
    <DashboardIconCap label="폴더 보드 열기" onClick={onOpenBoard}>
      <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
    </DashboardIconCap>
    <DashboardIconCap label="폴더 메뉴" onClick={(event) => setFolderMenu({ x: event.clientX, y: event.clientY })}>
      <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
    </DashboardIconCap>
    <V3ContextMenu target={folderMenu} onClose={() => setFolderMenu(null)} actions={onArchiveFolder ? [{
      label: "폴더 보관",
      separatorBefore: true,
      destructive: true,
      onSelect: () => setArchiveOpen(true),
    }] : []} />
  </>;

  return (
    <article
      ref={surfaceRef}
      className={`v3-detail-pane${inline ? " v3-detail-pane--inline" : " border border-glass-border glass-strong glass-chrome lg-rim"}`}
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
    >
      <FolderPanelHeader title={task.page.title} onRename={onRenameFolderTitle} inline={inline}
        backLabel={backLabel} onBack={goBack} status={{value:task.status,icon:status.icon,label:status.label}} actions={actions}/>
      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>폴더 보관</DialogTitle>
            <DialogDescription>‘{task.page.title}’ 폴더를 보관합니다. 내용과 세션은 보존됩니다.</DialogDescription>
          </DialogHeader>
          {archiveError ? <p role="alert">폴더 보관 실패 · {archiveError}</p> : null}
          <DialogFooter variant="bare">
            <Button type="button" variant="outline" onClick={() => setArchiveOpen(false)}>취소</Button>
            <Button type="button" variant="destructive" onClick={() => {
              if (!onArchiveFolder) return;
              void onArchiveFolder().then(() => setArchiveOpen(false)).catch((error: unknown) => {
                setArchiveError(error instanceof Error ? error.message : String(error));
              });
            }}>보관</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <div ref={ownScrollRef} className="v3-detail-scroll">
        <div className="v3-task-detail-layout">
          <FolderSectionNavigation
            scrollRef={scrollRef}
            sectionRefs={sectionRefs}
            focusRequest={focusRequest}
            focusTargetReady={focusTargetReady}
            onFocusRequestHandled={onFocusRequestHandled}
          />
          <div className="v3-task-detail-content">
            <section ref={informationSectionRef} className="v3-detail-section" data-task-section="information">
              <div className="v3-detail-section-head"><h3>정보</h3></div>
              <FolderDescriptionPanel markdown={description} onSave={onSaveDescription} />
              {folderSections}
            </section>

            <section ref={cardsSectionRef} className="v3-detail-section" data-task-section="cards" data-testid="v3-folder-cards-section">
              <FolderCardSection folderId={task.folderId} folders={folders} placement={placement} />
            </section>

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
                onOpenSession={onOpenSession}

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
  return folderName === "이 폴더" ? folderName : `${folderName}에서 상속`;
}
