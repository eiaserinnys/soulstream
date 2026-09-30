import { FolderCardSection } from "./FolderCardSection";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  CustomViewPanel,
  DashboardIconCap,
  DisclosureActionIcon,
  MarkdownContent,
  retainEqualValue,
  type CatalogBoardItem,
  type MarkdownDocument,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { ChevronLeft, ChevronRight, ChevronsDown, Plus, SquarePen } from "lucide-react";

import { RichSessionRow } from "./RichSessionRow";
import { loadMoreRunsPreservingScroll } from "./FolderSessionHistory";
import { fetchInlineMarkdown } from "./folder-inline-board-api";
import {
  buildFolderBoardResourceTabs,
  computeTabStripOverflow,
  type FolderBoardResourceSelection,
  type FolderBoardResourceTab,
} from "./folder-board-model";
import {
  buildRunTree,
  type RunSessionLoadState,
  type RunTreeNode,
} from "./folder-workspace-run-model";
import { useV3PageInvalidationKey } from "./v3-live-invalidation-plane";

export function FolderBoardResourcePane({
  folderId,
  folderTitle,
  sessionIds,
  sessions,
  runSessionLoadStates,
  runHistoryTotal,
  runHistoryHasMore,
  runHistoryLoading,
  activeSessionId,
  boardItems,
  openedResources,
  activeTabId,
  markdownDocumentsRevision = 0,
  onOpenSession,
  onLoadMoreRuns,
  onOpenDocument,
  onActiveTabChange,
  onNewSession,
  onSessionContextMenu,
}: {
  folderId: string;
  folderTitle: string;
  sessionIds: readonly string[];
  sessions: readonly SessionSummary[];
  runSessionLoadStates: ReadonlyMap<string, RunSessionLoadState>;
  runHistoryTotal: number;
  runHistoryHasMore: boolean;
  runHistoryLoading: boolean;
  activeSessionId: string | null;
  boardItems: readonly CatalogBoardItem[];
  openedResources: readonly FolderBoardResourceSelection[];
  activeTabId: string;
  markdownDocumentsRevision?: number;
  onOpenSession(session: SessionSummary): void;
  onLoadMoreRuns(): Promise<void>;
  onOpenDocument(documentId: string): void;
  onActiveTabChange(tabId: string): void;
  onNewSession?: () => void;
  onSessionContextMenu?(session: SessionSummary, event: MouseEvent<HTMLDivElement>): void;
}) {
  const baseTabs = useMemo(
    () => buildFolderBoardResourceTabs(boardItems, openedResources),
    [boardItems, openedResources],
  );
  const baseActiveTab = baseTabs.find((tab) => tab.id === activeTabId) ?? baseTabs[0];
  const activeDocumentId = baseActiveTab.kind === "document" ? baseActiveTab.documentId : null;
  const documentInvalidationKey = useV3PageInvalidationKey(activeDocumentId ? [activeDocumentId] : [])
    + markdownDocumentsRevision;
  const tabs = baseTabs;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  return (
    <>
      <header className="v3-workspace-toolbar">
        <div>
          <small>폴더 자료</small>
          <strong>{folderTitle}</strong>
        </div>
      </header>
      <FolderBoardResourceTabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        onActiveTabChange={onActiveTabChange}
      />
      <div
        id="v3-folder-board-resource-panel"
        className="v3-folder-board-resource-content"
        role="tabpanel"
        aria-label={activeTab.title}
      >
        {activeTab.kind === "cards" ? (
          <FolderCardSection folderId={folderId} placement="overlay" />
        ) : activeTab.kind === "sessions" ? (
          <FolderBoardSessionTree
            sessionIds={sessionIds}
            sessions={sessions}
            runSessionLoadStates={runSessionLoadStates}
            runHistoryTotal={runHistoryTotal}
            runHistoryHasMore={runHistoryHasMore}
            runHistoryLoading={runHistoryLoading}
            activeSessionId={activeSessionId}
            onOpenSession={onOpenSession}
            onLoadMoreRuns={onLoadMoreRuns}
            onNewSession={onNewSession}
            onSessionContextMenu={onSessionContextMenu}
          />
        ) : activeTab.kind === "custom_view" ? (
          <CustomViewPanel customViewId={activeTab.customViewId} />
        ) : (
          <FolderBoardDocumentReader
            tab={activeTab}
            invalidationKey={documentInvalidationKey}
            onOpenDocument={() => onOpenDocument(activeTab.documentId)}
          />
        )}
      </div>
    </>
  );
}

