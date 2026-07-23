import { useMemo, useRef, useState, type MouseEvent } from "react";
import {
  DashboardIconCap,
  SessionContextMenu,
  type SessionContextMenuState,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { ChevronsDown, Plus } from "lucide-react";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import { retainEqualValue } from "@seosoyoung/soul-ui";

import {
  buildRunTree,
  type RunSessionLoadState,
  type RunTreeNode,
} from "./task-workspace-model";
import {
  buildSuccessionSessionOptions,
  latestTaskRun,
} from "./session-succession-model";
import type { PageSessionDefaults } from "./task-workspace-api";
import {
  type TaskMoveTarget,
} from "./task-move-targets";
import { TaskMoveDialog } from "./TaskMoveDialog";
import {
  SessionSuccessionModal,
  type SuccessionContextItem,
  type SuccessionDocumentOption,
} from "./SessionSuccessionModal";
import { RichSessionRow } from "./RichSessionRow";
import { buildTaskSessionExtraActions } from "./context-menu-model";
import "./v3-run-history.css";
import type { PageContextSourcesMarker } from "./project-context-inheritance";

export function TaskRunHistory({
  taskTitle,
  taskPageId,
  taskId,
  contextItems,
  documentOptions,
  pageContextSources,
  contextPending,
  sessionDefaults,
  sessionIds,
  sessions,
  runSessionLoadStates,
  runHistoryTotal,
  runHistoryHasMore,
  runHistoryLoading,
  activeSessionId,
  onLoadMoreRuns,
  moveTargets,
  onOpenSession,
  onSessionCreated,
  onRenameSession,
  onDeleteSessions,
  onMoveSession,
}: {
  taskTitle: string;
  taskPageId: string;
  taskId: string;
  contextItems: readonly SuccessionContextItem[];
  documentOptions: readonly SuccessionDocumentOption[];
  pageContextSources: PageContextSourcesMarker;
  contextPending: boolean;
  sessionDefaults: PageSessionDefaults | null;
  sessionIds: readonly string[];
  sessions: readonly SessionSummary[];
  runSessionLoadStates: ReadonlyMap<string, RunSessionLoadState>;
  runHistoryTotal: number;
  runHistoryHasMore: boolean;
  runHistoryLoading: boolean;
  activeSessionId: string | null;
  onLoadMoreRuns(): Promise<void>;
  moveTargets: readonly TaskMoveTarget[];
  onOpenSession(session: SessionSummary): void;
  onSessionCreated(session: SessionSummary): void;
  onRenameSession(sessionId: string, displayName: string | null): Promise<void>;
  onDeleteSessions(sessionIds: string[]): Promise<void>;
  onMoveSession(sessionId: string, targetTask: TaskMoveTarget): Promise<void>;
}) {
  const api = useMemo(() => createPageApiClient(), []);
  const treeRef = useRef<ReturnType<typeof buildRunTree>>([]);
  const predecessorOptionsRef = useRef<ReturnType<typeof buildSuccessionSessionOptions>>([]);
  const tree = useMemo(
    () => {
      treeRef.current = retainEqualValue(
        treeRef.current,
        buildRunTree(sessionIds, sessions, runSessionLoadStates),
      );
      return treeRef.current;
    },
    [runSessionLoadStates, sessionIds, sessions],
  );
  const currentSession = useMemo(() => latestTaskRun(sessionIds, sessions), [sessionIds, sessions]);
  const predecessorOptions = useMemo(
    () => {
      predecessorOptionsRef.current = retainEqualValue(
        predecessorOptionsRef.current,
        buildSuccessionSessionOptions(tree),
      );
      return predecessorOptionsRef.current;
    },
    [tree],
  );
  const [successionOpen, setSuccessionOpen] = useState(false);
  const [targetedSuccessionId, setTargetedSuccessionId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const [moveSessionId, setMoveSessionId] = useState<string | null>(null);
  const targetedSuccession = targetedSuccessionId
    ? sessions.find((session) => session.agentSessionId === targetedSuccessionId) ?? null
    : currentSession;

  const loadMoreRuns = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    await loadMoreRunsPreservingScroll(event.currentTarget, onLoadMoreRuns);
  };

  const openRunContextMenu = (session: SessionSummary, event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, sessionId: session.agentSessionId });
  };

  return (
    <section className="v3-detail-section v3-runs">
      <div className="v3-detail-section-head">
        <h3>세션 히스토리</h3><span>{runHistoryTotal > tree.length ? `${tree.length}/${runHistoryTotal}회` : `${tree.length}회`}</span><span className="v3-spacer" />
        <DashboardIconCap label="새 세션" onClick={() => setSuccessionOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </div>
      {tree.length === 0 ? <p className="v3-detail-empty">아직 실행된 세션이 없습니다.</p> : null}
      <div className="v3-run-list">
        {tree.map((node) => (
          <RunNode
            key={node.session.agentSessionId}
            node={node}
            depth={0}
            activeSessionId={activeSessionId}
            onOpenSession={onOpenSession}
            onContextMenu={openRunContextMenu}
          />
        ))}
      </div>
      {runHistoryHasMore ? (
        <div className="v3-run-load-more">
          <DashboardIconCap
            label="이전 세션 더 보기"
            data-testid="v3-load-more-runs"
            disabled={runHistoryLoading}
            onClick={(event) => { void loadMoreRuns(event); }}
          >
            <ChevronsDown className="h-4 w-4" aria-hidden="true" />
          </DashboardIconCap>
        </div>
      ) : null}
      {successionOpen ? (
        <SessionSuccessionModal
          taskTitle={taskTitle}
          taskPageId={taskPageId}
          taskId={taskId}
          contextItems={contextItems}
          documentOptions={documentOptions}
          pageContextSources={pageContextSources}
          contextPending={contextPending}
          predecessorOptions={predecessorOptions}
          pageDefaults={sessionDefaults}
          currentSession={targetedSuccession}
          onClose={() => { setSuccessionOpen(false); setTargetedSuccessionId(null); }}
          onCreated={onSessionCreated}
        />
      ) : null}
      <SessionContextMenu
        contextMenu={contextMenu}
        onClose={() => setContextMenu(null)}
        onRenameSession={onRenameSession}
        onDeleteSessions={onDeleteSessions}
        getSessionName={(sessionId) => getRunSessionRenamePrefill(sessions, sessionId)}
        resolveSessionIds={(sessionId) => [sessionId]}
        extraActions={buildTaskSessionExtraActions({
          continueFromSession: () => {
            if (!contextMenu) return;
            setTargetedSuccessionId(contextMenu.sessionId);
            setContextMenu(null);
            setSuccessionOpen(true);
          },
          moveToTask: () => {
            if (!contextMenu) return;
            setMoveSessionId(contextMenu.sessionId);
            setContextMenu(null);
          },
        })}
      />
      <TaskMoveDialog
        api={api}
        currentTaskId={taskId}
        defaultTargets={moveTargets}
        open={moveSessionId !== null}
        onClose={() => setMoveSessionId(null)}
        onMove={async (target) => {
          if (!moveSessionId) return;
          await onMoveSession(moveSessionId, target);
        }}
      />
    </section>
  );
}

