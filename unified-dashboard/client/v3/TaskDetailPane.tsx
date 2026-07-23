import { useEffect, useMemo, useRef, useState } from "react";
import { DashboardIconCap, TaskCard, retainEqualValue, useGlassSurface, type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import { ArrowLeft, LayoutDashboard, Plus, Star, Trash2, X } from "lucide-react";

import type { PlannerTask } from "./planner-data";
import type { TaskMoveTarget } from "./task-move-targets";
import { plannerStatusPresentation } from "./planner-model";
import { singleLinePreview } from "./session-preview";
import {
  saveTaskSessionDefaults,
  type PageSessionDefaults,
} from "./task-workspace-api";
import {
  descriptionMarkdown,
  reconcileTaskSessions,
  type RunSessionLoadState,
} from "./task-workspace-model";
import { TaskDescriptionPanel } from "./TaskDescriptionPanel";
import { TaskContextPicker } from "./TaskContextPicker";
import { TaskDefaultAssignment } from "./TaskDefaultAssignment";
import { TaskInlineBoard } from "./TaskInlineBoard";
import { TaskRunHistory } from "./TaskRunHistory";
import {
  TaskSectionNavigation,
  type TaskSectionFocusRequest,
  type TaskSectionRefs,
} from "./TaskSectionNavigation";
import { TaskTitleEditor } from "./TaskTitleEditor";
import { TaskTodayToggle } from "./TaskTodayToggle";
import "./v3-context-succession.css";
import { useTaskStar } from "./use-task-star";
import {
  buildPageContextSourcesMarker,
  mergeProjectContextPages,
} from "./project-context-inheritance";
import { parseProjectPageDetails } from "./project-page-details";
import {
  deletePageContextBlock,
  savePageAtomReference,
} from "./project-context-actions";
import {
  deleteOptimisticTaskContextBlock,
  updateOptimisticTaskAtomReference,
} from "./task-context-row-model";
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
  activeSessionId,
  focusRequest,
  onFocusRequestHandled,
  onLoadMoreRuns,
  sessionDefaults,
  onReturnToToday,
  taskInToday,
  onToggleTaskToday,
  onOpenBoard,
  taskMoveTargets,
  onOpenSession,
  onRenameTaskTitle,
  onSaveDescription,
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
  activeSessionId: string | null;
  focusRequest: TaskSectionFocusRequest | null;
  onFocusRequestHandled(requestId: number): void;
  onLoadMoreRuns(): Promise<void>;
  sessionDefaults: PageSessionDefaults | null;
  onReturnToToday(): void;
  taskInToday: boolean;
  onToggleTaskToday(): Promise<void>;
  onOpenBoard(): void;
  taskMoveTargets: readonly PlannerTask[];
  onOpenSession(session: SessionSummary): void;
  onRenameTaskTitle(title: string): Promise<void>;
  onSaveDescription(markdown: string): Promise<void>;
  onRenameSession(sessionId: string, displayName: string | null): Promise<void>;
  onDeleteSessions(sessionIds: string[]): Promise<void>;
  onMoveSession(sessionId: string, targetTask: TaskMoveTarget): Promise<void>;
  onTaskBlocksChanged(blocks: PlannerTask["blocks"]): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const informationSectionRef = useRef<HTMLElement>(null);
  const checklistSectionRef = useRef<HTMLElement>(null);
  const boardSectionRef = useRef<HTMLDivElement>(null);
  const sessionsSectionRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useMemo<TaskSectionRefs>(() => ({
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
  const taskStar = useTaskStar(task.page);
  const api = useMemo(() => createPageApiClient(), []);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [contextBlocks, setContextBlocks] = useState(task.blocks);
  const [contextMutationBlockId, setContextMutationBlockId] = useState<string | null>(null);
  const [contextMutationError, setContextMutationError] = useState<string | null>(null);
  const [boardDocuments, setBoardDocuments] = useState<Array<{ pageId: string; title: string }>>([]);
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
    setContextMutationBlockId(null);
    setContextMutationError(null);
    setCreatedSessions([]);
  }, [task.blocks, task.page.id]);
  useEffect(() => setBoardDocuments([]), [task.page.id]);
  const taskContext = useMemo(
    () => parseProjectPageDetails(contextBlocks),
    [contextBlocks],
  );
  const effectiveContext = useMemo(() => mergeProjectContextPages([
    ...(inheritedContext.status === "ready" ? inheritedContext.data.pages : []),
    {
      source: { folderId: task.page.id, folderName: "이 업무", pageId: task.page.id },
      details: taskContext,
    },
  ]), [inheritedContext, task.page.id, taskContext]);
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
  const directDefaults = taskContext.sessionDefaults.at(-1) ?? null;
  const sourcedDefaults = effectiveContext.sessionDefaults.at(-1);
  const effectiveSessionDefaults = sourcedDefaults ? {
    agentId: sourcedDefaults.agentId,
    nodeId: sourcedDefaults.nodeId,
    sourcePageId: sourcedDefaults.source.pageId,
    sourceBlockId: sourcedDefaults.blockId,
  } : sessionDefaults;
  const assignmentSourceLabel = sourcedDefaults
    ? (sourcedDefaults.source.pageId === task.page.id
        ? "직접 지정"
        : `${sourcedDefaults.source.folderName}에서 상속`)
    : fallbackAssignmentSource(sessionDefaults, task.page.id, folders);
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
  const focusTargetReady = !focusRequest?.sessionId || (
    allSessions.some((session) => session.agentSessionId === focusRequest.sessionId)
      && runSessionLoadStates.get(focusRequest.sessionId) === "ready"
  );
  const taskStarLabel = `별표 ${taskStar.starred ? "해제" : "추가"}`;
  const saveDefaultAssignment = async (value: { agentId: string; nodeId: string }) => {
    const result = await saveTaskSessionDefaults(api, task.page.id, {
      blockId: directDefaults?.blockId ?? null,
      agentId: value.agentId || null,
      nodeId: value.nodeId || null,
    });
    setContextBlocks(result.blocks);
    onTaskBlocksChanged(result.blocks);
  };
  const applyContextBlocks = (blocks: PlannerTask["blocks"]) => {
    setContextBlocks(blocks);
    onTaskBlocksChanged(blocks);
  };
  const updateAtomContext = async (
    blockId: string,
    reference: (typeof effectiveContext.atomReferences)[number],
    depth: number,
    titlesOnly: boolean,
  ) => {
    const previous = contextBlocks;
    const optimistic = updateOptimisticTaskAtomReference(previous, blockId, { depth, titlesOnly });
    applyContextBlocks(optimistic);
    setContextMutationBlockId(blockId);
    setContextMutationError(null);
    try {
      const result = await savePageAtomReference(api, task.page.id, {
        blockId,
        instance: reference.instance,
        nodeId: reference.nodeId,
        nodeTitle: reference.nodeTitle,
        depth,
        titlesOnly,
      });
      applyContextBlocks(result.blocks);
    } catch (cause) {
      applyContextBlocks(previous);
      setContextMutationError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setContextMutationBlockId(null);
    }
  };
  const removeContextBlock = async (blockId: string) => {
    const previous = contextBlocks;
    applyContextBlocks(deleteOptimisticTaskContextBlock(previous, blockId));
    setContextMutationBlockId(blockId);
    setContextMutationError(null);
    try {
      const result = await deletePageContextBlock(api, task.page.id, blockId);
      applyContextBlocks(result.blocks);
    } catch (cause) {
      applyContextBlocks(previous);
      setContextMutationError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setContextMutationBlockId(null);
    }
  };

  return (
    <article
      ref={surfaceRef}
      className="v3-detail-pane border border-glass-border glass-strong glass-chrome lg-rim"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
    >
      <header className="v3-workspace-toolbar">
        <DashboardIconCap label="오늘 플래너로 돌아가기" onClick={onReturnToToday}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
        <span className="v3-spacer" />
        <DashboardIconCap
          className="v3-task-detail-star"
          label={taskStarLabel}
          aria-pressed={taskStar.starred}
          disabled={taskStar.pending}
          tooltip={taskStar.error ? `${taskStarLabel} — ${taskStar.error}` : undefined}
          onClick={() => { void taskStar.toggle(); }}
        >
          <Star className="h-4 w-4" fill={taskStar.starred ? "currentColor" : "none"} aria-hidden="true" />
        </DashboardIconCap>
        <TaskTodayToggle inToday={taskInToday} onToggle={onToggleTaskToday} />
        <DashboardIconCap label="업무 보드 열기" onClick={onOpenBoard}>
          <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </header>
      <div ref={scrollRef} className="v3-detail-scroll">
        <div className="v3-task-detail-layout">
          <TaskSectionNavigation
            scrollRef={scrollRef}
            sectionRefs={sectionRefs}
            focusRequest={focusRequest}
            focusTargetReady={focusTargetReady}
            onFocusRequestHandled={onFocusRequestHandled}
          />
          <div className="v3-task-detail-content">
            <div className="v3-detail-title">
              <span className={`v3-status-chip v3-status-chip--${task.status}`}>{status.icon} {status.label}</span>
              <TaskTitleEditor title={task.page.title} onRename={onRenameTaskTitle} />
            </div>

            <section ref={informationSectionRef} className="v3-detail-section" data-task-section="information">
              <div className="v3-detail-section-head"><h3>정보</h3></div>
              <TaskDescriptionPanel markdown={description} onSave={onSaveDescription} />
              <div className="v3-information-context-head"><strong>컨텍스트</strong></div>
              <div className="v3-context-rows">
                {contextItems.map((context) => (
                  <div key={context.id} className="v3-context-row" title={context.label} data-testid={`task-context-${context.blockId}`}>
                    <span className="v3-emoji" aria-hidden="true">{context.icon}</span>
                    <span className="v3-context-row-copy"><strong>{context.contentLabel}</strong><small>{context.sourceLabel}</small></span>
                    {context.kind === "atom" ? (
                      context.direct ? <span className="v3-context-row-controls">
                        <label>depth <select aria-label={`${context.contentLabel} atom depth`} value={context.reference.depth ?? 3} disabled={contextMutationBlockId === context.blockId} onChange={(event) => { void updateAtomContext(context.blockId, context.reference, Number(event.target.value), context.reference.titlesOnly ?? false); }}>{[1, 2, 3, 4, 5].map((depth) => <option key={depth} value={depth}>{depth}</option>)}</select></label>
                        <label><input type="checkbox" aria-label={`${context.contentLabel} 제목만 포함`} checked={context.reference.titlesOnly ?? false} disabled={contextMutationBlockId === context.blockId} onChange={(event) => { void updateAtomContext(context.blockId, context.reference, context.reference.depth ?? 3, event.target.checked); }} /> 제목만</label>
                        <ContextRemoveButton title={context.contentLabel} disabled={contextMutationBlockId === context.blockId} onClick={() => { void removeContextBlock(context.blockId); }} />
                      </span> : <small className="v3-context-row-readonly">depth {context.reference.depth ?? 3} · 제목만 {(context.reference.titlesOnly ?? false) ? "켜짐" : "꺼짐"}</small>
                    ) : context.direct ? <ContextRemoveButton title={context.contentLabel} disabled={contextMutationBlockId === context.blockId} onClick={() => { void removeContextBlock(context.blockId); }} /> : null}
                  </div>
                ))}
                {contextItems.length === 0 ? <small>연결된 컨텍스트가 없습니다.</small> : null}
                <DashboardIconCap
                  className="v3-context-add"
                  label={`${contextPickerOpen ? "컨텍스트 선택 닫기" : "컨텍스트 추가"}`}
                  aria-expanded={contextPickerOpen}
                  onClick={() => setContextPickerOpen((value) => !value)}
                >
                  {contextPickerOpen ? <X className="h-4 w-4" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
                  <span>컨텍스트</span>
                </DashboardIconCap>
              </div>
              {contextMutationError ? <small className="v3-context-mutation-error" role="alert">컨텍스트 저장 실패 · {contextMutationError}</small> : null}
              {contextPickerOpen ? (
                <TaskContextPicker
                  taskPageId={task.page.id}
                  taskBlocks={contextBlocks}
                  onBlocksChanged={applyContextBlocks}
                  onClose={() => setContextPickerOpen(false)}
                />
              ) : null}
              <TaskDefaultAssignment
                agentId={effectiveSessionDefaults?.agentId ?? null}
                nodeId={effectiveSessionDefaults?.nodeId ?? null}
                sourceLabel={assignmentSourceLabel}
                onSave={saveDefaultAssignment}
              />
            </section>

            <section ref={checklistSectionRef} className="v3-detail-section" data-task-section="checklist" data-testid="v3-task-checklist">
              <div className="v3-detail-section-head"><h3>체크리스트</h3><span>업무</span></div>
              <div className="v3-task-checklist">
                <TaskCard
                  taskId={task.taskId}
                  fallbackTitle={task.page.title}
                  editable
                  textSize="session"
                />
              </div>
            </section>

            <div ref={boardSectionRef} data-task-section="board">
              <TaskInlineBoard
                taskId={task.taskId}
                folderId={projectFolderId}
                api={api}
                taskMoveTargets={taskMoveTargets}
                onMarkdownDocumentsChanged={setBoardDocuments}
              />
            </div>

            <div ref={sessionsSectionRef} data-task-section="sessions">
              <TaskRunHistory
                taskTitle={task.page.title}
                taskPageId={task.page.id}
                taskId={task.taskId}
                contextItems={contextItems}
                documentOptions={boardDocuments}
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
                activeSessionId={activeSessionId}
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
          </div>
        </div>
      </div>
    </article>
  );
}

function ContextRemoveButton({ title, disabled, onClick }: {
  title: string;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button type="button" className="v3-context-row-remove" aria-label={`${title} 컨텍스트 제거`} disabled={disabled} onClick={onClick}>
      <Trash2 className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

function contextSourceLabel(folderName: string): string {
  return folderName === "이 업무" ? folderName : `${folderName}에서 상속`;
}

function fallbackAssignmentSource(
  defaults: PageSessionDefaults | null,
  taskPageId: string,
  folders: readonly CatalogFolder[],
): string {
  if (!defaults) return "미지정";
  if (defaults.sourcePageId === taskPageId) return "직접 지정";
  const source = folders.find((folder) => folder.projectPageId === defaults.sourcePageId);
  return source ? `${source.name}에서 상속` : "상위 컨텍스트에서 상속";
}