function FolderBoardResourceTabStrip({
  tabs,
  activeTabId,
  onActiveTabChange,
}: {
  tabs: readonly FolderBoardResourceTab[];
  activeTabId: string;
  onActiveTabChange(tabId: string): void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ canScrollLeft: false, canScrollRight: false });

  const refreshOverflow = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setOverflow((current) => {
      const next = computeTabStripOverflow({
        scrollLeft: el.scrollLeft,
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
      });
      return next.canScrollLeft === current.canScrollLeft && next.canScrollRight === current.canScrollRight
        ? current
        : next;
    });
  }, []);

  useEffect(() => {
    refreshOverflow();
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(refreshOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [refreshOverflow, tabs.length]);

  const scrollByDirection = (direction: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.7), behavior: "smooth" });
  };

  return (
    <div
      className="v3-folder-board-resource-tabs-wrap"
      data-overflow-left={overflow.canScrollLeft ? "true" : undefined}
      data-overflow-right={overflow.canScrollRight ? "true" : undefined}
    >
      {overflow.canScrollLeft ? (
        <DashboardIconCap
          label="이전 탭 보기"
          className="v3-folder-board-resource-tabs-chevron v3-folder-board-resource-tabs-chevron--left"
          onClick={() => scrollByDirection(-1)}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      ) : null}
      <div
        ref={scrollerRef}
        className="v3-folder-board-resource-tabs"
        role="tablist"
        aria-label="폴더 자료"
        onScroll={refreshOverflow}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTabId}
            aria-controls="v3-folder-board-resource-panel"
            title={tab.title}
            onClick={() => onActiveTabChange(tab.id)}
          >
            {tab.kind === "cards" ? "✓" : tab.kind === "sessions" ? "↳" : tab.kind === "custom_view" ? "◇" : "▤"}
            <span>{tab.title}</span>
          </button>
        ))}
      </div>
      {overflow.canScrollRight ? (
        <DashboardIconCap
          label="다음 탭 보기"
          className="v3-folder-board-resource-tabs-chevron v3-folder-board-resource-tabs-chevron--right"
          onClick={() => scrollByDirection(1)}
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      ) : null}
    </div>
  );
}

function FolderBoardSessionTree({
  sessionIds,
  sessions,
  runSessionLoadStates,
  runHistoryTotal,
  runHistoryHasMore,
  runHistoryLoading,
  activeSessionId,
  onOpenSession,
  onLoadMoreRuns,
  onNewSession,
  onSessionContextMenu,
}: {
  sessionIds: readonly string[];
  sessions: readonly SessionSummary[];
  runSessionLoadStates: ReadonlyMap<string, RunSessionLoadState>;
  runHistoryTotal: number;
  runHistoryHasMore: boolean;
  runHistoryLoading: boolean;
  activeSessionId: string | null;
  onOpenSession(session: SessionSummary): void;
  onLoadMoreRuns(): Promise<void>;
  onNewSession?: () => void;
  onSessionContextMenu?(session: SessionSummary, event: MouseEvent<HTMLDivElement>): void;
}) {
  const tree = useMemo(
    () => buildRunTree(sessionIds, sessions, runSessionLoadStates),
    [runSessionLoadStates, sessionIds, sessions],
  );
  return (
    <div className="v3-folder-board-session-list">
      <div className="v3-folder-board-session-head">
        <strong>세션 히스토리</strong>
        <span className="v3-folder-board-session-count">
          {runHistoryTotal > tree.length ? `${tree.length}/${runHistoryTotal}회` : `${tree.length}회`}
        </span>
        {onNewSession ? (
          <DashboardIconCap label="새 세션" onClick={onNewSession}>
            <Plus className="h-4 w-4" aria-hidden="true" />
          </DashboardIconCap>
        ) : null}
      </div>
      {tree.length === 0 ? (
        <p className="v3-detail-empty">아직 실행된 세션이 없습니다.</p>
      ) : (
        <div className="v3-folder-board-session-tree">
          {tree.map((node) => (
            <FolderBoardSessionNode
              key={node.session.agentSessionId}
              node={node}
              activeSessionId={activeSessionId}
              onOpenSession={onOpenSession}
              onSessionContextMenu={onSessionContextMenu}
            />
          ))}
        </div>
      )}
      {runHistoryHasMore ? (
        <div className="v3-run-load-more">
          <DashboardIconCap
            label="이전 세션 더 보기"
            data-testid="v3-folder-board-load-more-runs"
            disabled={runHistoryLoading}
            onClick={(event) => {
              void loadMoreRunsPreservingScroll(event.currentTarget, onLoadMoreRuns);
            }}
          >
            <ChevronsDown className="h-4 w-4" aria-hidden="true" />
          </DashboardIconCap>
        </div>
      ) : null}
    </div>
  );
}