function RunNode({
  node,
  depth,
  activeSessionId,
  onOpenSession,
  onContextMenu,
}: {
  node: RunTreeNode;
  depth: number;
  activeSessionId: string | null;
  onOpenSession(session: SessionSummary): void;
  onContextMenu(session: SessionSummary, event: MouseEvent<HTMLDivElement>): void;
}) {
  const { session } = node;
  if (node.loadState === "loading") {
    return (
      <div className={depth > 0 ? "v3-run-children" : undefined}>
        <div className="v3-run-row v3-run-row--loading" data-depth={depth} aria-label="세션 정보 불러오는 중" aria-busy="true">
          <span className="v3-run-skeleton v3-run-skeleton--avatar" />
          <span className="v3-run-skeleton-copy">
            <span className="v3-run-skeleton v3-run-skeleton--title" />
            <span className="v3-run-skeleton v3-run-skeleton--preview" />
          </span>
          <span className="v3-run-skeleton v3-run-skeleton--badge" />
        </div>
      </div>
    );
  }
  const failed = node.loadState === "failed";
  return (
    <div className={depth > 0 ? "v3-run-children" : undefined}>
      <RichSessionRow
        session={session}
        runNumber={node.runNumber}
        failed={failed}
        active={!failed && session.agentSessionId === activeSessionId}
        onOpen={onOpenSession}
        onContextMenu={onContextMenu}
      />
      {node.children.map((child) => (
        <RunNode
          key={child.session.agentSessionId}
          node={child}
          depth={depth + 1}
          activeSessionId={activeSessionId}
          onOpenSession={onOpenSession}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  );
}

export function getRunSessionRenamePrefill(
  sessions: readonly SessionSummary[],
  sessionId: string,
): string {
  return sessions.find((session) => session.agentSessionId === sessionId)?.displayName ?? "";
}

export async function loadMoreRunsPreservingScroll(
  trigger: HTMLElement,
  loadMore: () => Promise<void>,
  scheduleFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
): Promise<void> {
  const scroller = trigger.closest<HTMLElement>(".v3-detail-scroll");
  const scrollTop = scroller?.scrollTop;
  await loadMore();
  if (!scroller || scrollTop === undefined) return;
  await new Promise<void>((resolve) => {
    scheduleFrame(() => {
      scroller.scrollTop = scrollTop;
      resolve();
    });
  });
}
