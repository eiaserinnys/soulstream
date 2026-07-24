import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CustomViewPanel,
  DashboardIconCap,
  DisclosureActionIcon,
  MarkdownContent,
  TaskCard,
  retainEqualValue,
  type CatalogBoardItem,
  type MarkdownDocument,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { ChevronLeft, ChevronRight, Plus, SquarePen } from "lucide-react";

import { RichSessionRow } from "./RichSessionRow";
import { fetchInlineMarkdown } from "./task-inline-board-api";
import {
  buildTaskBoardResourceTabs,
  computeTabStripOverflow,
  type TaskBoardResourceSelection,
  type TaskBoardResourceTab,
} from "./task-board-model";
import {
  buildRunTree,
  type RunSessionLoadState,
  type RunTreeNode,
} from "./task-workspace-model";

export function TaskBoardResourcePane({
  taskId,
  taskTitle,
  sessionIds,
  sessions,
  runSessionLoadStates,
  activeSessionId,
  boardItems,
  openedResources,
  activeTabId,
  onOpenSession,
  onOpenDocument,
  onActiveTabChange,
  onNewSession,
}: {
  taskId: string;
  taskTitle: string;
  sessionIds: readonly string[];
  sessions: readonly SessionSummary[];
  runSessionLoadStates: ReadonlyMap<string, RunSessionLoadState>;
  activeSessionId: string | null;
  boardItems: readonly CatalogBoardItem[];
  openedResources: readonly TaskBoardResourceSelection[];
  activeTabId: string;
  onOpenSession(session: SessionSummary): void;
  onOpenDocument(documentId: string): void;
  onActiveTabChange(tabId: string): void;
  onNewSession?: () => void;
}) {
  const tabs = useMemo(
    () => buildTaskBoardResourceTabs(boardItems, openedResources),
    [boardItems, openedResources],
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  return (
    <>
      <header className="v3-workspace-toolbar">
        <div>
          <small>업무 자료</small>
          <strong>{taskTitle}</strong>
        </div>
      </header>
      <TaskBoardResourceTabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        onActiveTabChange={onActiveTabChange}
      />
      <div
        id="v3-task-board-resource-panel"
        className="v3-task-board-resource-content"
        role="tabpanel"
        aria-label={activeTab.title}
      >
        {activeTab.kind === "checklist" ? (
          <TaskCard taskId={taskId} fallbackTitle={taskTitle} editable textSize="session" />
        ) : activeTab.kind === "sessions" ? (
          <TaskBoardSessionTree
            sessionIds={sessionIds}
            sessions={sessions}
            runSessionLoadStates={runSessionLoadStates}
            activeSessionId={activeSessionId}
            onOpenSession={onOpenSession}
            onNewSession={onNewSession}
          />
        ) : activeTab.kind === "custom_view" ? (
          <CustomViewPanel customViewId={activeTab.customViewId} />
        ) : (
          <TaskBoardDocumentReader
            tab={activeTab}
            onOpenDocument={() => onOpenDocument(activeTab.documentId)}
          />
        )}
      </div>
    </>
  );
}

function TaskBoardResourceTabStrip({
  tabs,
  activeTabId,
  onActiveTabChange,
}: {
  tabs: readonly TaskBoardResourceTab[];
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
      className="v3-task-board-resource-tabs-wrap"
      data-overflow-left={overflow.canScrollLeft ? "true" : undefined}
      data-overflow-right={overflow.canScrollRight ? "true" : undefined}
    >
      {overflow.canScrollLeft ? (
        <DashboardIconCap
          label="이전 탭 보기"
          className="v3-task-board-resource-tabs-chevron v3-task-board-resource-tabs-chevron--left"
          onClick={() => scrollByDirection(-1)}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      ) : null}
      <div
        ref={scrollerRef}
        className="v3-task-board-resource-tabs"
        role="tablist"
        aria-label="업무 자료"
        onScroll={refreshOverflow}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTabId}
            aria-controls="v3-task-board-resource-panel"
            title={tab.title}
            onClick={() => onActiveTabChange(tab.id)}
          >
            {tab.kind === "checklist" ? "✓" : tab.kind === "sessions" ? "↳" : tab.kind === "custom_view" ? "◇" : "▤"}
            <span>{tab.title}</span>
          </button>
        ))}
      </div>
      {overflow.canScrollRight ? (
        <DashboardIconCap
          label="다음 탭 보기"
          className="v3-task-board-resource-tabs-chevron v3-task-board-resource-tabs-chevron--right"
          onClick={() => scrollByDirection(1)}
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      ) : null}
    </div>
  );
}