function FolderBoardSessionNode({
  node,
  activeSessionId,
  onOpenSession,
  onSessionContextMenu,
}: {
  node: RunTreeNode;
  activeSessionId: string | null;
  onOpenSession(session: SessionSummary): void;
  onSessionContextMenu?(session: SessionSummary, event: MouseEvent<HTMLDivElement>): void;
}) {
  const [expanded, setExpanded] = useState(true);
  const failed = node.loadState === "failed";
  const loading = node.loadState === "loading";
  return (
    <div className="v3-folder-board-session-node">
      <RichSessionRow
        session={node.session}
        runNumber={node.runNumber}
        failed={failed}
        active={!failed && !loading && node.session.agentSessionId === activeSessionId}
        preview={loading ? "세션 정보를 불러오는 중…" : undefined}
        onOpen={onOpenSession}
        onContextMenu={onSessionContextMenu}
        actions={node.children.length > 0 ? (
          <DashboardIconCap
            label={`${node.children.length}개 위임 세션 ${expanded ? "접기" : "펼치기"}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <DisclosureActionIcon expanded={expanded} className="h-4 w-4" />
          </DashboardIconCap>
        ) : null}
      />
      {expanded ? (
        <div className="v3-folder-board-session-children">
          {node.children.map((child) => (
            <FolderBoardSessionNode
              key={child.session.agentSessionId}
              node={child}
              activeSessionId={activeSessionId}
              onOpenSession={onOpenSession}
              onSessionContextMenu={onSessionContextMenu}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FolderBoardDocumentReader({
  tab,
  invalidationKey,
  onOpenDocument,
}: {
  tab: Extract<FolderBoardResourceTab, { kind: "document" }>;
  invalidationKey: number;
  onOpenDocument(): void;
}) {
  const [document, setDocument] = useState<MarkdownDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setDocument(null);
    setError(null);
    void fetchInlineMarkdown(
      tab.documentId,
      (input, init) => globalThis.fetch(input, { ...init, signal: controller.signal }),
    ).then((next) => {
      setDocument((current) => retainEqualValue(current ?? undefined, next));
    }).catch((cause: unknown) => {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => controller.abort();
  }, [invalidationKey, tab.documentId]);

  return (
    <div className="v3-folder-board-document-reader">
      <div className="v3-folder-board-document-reader-head">
        <strong>{document?.title ?? tab.title}</strong>
        <DashboardIconCap label={`${document?.title ?? tab.title} 편집기 열기`} onClick={onOpenDocument}>
          <SquarePen className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </div>
      {error ? <p className="v3-inline-board-error">문서를 불러오지 못했습니다. {error}</p> : null}
      {!document && !error ? <p className="v3-detail-empty">본문을 불러오는 중…</p> : null}
      {document ? <div className="v3-folder-board-document-copy"><MarkdownContent content={document.body} codeBlockLayout="document" /></div> : null}
    </div>
  );
}
