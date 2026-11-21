import { FrameLoading } from "../FrameLoading";
import type { HistoryLoadBlockReason } from "./useMessageHistoryBuffer";

interface ChatHistoryStatusProps {
  loading: boolean;
  blockedReason: HistoryLoadBlockReason | null;
  onRetry: () => void;
}

/**
 * Virtuoso Header와 0행 fallback이 공유하는 과거 대화 상태 표면.
 * 오류에서만 사용자 재시도 버튼을 표시한다.
 */
export function ChatHistoryStatus({
  loading,
  blockedReason,
  onRetry,
}: ChatHistoryStatusProps) {
  if (blockedReason !== null) {
    return (
      <div className="flex justify-center px-3 py-2">
        <button
          type="button"
          disabled={loading}
          onClick={onRetry}
          className="rounded-full border border-glass-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-wait disabled:opacity-60"
        >
          {loading ? "이전 대화를 불러오는 중" : "이전 대화를 불러오지 못했습니다. 다시 시도"}
        </button>
      </div>
    );
  }

  if (loading) {
    return <FrameLoading inline label="이전 대화를 불러오는 중" />;
  }

  return null;
}
