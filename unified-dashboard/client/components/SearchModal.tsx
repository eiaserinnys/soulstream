/**
 * SearchModal - 세션 기록 BM25 전문 검색 모달 (unified-dashboard)
 *
 * soul-dashboard의 SearchModal에서 포팅.
 * 탑바 검색 버튼 클릭 시 열리며, 300ms debounce 자동 검색을 수행합니다.
 * 결과 클릭 시 해당 세션으로 이동하고 이벤트 위치로 자동 스크롤합니다.
 *
 * 검색 엔드포인트: /cogito/search (BFF 없이 soul-server 직접 접근)
 */

import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  useDashboardStore,
  cn,
} from "@seosoyoung/soul-ui";
import { Search } from "lucide-react";
import {
  useSessionSearch,
  type SearchResultItem,
  type SearchFilters,
} from "../hooks/useSessionSearch";

// === Filter state ===

interface FilterState {
  sessionId: boolean;
  userMessage: boolean;
  agentResponse: boolean;
  agentThinking: boolean;
  toolUse: boolean;
}

const DEFAULT_FILTER_STATE: FilterState = {
  sessionId: true,
  userMessage: true,
  agentResponse: true,
  agentThinking: false,
  toolUse: false,
};

const FILTER_LABELS: { key: keyof FilterState; label: string }[] = [
  { key: "sessionId", label: "세션 아이디" },
  { key: "userMessage", label: "사용자 메시지" },
  { key: "agentResponse", label: "에이전트 응답" },
  { key: "agentThinking", label: "에이전트 내부 사고" },
  { key: "toolUse", label: "툴 사용" },
];

function toSearchFilters(state: FilterState): SearchFilters {
  const eventTypes: string[] = [];
  if (state.userMessage) eventTypes.push("user_message");
  if (state.agentResponse) eventTypes.push("text_delta");
  if (state.agentThinking) eventTypes.push("thinking");
  if (state.toolUse) eventTypes.push("tool_use", "tool_start", "tool_result");
  return {
    searchSessionId: state.sessionId,
    eventTypes: eventTypes.length > 0 ? eventTypes : null,
  };
}

// === Event type label mapping ===

const EVENT_TYPE_LABEL: Record<string, string> = {
  user_message: "User",
  text_delta: "Assistant",
  thinking: "Thinking",
  tool_use: "Tool",
  tool_result: "Tool Result",
};

function eventTypeLabel(eventType: string): string {
  return EVENT_TYPE_LABEL[eventType] ?? eventType;
}

// === Search Result Item ===

function SearchResultRow({
  result,
  onClick,
}: {
  result: SearchResultItem;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-2.5 rounded-lg border border-transparent",
        "hover:bg-muted/60 hover:border-border transition-colors",
        "focus:outline-none focus:bg-muted/60",
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-mono text-muted-foreground bg-input px-1.5 py-0.5 rounded shrink-0">
          {eventTypeLabel(result.event_type)}
        </span>
        <span className="text-[11px] text-muted-foreground truncate font-mono">
          {result.session_id.slice(0, 20)}…
        </span>
        <span className="text-[11px] text-muted-foreground/60 ml-auto shrink-0">
          #{result.event_id}
        </span>
      </div>
      <p className="text-[13px] text-foreground line-clamp-2 break-words">
        {result.preview}
      </p>
    </button>
  );
}

// === Props ===

interface SearchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// === Main Component ===

export function SearchModal({ open, onOpenChange }: SearchModalProps) {
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const setFocusEventId = useDashboardStore((s) => s.setFocusEventId);
  const { results, loading, error, search, clear } = useSessionSearch();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTER_STATE);

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
      search(queryRef.current, toSearchFilters(filters));
    }
    // queryRef로 최신 query를 읽으므로 query는 deps에서 제외
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, search]);

  const handleResultClick = (result: SearchResultItem) => {
    setActiveSession(result.session_id);
    setFocusEventId(result.event_id);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>세션 기록 검색</DialogTitle>
        </DialogHeader>

        <DialogPanel scrollFade={false}>
          {/* 검색 입력창 */}
          <div className="relative mb-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              autoFocus
              type="text"
              placeholder="검색어를 입력하세요..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={cn(
                "w-full rounded-lg border border-border bg-background pl-9 pr-3 py-2 text-[14px]",
                "focus:outline-none focus:ring-1 focus:ring-ring",
                "placeholder:text-muted-foreground",
              )}
            />
          </div>

          {/* 필터 체크박스 */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3">
            {FILTER_LABELS.map(({ key, label }) => (
              <label
                key={key}
                className="flex items-center gap-1.5 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={filters[key]}
                  onChange={(e) =>
                    setFilters((prev) => ({ ...prev, [key]: e.target.checked }))
                  }
                  className="w-3.5 h-3.5 rounded accent-primary"
                />
                <span className="text-[12px] text-muted-foreground">{label}</span>
              </label>
            ))}
          </div>

          {/* 상태 표시 */}
          {loading && (
            <div className="flex items-center justify-center py-6 text-muted-foreground text-[13px]">
              <span className="inline-block w-4 h-4 border border-muted-foreground/40 border-t-muted-foreground rounded-full animate-spin mr-2" />
              검색 중...
            </div>
          )}

          {error && !loading && (
            <div className="py-4 text-center text-[13px] text-accent-red">
              ❌ {error}
            </div>
          )}

          {!loading && !error && results.length === 0 && query.trim() && (
            <div className="py-6 text-center text-[13px] text-muted-foreground">
              검색 결과가 없습니다
            </div>
          )}

          {!loading && !error && results.length === 0 && !query.trim() && (
            <div className="py-6 text-center text-[13px] text-muted-foreground">
              위 필터를 선택하여 세션 기록을 검색합니다
            </div>
          )}

          {/* 결과 목록 */}
          {!loading && results.length > 0 && (
            <div className="space-y-1 max-h-[400px] overflow-y-auto">
              <div className="text-[11px] text-muted-foreground mb-2 px-1">
                {results.length}개 결과
              </div>
              {results.map((result) => (
                <SearchResultRow
                  key={`${result.session_id}-${result.event_id}`}
                  result={result}
                  onClick={() => handleResultClick(result)}
                />
              ))}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
