import { useMemo, useRef, useState, type MouseEvent } from "react";
import {
  DashboardIconCap,
  useSessionMenu,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { Plus } from "lucide-react";
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
import {
  SessionSuccessionModal,
  type SuccessionContextItem,
  type SuccessionDocumentOption,
} from "./SessionSuccessionModal";
import { SessionRunList } from "./SessionRunList";
import { RunHistoryAutoLoader } from "./RunHistoryAutoLoader";
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
  runHistoryFailed = false,
  activeSessionId,
  onLoadMoreRuns,
  onOpenSession,
  onSessionCreated,
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
  runHistoryFailed?: boolean;
  activeSessionId: string | null;
  onLoadMoreRuns(): Promise<void>;
  onOpenSession(session: SessionSummary): void;
  onSessionCreated(session: SessionSummary): void;
}) {
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
  const openSessionMenu = useSessionMenu();


  const openRunContextMenu = (session: SessionSummary, event: MouseEvent<HTMLDivElement>) => {
    openSessionMenu(session.agentSessionId,event);
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
      <RunHistoryAutoLoader hasMore={runHistoryHasMore} loading={runHistoryLoading}
        failed={runHistoryFailed} onLoadMore={onLoadMoreRuns} testId="v3-run-history-auto-loader" />
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
          currentSession={currentSession}
          onClose={() => setSuccessionOpen(false)}
          onCreated={onSessionCreated}
        />
      ) : null}


    </section>
  );
}

export function getRunSessionRenamePrefill(
  sessions: readonly SessionSummary[],
  sessionId: string,
): string {
  return sessions.find((session) => session.agentSessionId === sessionId)?.displayName ?? "";
}
