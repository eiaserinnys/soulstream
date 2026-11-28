import { useTranslation } from "react-i18next";
import { useState, useEffect, useMemo, useRef } from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  FrameLoading,
  useDashboardStore,
  useUiEventEntryMarker,
  useUiEventTracker,
  useSessionMenu,
  applyCatalogSessionDisplayName,
  resolveSearchChatFocus,
  cn,
  type ChatFocusTarget,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { Search } from "lucide-react";
import {
  useSessionSearch,
  type SearchSessionResult,
  type SearchFilters,
  type SearchNavigationResult,
} from "../hooks/useSessionSearch";
import {
  searchEventTypeLabel,
  type SearchEventCategory,
  type SearchMatchSource,
  type SearchResultItem,
} from "@soulstream/search-contract";

interface FilterState {
  sessionId: boolean;
  userMessage: boolean;
  agentResponse: boolean;
  agentThinking: boolean;
  includeTurnSummaries: boolean;
  includeHighlight: boolean;
  includeStory: boolean;
}

const DEFAULT_FILTER_STATE: FilterState = {
  sessionId: true,
  userMessage: true,
  agentResponse: true,
  agentThinking: false,
  includeTurnSummaries: false,
  includeHighlight: false,
  includeStory: false,
};

const EVENT_FILTER_LABELS: { key: keyof FilterState; labelKey: string }[] = [
  { key: "sessionId", labelKey: "admin.search.sessionId" },
  { key: "userMessage", labelKey: "admin.search.userMessage" },
  { key: "agentResponse", labelKey: "admin.search.agentResponse" },
  { key: "agentThinking", labelKey: "admin.search.agentThinking" },
];

const DERIVED_FILTER_LABELS: { key: keyof FilterState; labelKey: string }[] = [
  { key: "includeTurnSummaries", labelKey: "admin.search.turnSummary" },
  { key: "includeHighlight", labelKey: "admin.search.highlight" },
  { key: "includeStory", labelKey: "admin.search.story" },
];

function toSearchFilters(state: FilterState): SearchFilters {
  const eventCategories: SearchEventCategory[] = [];
  if (state.userMessage) eventCategories.push("messages");
  if (state.agentResponse) eventCategories.push("responses");
  if (state.agentThinking) eventCategories.push("thinking");
  return {
    searchSessionId: state.sessionId,
    eventCategories,
    includeTurnSummaries: state.includeTurnSummaries,
    includeHighlight: state.includeHighlight,
    includeStory: state.includeStory,
  };
}

// === Search Result Item ===

const SEARCH_RESULT_KIND_BADGE_CLASS =
  "inline-flex w-20 shrink-0 items-center justify-center rounded-full bg-input px-1.5 py-0.5 text-xs text-muted-foreground";

const SEARCH_MATCH_SOURCE_KEYS: Record<
  Exclude<SearchMatchSource, "message">,
  string
> = {
  turn_summary: "admin.search.turnSummary",
  highlight: "admin.search.highlight",
  story: "admin.search.story",
};

