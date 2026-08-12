import type { HistoryLoadBlockReason } from "./useMessageHistoryBuffer";

interface ChatHistoryStatusProps {
  loading: boolean;
  reachedTop: boolean;
  blockedReason: HistoryLoadBlockReason | null;
  onRetry: () => void;
  showReachedTop?: boolean;
}

/**
 * Virtuoso Header와 0행 fallback이 공유하는 과거 대화 상태 표면.
 * cap과 error는 같은 명시적 사용자 재시도 경로로 수렴한다.
 */
export function ChatHistoryStatus({
  loading,
  reachedTop,
  blockedReason,
  onRetry,
  showReachedTop = true,
}: ChatHistoryStatusProps) {
  if (blockedReason !== null) {
    return (
      <div className="flex justify-center px-3 py-2">
        <button
          type="button"
          disabled={loading}
          onClick={onRetry}
          className="rounded-md border border-glass-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-wait disabled:opacity-60"
        >
          {loading ? "이전 대화 불러오는 중..." : "이전 대화 더 불러오기"}
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-2 text-center text-muted-foreground text-sm">
        Loading earlier messages...
      </div>
    );
  }

  if (reachedTop && showReachedTop) {
    return (
      <div className="px-3 py-2 text-center text-muted-foreground text-sm opacity-60">
        {"\u2014"} Beginning of conversation {"\u2014"}
      </div>
    );
  }

  return null;
}
