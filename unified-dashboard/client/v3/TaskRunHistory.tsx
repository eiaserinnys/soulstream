import { useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  SessionContextMenu,
  type SessionContextMenuState,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";

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
  defaultTaskMoveTargets,
  searchTaskMoveTargets,
  type TaskMoveTarget,
} from "./task-move-targets";
import {
  SessionSuccessionModal,
  type SuccessionContextItem,
} from "./SessionSuccessionModal";
import { RichSessionRow } from "./RichSessionRow";
import "./v3-run-history.css";

export function TaskRunHistory({
  taskTitle,
  taskPageId,
  runbookId,
  contextItems,
  sessionDefaults,
  predecessorSessionId,
  sessionIds,
  sessions,
  runSessionLoadStates,
  runHistoryTotal,
  runHistoryHasMore,
  runHistoryLoading,
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
  runbookId: string;
  contextItems: readonly SuccessionContextItem[];
  sessionDefaults: PageSessionDefaults | null;
  predecessorSessionId: string | null;
  sessionIds: readonly string[];
  sessions: readonly SessionSummary[];
  runSessionLoadStates: ReadonlyMap<string, RunSessionLoadState>;
  runHistoryTotal: number;
  runHistoryHasMore: boolean;
  runHistoryLoading: boolean;
  onLoadMoreRuns(): void;
  moveTargets: readonly TaskMoveTarget[];
  onOpenSession(session: SessionSummary): void;
  onSessionCreated(session: SessionSummary): void;
  onRenameSession(sessionId: string, displayName: string | null): Promise<void>;
  onDeleteSessions(sessionIds: string[]): Promise<void>;
  onMoveSession(sessionId: string, targetTask: TaskMoveTarget): Promise<void>;
}) {
  const api = useMemo(() => createPageApiClient(), []);
  const tree = useMemo(
    () => buildRunTree(sessionIds, sessions, runSessionLoadStates),
    [runSessionLoadStates, sessionIds, sessions],
  );
  const currentSession = useMemo(() => latestTaskRun(sessionIds, sessions), [sessionIds, sessions]);
  const predecessorOptions = useMemo(
    () => buildSuccessionSessionOptions(tree),
    [tree],
  );
  const [successionOpen, setSuccessionOpen] = useState(false);
  const [targetedSuccessionId, setTargetedSuccessionId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const [moveSessionId, setMoveSessionId] = useState<string | null>(null);
  const [movePending, setMovePending] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moveQuery, setMoveQuery] = useState("");
  const [searchedMoveTargets, setSearchedMoveTargets] = useState<TaskMoveTarget[]>([]);
  const [moveSearchPending, setMoveSearchPending] = useState(false);
  const [moveSearchError, setMoveSearchError] = useState<string | null>(null);
  const targetedSuccession = targetedSuccessionId
    ? sessions.find((session) => session.agentSessionId === targetedSuccessionId) ?? null
    : currentSession;
  const visibleMoveTargets = useMemo(
    () => defaultTaskMoveTargets(moveTargets, runbookId),
    [moveTargets, runbookId],
  );
  const normalizedMoveQuery = moveQuery.trim();
  const moveOptions = normalizedMoveQuery ? searchedMoveTargets : visibleMoveTargets;

  useEffect(() => {
    if (!moveSessionId || !normalizedMoveQuery) {
      setSearchedMoveTargets([]);
      setMoveSearchPending(false);
      setMoveSearchError(null);
      return;
    }
    let active = true;
    setMoveSearchPending(true);
    setMoveSearchError(null);
    void searchTaskMoveTargets(api, normalizedMoveQuery, runbookId).then((targets) => {
      if (active) setSearchedMoveTargets(targets);
    }).catch((error: unknown) => {
      if (active) setMoveSearchError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (active) setMoveSearchPending(false);
    });
    return () => { active = false; };
  }, [api, moveSessionId, normalizedMoveQuery, runbookId]);

  const moveSession = (target: TaskMoveTarget) => {
    if (!moveSessionId) return;
    setMovePending(true);
    setMoveError(null);
    void onMoveSession(moveSessionId, target)
      .then(() => setMoveSessionId(null))
      .catch((error: unknown) => setMoveError(error instanceof Error ? error.message : String(error)))
      .finally(() => setMovePending(false));
  };

  const openRunContextMenu = (session: SessionSummary, event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, sessionId: session.agentSessionId });
  };

  return (
    <section className="v3-detail-section v3-runs">
      <div className="v3-detail-section-head">
        <h3>Run 히스토리</h3><span>{runHistoryTotal > tree.length ? `${tree.length}/${runHistoryTotal}회` : `${tree.length}회`}</span><span className="v3-spacer" />
        <button type="button" className="v3-button v3-button--soft" onClick={() => setSuccessionOpen(true)}>＋ 새 세션</button>
      </div>
      {tree.length === 0 ? <p className="v3-detail-empty">아직 실행된 세션이 없습니다.</p> : null}
      <div className="v3-run-list">
        {tree.map((node) => (
          <RunNode
            key={node.session.agentSessionId}
            node={node}
            depth={0}
            onOpenSession={onOpenSession}
            onContextMenu={openRunContextMenu}
          />
        ))}
      </div>
      {runHistoryHasMore ? (
        <button
          type="button"
          className="v3-button v3-button--soft"
          data-testid="v3-load-more-runs"
          disabled={runHistoryLoading}
          onClick={onLoadMoreRuns}
        >
          {runHistoryLoading ? "Run 불러오는 중…" : "이전 Run 더 보기"}
        </button>
      ) : null}
      {successionOpen ? (
        <SessionSuccessionModal
          taskTitle={taskTitle}
          taskPageId={taskPageId}
          runbookId={runbookId}
          contextItems={contextItems}
          predecessorOptions={predecessorOptions}
          pageDefaults={sessionDefaults}
          currentSession={targetedSuccession}
          predecessorSessionId={targetedSuccessionId ?? predecessorSessionId}
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
        extraActions={[
          {
            label: "＋ 이어서 새 세션 (승계)",
            onClick: () => {
              if (!contextMenu) return;
              setTargetedSuccessionId(contextMenu.sessionId);
              setContextMenu(null);
              setSuccessionOpen(true);
            },
          },
          {
            label: "다른 업무로 이동",
            onClick: () => {
              if (!contextMenu) return;
              setMoveSessionId(contextMenu.sessionId);
              setMoveError(null);
              setContextMenu(null);
            },
          },
        ]}
      />
      <Dialog open={moveSessionId !== null} onOpenChange={(open) => { if (!open && !movePending) setMoveSessionId(null); }}>
        <DialogPopup className="max-w-md">
          <DialogHeader><DialogTitle>다른 업무로 이동</DialogTitle></DialogHeader>
          <DialogPanel>
            <div className="v3-context-picker v3-run-move-picker">
              <div className="v3-context-panel">
                <input
                  type="search"
                  value={moveQuery}
                  disabled={movePending}
                  aria-label="이동할 업무 검색"
                  placeholder="전체 업무 검색…"
                  onChange={(event) => setMoveQuery(event.target.value)}
                />
                <div className="v3-context-options" data-testid="v3-run-move-targets">
                  {moveOptions.map((target) => (
                    <button
                      type="button"
                      className="v3-context-option"
                      key={target.runbookId}
                      disabled={movePending}
                      onClick={() => moveSession(target)}
                    >
                      <span className="v3-emoji" aria-hidden="true">↪</span>
                      <span><strong>{target.page.title}</strong><small>업무 · {target.runbookId.slice(0, 8)}</small></span>
                    </button>
                  ))}
                  {moveSearchPending ? <p>업무를 검색하는 중…</p> : null}
                  {!moveSearchPending && moveOptions.length === 0 ? (
                    <p>{normalizedMoveQuery ? "일치하는 업무가 없습니다." : "이동할 업무를 검색하세요."}</p>
                  ) : null}
                </div>
              </div>
            </div>
            {moveSearchError ? <p className="v3-load-error" role="alert">업무 검색 실패 · {moveSearchError}</p> : null}
            {moveError ? <p className="v3-load-error" role="alert">{moveError}</p> : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </section>
  );
}

function RunNode({
  node,
  depth,
  onOpenSession,
  onContextMenu,
}: {
  node: RunTreeNode;
  depth: number;
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
        onOpen={onOpenSession}
        onContextMenu={onContextMenu}
      />
      {node.children.map((child) => (
        <RunNode
          key={child.session.agentSessionId}
          node={child}
          depth={depth + 1}
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