function TaskBoardSessionTree({
  sessionIds,
  sessions,
  runSessionLoadStates,
  activeSessionId,
  onOpenSession,
  onNewSession,
}: {
  sessionIds: readonly string[];
  sessions: readonly SessionSummary[];
  runSessionLoadStates: ReadonlyMap<string, RunSessionLoadState>;
  activeSessionId: string | null;
  onOpenSession(session: SessionSummary): void;
  onNewSession?: () => void;
}) {
  const tree = useMemo(
    () => buildRunTree(sessionIds, sessions, runSessionLoadStates),
    [runSessionLoadStates, sessionIds, sessions],
  );
  return (
    <div className="v3-task-board-session-list">
      <div className="v3-task-board-session-head">
        <strong>세션 히스토리</strong>
        <span className="v3-task-board-session-count">{tree.length}회</span>
        {onNewSession ? (
          <DashboardIconCap label="새 세션" onClick={onNewSession}>
            <Plus className="h-4 w-4" aria-hidden="true" />
          </DashboardIconCap>
        ) : null}
      </div>
      {tree.length === 0 ? (
        <p className="v3-detail-empty">아직 실행된 세션이 없습니다.</p>
      ) : (
        <div className="v3-task-board-session-tree">
          {tree.map((node) => (
            <TaskBoardSessionNode
              key={node.session.agentSessionId}
              node={node}
              activeSessionId={activeSessionId}
              onOpenSession={onOpenSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskBoardSessionNode({
  node,
  activeSessionId,
  onOpenSession,
}: {
  node: RunTreeNode;
  activeSessionId: string | null;
  onOpenSession(session: SessionSummary): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const failed = node.loadState === "failed";
  const loading = node.loadState === "loading";
  return (
    <div className="v3-task-board-session-node">
      <RichSessionRow
        session={node.session}
        runNumber={node.runNumber}
        failed={failed}
        active={!failed && !loading && node.session.agentSessionId === activeSessionId}
        preview={loading ? "세션 정보를 불러오는 중…" : undefined}
        onOpen={onOpenSession}
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
        <div className="v3-task-board-session-children">
          {node.children.map((child) => (
            <TaskBoardSessionNode
              key={child.session.agentSessionId}
              node={child}
              activeSessionId={activeSessionId}
              onOpenSession={onOpenSession}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TaskBoardDocumentReader({
  tab,
  onOpenDocument,
}: {
  tab: Extract<TaskBoardResourceTab, { kind: "document" }>;
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
  }, [tab.documentId]);

  return (
    <div className="v3-task-board-document-reader">
      <div className="v3-task-board-document-reader-head">
        <strong>{document?.title ?? tab.title}</strong>
        <DashboardIconCap label={`${tab.title} 편집기 열기`} onClick={onOpenDocument}>
          <SquarePen className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </div>
      {error ? <p className="v3-inline-board-error">문서를 불러오지 못했습니다. {error}</p> : null}
      {!document && !error ? <p className="v3-detail-empty">본문을 불러오는 중…</p> : null}
      {document ? <div className="v3-task-board-document-copy"><MarkdownContent content={document.body} /></div> : null}
    </div>
  );
}
