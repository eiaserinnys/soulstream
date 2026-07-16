import { useEffect, useMemo, useRef, useState } from "react";
import { Button, retainEqualValue, useGlassSurface, type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";

import type { PlannerTask } from "./planner-data";
import type { TaskMoveTarget } from "./task-move-targets";
import { plannerStatusPresentation } from "./planner-model";
import { singleLinePreview } from "./session-preview";
import type { PageSessionDefaults } from "./task-workspace-api";
import {
  descriptionMarkdown,
  reconcileTaskSessions,
  type RunSessionLoadState,
} from "./task-workspace-model";
import { TaskDescriptionPanel } from "./TaskDescriptionPanel";
import { TaskContextPicker } from "./TaskContextPicker";
import { TaskInlineBoard } from "./TaskInlineBoard";
import { TaskRunHistory } from "./TaskRunHistory";
import { TaskTitleEditor } from "./TaskTitleEditor";
import { TaskTodayToggle } from "./TaskTodayToggle";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";
import { buildDocumentContextMenuActions } from "./context-menu-model";
import "./v3-context-succession.css";
import { useTaskStar } from "./use-task-star";
import {
  buildPageContextSourcesMarker,
  mergeProjectContextPages,
} from "./project-context-inheritance";
import { parseProjectPageDetails } from "./project-page-details";
import { useProjectContextInheritance } from "./use-project-context-inheritance";

export function TaskDetailPane({
  task,
  projectFolderId,
  folders,
  contextInvalidationKey,
  sessions,
  runSessionLoadStates,
  runHistoryTotal,
  runHistoryHasMore,
  runHistoryLoading,
  onLoadMoreRuns,
  sessionDefaults,
  onReturnToToday,
  taskInToday,
  onToggleTaskToday,
  onOpenBoard,
  onCloseWorkspace,
  onOpenDocument,
  taskMoveTargets,
  onOpenSession,
  onRenameTaskTitle,
  onSaveDescription,
  onPromoteDocument,
  onUnmountDocument,
  onRenameSession,
  onDeleteSessions,
  onMoveSession,
  onTaskBlocksChanged,
}: {
  task: PlannerTask;
  projectFolderId: string | null;
  folders: readonly CatalogFolder[];
  contextInvalidationKey: number;
  sessions: readonly SessionSummary[];
  runSessionLoadStates: ReadonlyMap<string, RunSessionLoadState>;
  runHistoryTotal: number;
  runHistoryHasMore: boolean;
  runHistoryLoading: boolean;
  onLoadMoreRuns(): void;
  sessionDefaults: PageSessionDefaults | null;
  onReturnToToday(): void;
  taskInToday: boolean;
  onToggleTaskToday(): Promise<void>;
  onOpenBoard(): void;
  onCloseWorkspace(): void;
  onOpenDocument(documentId: string): void;
  taskMoveTargets: readonly PlannerTask[];
  onOpenSession(session: SessionSummary): void;
  onRenameTaskTitle(title: string): Promise<void>;
  onSaveDescription(markdown: string): Promise<void>;
  onPromoteDocument(blockId: string): Promise<void>;
  onUnmountDocument(blockId: string): Promise<void>;
  onRenameSession(sessionId: string, displayName: string | null): Promise<void>;
  onDeleteSessions(sessionIds: string[]): Promise<void>;
  onMoveSession(sessionId: string, targetTask: TaskMoveTarget): Promise<void>;
  onTaskBlocksChanged(blocks: PlannerTask["blocks"]): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });
  const description = useMemo(
    () => descriptionMarkdown(task.page, task.blocks),
    [task.blocks, task.page],
  );
  const status = plannerStatusPresentation(task.status);
  const taskStar = useTaskStar(task.page);
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [documentMenu, setDocumentMenu] = useState<{ target: V3ContextMenuTarget; blockId: string; pageId: string } | null>(null);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [documentPickerOpen, setDocumentPickerOpen] = useState(false);
  const [contextBlocks, setContextBlocks] = useState(task.blocks);
  const [createdSessions, setCreatedSessions] = useState<SessionSummary[]>([]);
  const reconciledSessionsRef = useRef<ReturnType<typeof reconcileTaskSessions> | null>(null);
  const inheritedContext = useProjectContextInheritance({
    folderId: projectFolderId ?? "",
    folders,
    invalidationKey: contextInvalidationKey,
  });
  useEffect(() => {
    setContextBlocks(task.blocks);
    setContextPickerOpen(false);
    setDocumentPickerOpen(false);
    setCreatedSessions([]);
    setDocumentMenu(null);
  }, [task.blocks, task.page.id]);
  const effectiveContext = useMemo(() => mergeProjectContextPages([
    ...(inheritedContext.status === "ready" ? inheritedContext.data.pages : []),
    {
      source: { folderId: task.page.id, folderName: "이 업무", pageId: task.page.id },
      details: parseProjectPageDetails(contextBlocks),
    },
  ]), [contextBlocks, inheritedContext, task.page.id]);
  const contextItems = useMemo(() => [
    ...effectiveContext.guidance.map((guidance) => ({
      id: `${guidance.source.pageId}:${guidance.blockId}`,
      icon: "✦",
      label: `${singleLinePreview(guidance.text, 96) ?? guidance.text} · ${contextSourceLabel(
        guidance.source.folderName,
      )}`,
    })),
    ...effectiveContext.atomReferences.map((reference) => ({
      id: `${reference.source.pageId}:${reference.blockId}`,
      icon: "⚛",
      label: `${reference.nodeTitle} · ${contextSourceLabel(reference.source.folderName)}`,
    })),
    ...contextBlocks.flatMap((block) => {
      const match = /^\[\[([^\[\]]+)\]\]$/.exec(block.text.trim());
      return match ? [{ id: block.id, icon: "📄", label: match[1] }] : [];
    }),
  ], [contextBlocks, effectiveContext]);
  const inheritedDefaults = effectiveContext.sessionDefaults.at(-1);
  const effectiveSessionDefaults = inheritedDefaults ? {
    agentId: inheritedDefaults.agentId,
    nodeId: inheritedDefaults.nodeId,
    sourcePageId: inheritedDefaults.source.pageId,
    sourceBlockId: inheritedDefaults.blockId,
  } : sessionDefaults;
  const pageContextSources = buildPageContextSourcesMarker(
    inheritedContext.status === "ready"
      ? inheritedContext.data
      : mergeProjectContextPages([]),
    task.page.id,
  );
  const reconciledSessions = useMemo(() => {
    const next = reconcileTaskSessions({
      serverSessionIds: task.sessionIds,
      serverSessions: sessions,
      optimisticSessions: createdSessions,
    });
    reconciledSessionsRef.current = retainEqualValue(reconciledSessionsRef.current ?? undefined, next);
    return reconciledSessionsRef.current;
  }, [createdSessions, sessions, task.sessionIds]);
  const allSessions = reconciledSessions.sessions;
  const allSessionIds = reconciledSessions.sessionIds;

  const promote = async (blockId: string) => {
    setPromotingId(blockId);
    try {
      await onPromoteDocument(blockId);
    } finally {
      setPromotingId(null);
    }
  };

  return (
    <article
      ref={surfaceRef}
      className="v3-detail-pane border border-glass-border glass-strong glass-chrome lg-rim"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
    >
      <header className="v3-workspace-toolbar">
        <button type="button" className="v3-workspace-back" onClick={onReturnToToday}>← 오늘로</button>
        <span className="v3-spacer" />
        <Button
          variant="ghost"
          className="v3-task-detail-star"
          aria-pressed={taskStar.starred}
          disabled={taskStar.pending}
          title={taskStar.error ?? undefined}
          onClick={() => { void taskStar.toggle(); }}
        >
          {taskStar.starred ? "★ 별표됨" : "☆ 별표하기"}
        </Button>
        <TaskTodayToggle inToday={taskInToday} onToggle={onToggleTaskToday} />
        <button type="button" className="v3-button v3-button--soft" onClick={onOpenBoard}>▦ 보드</button>
        <button type="button" className="v3-workspace-close" aria-label="업무 상세 닫기" onClick={onCloseWorkspace}>×</button>
      </header>
      <div className="v3-detail-scroll">
        <div className="v3-detail-title">
          <span className={`v3-status-chip v3-status-chip--${task.status}`}>{status.icon} {status.label}</span>
          <TaskTitleEditor title={task.page.title} onRename={onRenameTaskTitle} />
        </div>

        <section className="v3-detail-section">
          <div className="v3-detail-section-head"><h3>설명</h3><span>마크다운</span></div>
          <TaskDescriptionPanel markdown={description} onSave={onSaveDescription} />
        </section>

        <section className="v3-detail-section">
          <div className="v3-detail-section-head"><h3>컨텍스트</h3><span>{contextItems.length}개</span></div>
          <div className="v3-context-chips">
            {contextItems.map((context) => <span key={context.id}><span className="v3-emoji" aria-hidden="true">{context.icon}</span> {context.label}</span>)}
            {contextItems.length === 0 ? <small>연결된 컨텍스트가 없습니다.</small> : null}
            <button type="button" className="v3-context-add" aria-expanded={contextPickerOpen} onClick={() => { setDocumentPickerOpen(false); setContextPickerOpen((value) => !value); }}>＋ 컨텍스트</button>
          </div>
          {contextPickerOpen ? (
            <TaskContextPicker
              taskPageId={task.page.id}
              taskBlocks={contextBlocks}
              onBlocksChanged={(blocks) => { setContextBlocks(blocks); onTaskBlocksChanged(blocks); }}
              onClose={() => setContextPickerOpen(false)}
            />
          ) : null}
        </section>

        <section className="v3-detail-section">
          <div className="v3-detail-section-head">
            <h3><span className="v3-emoji" aria-hidden="true">📄</span> 문서</h3><span>{task.mountedDocuments.length}개</span>
            <span className="v3-spacer" />
            <Button
              size="xs"
              variant="glass"
              className="h-7 rounded-full px-2.5 text-xs sm:h-7"
              aria-expanded={documentPickerOpen}
              onClick={() => { setContextPickerOpen(false); setDocumentPickerOpen((value) => !value); }}
            >
              ＋ 문서
            </Button>
          </div>
          <div className="v3-task-documents">
            {task.mountedDocuments.map((document) => (
              <div
                key={document.blockId}
                data-testid={`v3-mounted-document-${document.page.id}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setDocumentMenu({
                    target: { x: event.clientX, y: event.clientY },
                    blockId: document.blockId,
                    pageId: document.page.id,
                  });
                }}
              >
                <span>{document.page.title}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!task.projectPageId || promotingId === document.blockId}
                  title={task.projectPageId ? "업무의 문서 마운트를 프로젝트 페이지로 이동합니다" : "프로젝트에 속한 업무만 승격할 수 있습니다"}
                  onClick={() => { void promote(document.blockId); }}
                >
                  {promotingId === document.blockId ? "승격 중…" : "프로젝트로 승격"}
                </Button>
              </div>
            ))}
            {task.mountedDocuments.length === 0 ? <p className="v3-detail-empty">마운트된 문서가 없습니다.</p> : null}
          </div>
          {documentPickerOpen ? (
            <TaskContextPicker
              mode="document"
              taskPageId={task.page.id}
              taskBlocks={contextBlocks}
              onBlocksChanged={(blocks) => { setContextBlocks(blocks); onTaskBlocksChanged(blocks); }}
              onClose={() => setDocumentPickerOpen(false)}
            />
          ) : null}
        </section>

        <V3ContextMenu
          target={documentMenu?.target ?? null}
          onClose={() => setDocumentMenu(null)}
          actions={documentMenu ? buildDocumentContextMenuActions({
            open: () => onOpenDocument(documentMenu.pageId),
            copyId: () => navigator.clipboard.writeText(documentMenu.pageId),
            unmount: () => onUnmountDocument(documentMenu.blockId),
            promote: () => promote(documentMenu.blockId),
            canPromote: Boolean(task.projectPageId),
          }) : []}
        />

        <TaskInlineBoard runbookId={task.runbookId} />

        {effectiveSessionDefaults?.agentId || effectiveSessionDefaults?.nodeId ? (
          <div className="v3-session-defaults"><span className="v3-emoji" aria-hidden="true">👤</span> 기본값: {effectiveSessionDefaults.agentId ?? "agent 미지정"}@{effectiveSessionDefaults.nodeId ?? "node 미지정"} <span>(상속)</span></div>
        ) : null}

        <TaskRunHistory
          taskTitle={task.page.title}
          taskPageId={task.page.id}
          runbookId={task.runbookId}
          contextItems={contextItems}
          documentOptions={task.mountedDocuments.map((document) => ({
            pageId: document.page.id,
            title: document.page.title,
          }))}
          pageContextSources={pageContextSources}
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
          onLoadMoreRuns={onLoadMoreRuns}
          moveTargets={taskMoveTargets}
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
    </article>
  );
}

function contextSourceLabel(folderName: string): string {
  return folderName === "이 업무" ? folderName : `${folderName}에서 상속`;
}