function SearchResultRow({
  result,
  onClick,
}: {
  result: SearchResultItem;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const isDerivedMatch = result.match_source !== "message";
  const opensStoryPanel =
    result.match_source === "highlight" || result.match_source === "story";
  const badgeLabel =
    result.match_source === "message"
      ? searchEventTypeLabel(result.event_type)
      : t(SEARCH_MATCH_SOURCE_KEYS[result.match_source]);

  const openMenu = useSessionMenu();
  return (
    <button
      onClick={onClick}
      onContextMenu={event=>openMenu(result.session_id,event)}
      data-match-source={result.match_source}
      className={cn(
        "w-full text-left px-3 py-2.5 rounded-floor border transition-colors",
        "focus:outline-none focus:bg-muted/60",
        isDerivedMatch
          ? "border-border/50 bg-muted/25 hover:bg-muted/60"
          : "border-transparent hover:bg-muted/60 hover:border-border",
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <span
          className={cn(
            SEARCH_RESULT_KIND_BADGE_CLASS,
            result.match_source === "message" && "font-mono",
            isDerivedMatch && "bg-muted",
          )}
          aria-label={
            isDerivedMatch ? t("admin.search.matchSource", { source: badgeLabel }) : undefined
          }
        >
          {badgeLabel}
        </span>
        <span className="text-xs text-muted-foreground truncate font-mono">
          {result.session_id.slice(0, 20)}…
        </span>
        <span className="text-xs text-muted-foreground/60 ml-auto shrink-0">
          {opensStoryPanel ? t("admin.search.storyPanel") : `#${result.event_id}`}
        </span>
      </div>
      <p
        className={cn(
          "text-sm line-clamp-2 break-words",
          isDerivedMatch ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {result.preview}
      </p>
    </button>
  );
}

function SearchSessionResultRow({
  result,
  onClick,
}: {
  result: SearchSessionResult;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const openMenu = useSessionMenu();
  return (
    <button
      onClick={onClick}
      onContextMenu={event=>openMenu(result.session_id,event)}
      data-testid="session-search-result"
      data-session-id={result.session_id}
      className={cn(
        "w-full text-left px-3 py-2.5 rounded-floor border border-transparent",
        "hover:bg-muted/60 hover:border-border transition-colors",
        "focus:outline-none focus:bg-muted/60",
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={SEARCH_RESULT_KIND_BADGE_CLASS}>{t("admin.search.session")}</span>
        <span className="text-sm text-foreground truncate">{result.title}</span>
        {result.updated_at && (
          <time className="text-xs text-muted-foreground ml-auto shrink-0">
            {result.updated_at.slice(0, 10)}
          </time>
        )}
      </div>
      <p className="text-sm line-clamp-2 break-words text-muted-foreground">
        {result.excerpt}
      </p>
      {result.task_title && (
        <p className="mt-1 text-xs text-muted-foreground truncate">
          {t("admin.search.folderMatch", { name: result.task_title })}
        </p>
      )}
    </button>
  );
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => resolve());
      return;
    }
    globalThis.setTimeout(resolve, 0);
  });
}

async function openMountedSessionStoryPanel(): Promise<boolean> {
  await nextAnimationFrame();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const triggers = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="session-story-trigger"]',
      ),
    );
    if (triggers.some((trigger) => trigger.getAttribute("aria-expanded") === "true")) {
      return true;
    }
    const trigger =
      triggers.find((candidate) => candidate.getClientRects().length > 0) ??
      triggers[0];
    if (trigger) {
      trigger.click();
      return true;
    }
    await nextAnimationFrame();
  }
  return false;
}

function NavigationResultRow({
  result,
  onClick,
}: {
  result: SearchNavigationResult;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-2.5 rounded-floor border border-transparent",
        "hover:bg-muted/60 hover:border-border transition-colors",
        "focus:outline-none focus:bg-muted/60",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={SEARCH_RESULT_KIND_BADGE_CLASS}>
          {t("admin.search.folder")}
        </span>
        <span className="text-sm text-foreground truncate">{result.title}</span>
      </div>
    </button>
  );
}

// === Props ===

interface SearchModalProps {
  request?: typeof fetch;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions?: SessionSummary[];
  onOpenSession: (
    sessionId: string,
    focusEventId: number | null,
    session?: SessionSummary,
    focusTarget?: ChatFocusTarget,
  ) => boolean | void | Promise<boolean | void>;
  onOpenFolder: (result: SearchNavigationResult) => void | Promise<void>;
}

// === Main Component ===

