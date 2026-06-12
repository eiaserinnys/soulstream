/**
 * FeedTopBar - 피드 뷰 상단 바
 *
 * 'Feeds' 제목과 선택적 'New' 버튼을 표시한다.
 */

import { Button } from "./ui/button";
import { Plus } from "lucide-react";

export interface FeedTopBarProps {
  onNewSession?: () => void;
}

export function FeedTopBar({ onNewSession }: FeedTopBarProps) {
  return (
    <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
      <div className="min-w-0">
        <div className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
          전역 피드
        </div>
        <div className="mt-0.5 truncate text-sm font-semibold text-foreground">
          최근 활동
        </div>
      </div>
      {onNewSession && (
        <Button
          size="sm"
          onClick={onNewSession}
          title="New session"
          className="h-8 rounded-full bg-gradient-to-b from-[#2E96FF] to-[#0A84FF] px-3 text-white shadow-[0_8px_20px_-8px_rgb(10_132_255_/_60%)] hover:from-[#2E96FF] hover:to-[#0A84FF] hover:opacity-95"
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      )}
    </div>
  );
}
