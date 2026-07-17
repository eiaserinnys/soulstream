import { useEffect, useMemo, useRef, useState } from "react";
import { DashboardIconCap, RunbookCard, retainEqualValue, useGlassSurface, type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";
import { ArrowLeft, LayoutDashboard, Plus, Star, X } from "lucide-react";

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
  onLoadMoreRuns(): void;
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
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [contextBlocks, setContextBlocks] = useState(task.blocks);
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
    setCreatedSessions([]);
  }, [task.blocks, task.page.id]);
  useEffect(() => setBoardDocuments([]), [task.page.id]);
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
  const focusTargetReady = !focusRequest?.sessionId || (
    allSessions.some((session) => session.agentSessionId === focusRequest.sessionId)
      && runSessionLoadStates.get(focusRequest.sessionId) === "ready"
  );
  const taskStarLabel = `별표 ${taskStar.starred ? "해제" : "추가"}`;

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
        <DashboardIconCap label="런북 보드 열기" onClick={onOpenBoard}>
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
              <div className="v3-context-chips">
                {contextItems.map((context) => (
                  <span key={context.id} title={context.label}>
                    <span className="v3-emoji" aria-hidden="true">{context.icon}</span>
                    <span className="v3-context-chip-label">{context.label}</span>
                  </span>
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
              {contextPickerOpen ? (
                <TaskContextPicker
                  taskPageId={task.page.id}
                  taskBlocks={contextBlocks}
                  onBlocksChanged={(blocks) => { setContextBlocks(blocks); onTaskBlocksChanged(blocks); }}
                  onClose={() => setContextPickerOpen(false)}
                />
              ) : null}
            </section>

            <section ref={checklistSectionRef} className="v3-detail-section" data-task-section="checklist" data-testid="v3-task-runbook-checklist">
              <div className="v3-detail-section-head"><h3>체크리스트</h3><span>런북</span></div>
              <div className="v3-task-runbook-checklist">
                <RunbookCard
                  runbookId={task.runbookId}
                  fallbackTitle={task.page.title}
                  defaultItemDetailsOpen
                  textSize="session"
                />
              </div>
            </section>

            <div ref={boardSectionRef} data-task-section="board">
              <TaskInlineBoard
                runbookId={task.runbookId}
                folderId={projectFolderId}
                onMarkdownDocumentsChanged={setBoardDocuments}
              />
            </div>

            <div ref={sessionsSectionRef} data-task-section="sessions">
              {effectiveSessionDefaults?.agentId || effectiveSessionDefaults?.nodeId ? (
                <div className="v3-session-defaults"><span className="v3-emoji" aria-hidden="true">👤</span> 기본값: {effectiveSessionDefaults.agentId ?? "agent 미지정"}@{effectiveSessionDefaults.nodeId ?? "node 미지정"} <span>(상속)</span></div>
              ) : null}

              <TaskRunHistory
                taskTitle={task.page.title}
                taskPageId={task.page.id}
                runbookId={task.runbookId}
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

function contextSourceLabel(folderName: string): string {
  return folderName === "이 업무" ? folderName : `${folderName}에서 상속`;
}
