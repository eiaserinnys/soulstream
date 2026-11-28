import { useTranslation } from "react-i18next";
import { useMemo, useRef, useState, type MouseEvent } from "react";
import { DashboardIconCap, useSessionMenu, type SessionSummary, retainEqualValue } from "@seosoyoung/soul-ui";
import { Plus } from "lucide-react";
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
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.resolvedLanguage);
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
  const newSessionButton = useRef<HTMLButtonElement>(null);
  const openSessionMenu = useSessionMenu();


  const openRunContextMenu = (session: SessionSummary, event: MouseEvent<HTMLDivElement>) => {
    openSessionMenu(session.agentSessionId,event);
  };

  return (
    <section className="v3-detail-section v3-runs">
      <div className="v3-detail-section-head">
        <h3>{t("folders.session.history")}</h3><span>{runHistoryTotal > tree.length ? t("folders.session.partialRuns", { shown: number.format(tree.length), total: number.format(runHistoryTotal) }) : t("folders.session.runs", { count: tree.length })}</span><span className="v3-spacer" />
        <DashboardIconCap ref={newSessionButton} size="small" label={t("folders.session.new")} onClick={() => setSuccessionOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </div>
      {tree.length === 0 ? <p className="v3-detail-empty">{t("folders.session.noRuns")}</p> : null}
      <SessionRunList tree={tree} activeSessionId={activeSessionId}
        onOpenSession={onOpenSession} onContextMenu={openRunContextMenu} />
      <RunHistoryAutoLoader hasMore={runHistoryHasMore} loading={runHistoryLoading}
        failed={runHistoryFailed} onLoadMore={onLoadMoreRuns} testId="v3-run-history-auto-loader" />
      {successionOpen ? (
        <SessionSuccessionModal
          returnFocusRef={newSessionButton}
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