export function SearchModal({
  request,
  open,
  onOpenChange,
  sessions = [],
  onOpenSession,
  onOpenFolder,
}: SearchModalProps) {
  const { t } = useTranslation();
  const catalog = useDashboardStore((s) => s.catalog);
  const activeSessionSummary = useDashboardStore((s) => s.activeSessionSummary);
  const { results, navigationResults, sessionResults, searchStatus, loading, expansionPending, expansionFailed, error, search, invalidate, clear, currentSearchFlowId } =
    useSessionSearch(request);
  // 사용 로그: 결과 선택과 그 뒤의 화면 전환을 같은 검색에 묶는다.
  const trackUiEvent = useUiEventTracker();
  const markEntry = useUiEventEntryMarker();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTER_STATE);
  const sessionById = useMemo(() => {
    const byId = new Map<string, SessionSummary>();
    for (const session of catalog?.sessionList ?? []) {
      byId.set(session.agentSessionId, session);
    }
    for (const session of sessions) {
      byId.set(session.agentSessionId, session);
    }
    if (activeSessionSummary) {
      byId.set(activeSessionSummary.agentSessionId, activeSessionSummary);
    }
    return byId;
  }, [activeSessionSummary, catalog?.sessionList, sessions]);

  // stale closure 방지용 ref
  const queryRef = useRef(query);
  queryRef.current = query;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  // 모달 닫힐 때 상태 초기화
  useEffect(() => {
    if (!open) {
      setQuery("");
      setFilters(DEFAULT_FILTER_STATE);
      clear();
    }
  }, [open, clear]);

  // Effect 1: query 변경 시 300ms debounce 검색
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim()) {
        search(query, toSearchFilters(filtersRef.current));
      } else {
        clear();
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, search, clear]);

  // Effect 2: filters 변경 시 즉시 재검색 (query가 비어있지 않을 때)
  useEffect(() => {
    if (queryRef.current.trim()) {
      search(queryRef.current, toSearchFilters(filters), 20, "filter");
    }
    // queryRef로 최신 query를 읽으므로 query는 deps에서 제외
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, search]);

  const handleResultClick = (result: SearchResultItem, rank: number) => {
    trackUiEvent("search_result_open", {
      flowId: currentSearchFlowId() ?? "unknown",
      target: { kind: "session", id: result.session_id },
      attrs: { rank, resultKind: result.match_source ?? "event" },
    });
    markEntry("search");
    const assignment = catalog?.sessions[result.session_id];
    const summary = sessionById.get(result.session_id);
    const targetSummary =
      summary && assignment
        ? applyCatalogSessionDisplayName(
            { ...summary, folderId: assignment.folderId },
            assignment,
          )
        : summary;
    const opensStoryPanel =
      result.match_source === "highlight" || result.match_source === "story";
    const searchFocus = resolveSearchChatFocus(result.event_id, result.event_type);
    const focusEventId = opensStoryPanel ? null : searchFocus.eventId;
    const focusTarget = opensStoryPanel ? undefined : searchFocus.target;
    const openResult = focusTarget === undefined || focusTarget === "event"
      ? onOpenSession(result.session_id, focusEventId, targetSummary)
      : onOpenSession(result.session_id, focusEventId, targetSummary, focusTarget);
    onOpenChange(false);
    if (opensStoryPanel) {
      void Promise.resolve(openResult)
        .then((opened) => {
          if (opened !== false) return openMountedSessionStoryPanel();
          return false;
        })
        .catch((storyOpenError) => {
          console.error("세션 스토리 패널 열기 실패", storyOpenError); // i18n-ignore: 개발자 콘솔 진단
        });
    }
  };

  const handleNavigationClick = (result: SearchNavigationResult, rank: number) => {
    trackUiEvent("search_result_open", {
      flowId: currentSearchFlowId() ?? "unknown",
      target: { kind: "folder", id: result.folder_id },
      attrs: { rank, resultKind: result.kind },
    });
    markEntry("search");
    void onOpenFolder(result);
    onOpenChange(false);
  };

  const handleSessionResultClick = async (result: SearchSessionResult, rank: number) => {
    trackUiEvent("search_result_open", {
      flowId: currentSearchFlowId() ?? "unknown",
      target: { kind: "session", id: result.session_id },
      attrs: { rank, resultKind: "session", matchSource: result.best_match.match_source },
    });
    markEntry("search");
    const assignment = catalog?.sessions[result.session_id];
    const summary = sessionById.get(result.session_id);
    const targetSummary = summary && assignment
      ? applyCatalogSessionDisplayName(
          { ...summary, folderId: assignment.folderId },
          assignment,
        )
      : summary;
    const opened = await onOpenSession(
      result.session_id,
      result.best_match.event_id,
      targetSummary,
    );
    if (opened === false) return;
    onOpenChange(false);
  };

  const sessionResultIds = useMemo(
    () => new Set(sessionResults.map((result) => result.session_id)),
    [sessionResults],
  );
  const remainingEventResults = results.filter((result) => !sessionResultIds.has(result.session_id));
  const resultCount = sessionResults.length + remainingEventResults.length + navigationResults.length;
  const searchIncomplete = expansionFailed
    || searchStatus?.search?.status === "partial"
    || searchStatus?.query_expansion?.status === "partial";
  const partialSearchMessage = expansionFailed
    ? t("admin.search.expansionError")
    : searchStatus?.search?.status === "partial"
    ? resultCount === 0
      ? t("admin.search.retrySearch")
      : searchStatus.search.stage === "lexical"
        ? t("admin.search.lexicalTimeout")
        : t("admin.search.timeout")
    : searchStatus?.db_cancel === "failed"
      ? t("admin.search.cancelError")
    : searchStatus?.query_expansion?.status === "partial"
      ? searchStatus.query_expansion.reason === "configuration"
        ? t("admin.search.semanticUnavailable")
      : t("admin.search.semanticLimited")
      : null;
  const showPartialSearchBanner = !loading
    && !error
    && partialSearchMessage !== null
    && !(resultCount === 0 && query.trim() && searchIncomplete);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("admin.search.title")}</DialogTitle>
        </DialogHeader>

        <DialogPanel scrollFade={false}>
          {/* 검색 입력창 */}
          <div className="relative mb-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              placeholder={t("admin.search.placeholder")}
              value={query}
              onChange={(e) => {
                if (e.target.value !== query) clear();
                setQuery(e.target.value);
              }}
              className={cn(
                "w-full rounded-floor border border-border bg-background pl-9 pr-3 py-2 text-base",
                "focus:outline-none focus:ring-1 focus:ring-ring",
                "placeholder:text-muted-foreground",
              )}
            />
          </div>

          {/* 이벤트 필터 체크박스 */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3">
            {EVENT_FILTER_LABELS.map(({ key, labelKey }) => (
              <label
                key={key}
                className="flex items-center gap-1.5 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={filters[key]}
                  onChange={(e) => {
                    invalidate();
                    setFilters((prev) => ({ ...prev, [key]: e.target.checked }));
                  }}
                  className="w-3.5 h-3.5 rounded-mark accent-primary"
                />
                <span className="text-xs text-muted-foreground">{t(labelKey)}</span>
              </label>
            ))}
          </div>

          {/* 파생 텍스트 포함 범위 */}
          <div
            className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-floor bg-muted/30 px-2.5 py-2"
            aria-label={t("admin.search.scope")}
          >
            <span className="text-xs font-medium text-muted-foreground">
              {t("admin.search.scopeHeading")}
            </span>
            {DERIVED_FILTER_LABELS.map(({ key, labelKey }) => (
              <label
                key={key}
                className="flex items-center gap-1.5 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={filters[key]}
                  onChange={(e) => {
                    invalidate();
                    setFilters((prev) => ({ ...prev, [key]: e.target.checked }));
                  }}
                  className="w-3.5 h-3.5 rounded-mark accent-primary"
                />
                <span className="text-xs text-muted-foreground">{t(labelKey)}</span>
              </label>
            ))}
          </div>

          {showPartialSearchBanner && (
            <div role="status" className="mb-2 rounded-floor bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-v3-selectable-content="true">
              {partialSearchMessage}
            </div>
          )}

          {expansionPending && !loading && (
            <div role="status" className="mb-2 px-1 text-xs text-muted-foreground">
              {t("admin.search.expanding")}
            </div>
          )}

          {/* 결과가 들어올 영역 — 로딩·실패·빈 상태·결과가 같은 높이에서 시작한다.
              로더는 이 영역(대화상자 본문 아래)의 가운데에서 기다린다. */}
          <div
            data-slot="search-results-region"
            className="flex min-h-40 min-w-0 flex-col"
          >
            {loading && <FrameLoading label={t("admin.search.loading")} />}

            {error && !loading && (
              <div className="flex flex-1 items-center justify-center px-2 py-4 text-center text-sm text-accent-red" data-v3-selectable-content="true">
                ❌ {error}
              </div>
            )}

            {!loading && !error && resultCount === 0 && query.trim() && (
              <div className="flex flex-1 items-center justify-center px-2 text-center text-sm text-muted-foreground">
                {expansionPending
                  ? t("admin.search.expanding")
                  : searchIncomplete
                  ? t("admin.search.retrySearch")
                  : t("admin.search.empty")}
              </div>
            )}

            {!loading && !error && resultCount === 0 && !query.trim() && (
              <div className="flex flex-1 items-center justify-center px-2 text-center text-sm text-muted-foreground">
                {t("admin.search.hint")}
              </div>
            )}

            {/* 결과 목록 */}
            {!loading && resultCount > 0 && (
              <div className="max-h-[400px] space-y-1 overflow-y-auto">
                <div className="mb-2 px-1 text-xs text-muted-foreground">
                  {t("admin.search.results", { count: resultCount })}
                </div>
                {navigationResults.map((result, index) => (
                  <NavigationResultRow
                    key={`${result.kind}-${result.id}`}
                    result={result}
                    onClick={() => handleNavigationClick(result, index)}
                  />
                ))}
                {sessionResults.map((result, index) => (
                  <SearchSessionResultRow
                    key={result.session_id}
                    result={result}
                    onClick={() => void handleSessionResultClick(result, navigationResults.length + index)}
                  />
                ))}
                {remainingEventResults.map((result, index) => (
                  <SearchResultRow
                    key={`${result.session_id}-${result.event_id}-${result.match_source}`}
                    result={result}
                    onClick={() =>
                      handleResultClick(result, navigationResults.length + sessionResults.length + index)}
                  />
                ))}
              </div>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
