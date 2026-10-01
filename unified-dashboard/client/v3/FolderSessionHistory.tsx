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
} from "./folder-workspace-run-model";
import {
  buildSuccessionSessionOptions,
  latestFolderRun,
} from "./session-succession-model";
import type { PageSessionDefaults } from "./folder-workspace-page-api";
import {
  type FolderMoveTarget,
} from "./folder-move-targets";
import { FolderMoveDialog } from "./FolderMoveDialog";
import {
  SessionSuccessionModal,
  type SuccessionContextItem,
  type SuccessionDocumentOption,
} from "./SessionSuccessionModal";
import { SessionRunList } from "./SessionRunList";
import { buildFolderSessionExtraActions } from "./context-menu-model";
import "./v3-run-history.css";

export function FolderSessionHistory({
  folderTitle,
  folderPageId,
  folderId,
  contextItems,
  documentOptions,
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
  folderTitle: string;
  folderPageId: string;
  folderId: string;
  contextItems: readonly SuccessionContextItem[];
  documentOptions: readonly SuccessionDocumentOption[];
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
  moveTargets: readonly FolderMoveTarget[];
  onOpenSession(session: SessionSummary): void;
  onSessionCreated(session: SessionSummary): void;
  onRenameSession(sessionId: string, displayName: string | null): Promise<void>;
  onDeleteSessions(sessionIds: string[]): Promise<void>;
  onMoveSession(sessionId: string, targetFolder: FolderMoveTarget): Promise<void>;
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
  const currentSession = useMemo(() => latestFolderRun(sessionIds, sessions), [sessionIds, sessions]);
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
        <DashboardIconCap size="small" label="새 세션" onClick={() => setSuccessionOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </div>
      {tree.length === 0 ? <p className="v3-detail-empty">아직 실행된 세션이 없습니다.</p> : null}
      <SessionRunList tree={tree} activeSessionId={activeSessionId}
        onOpenSession={onOpenSession} onContextMenu={openRunContextMenu} />
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
          folderTitle={folderTitle}
          folderPageId={folderPageId}
          folderId={folderId}
          contextItems={contextItems}
          documentOptions={documentOptions}
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
        extraActions={buildFolderSessionExtraActions({
          continueFromSession: () => {
            if (!contextMenu) return;
            setTargetedSuccessionId(contextMenu.sessionId);
            setContextMenu(null);
            setSuccessionOpen(true);
          },
          moveToFolder: () => {
            if (!contextMenu) return;
            setMoveSessionId(contextMenu.sessionId);
            setContextMenu(null);
          },
        })}
      />
      <FolderMoveDialog
        api={api}
        currentFolderId={folderId}
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
  const detailScroller = trigger.closest<HTMLElement>(".v3-detail-scroll");
  const scroller = detailScroller && detailScroller.scrollHeight > detailScroller.clientHeight
    ? detailScroller
    : trigger.closest<HTMLElement>(".v3-planner-scroll");
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
