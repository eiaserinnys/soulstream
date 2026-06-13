/**
 * FeedTopBar - 피드 뷰 상단 바
 *
 * 'Feeds' 제목과 선택적 'New' 버튼을 표시한다.
 */

import { Button } from "./ui/button";
import { Plus } from "lucide-react";

export interface FeedTopBarProps {
  onNewSession?: () => void;
  placement?: "main" | "sidebar";
}

export function FeedTopBar({ onNewSession, placement = "main" }: FeedTopBarProps) {
  if (placement === "sidebar") {
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
            className="h-8 rounded-full px-3"
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="shrink-0 px-4 pb-4 pt-3">
      <nav className="flex min-w-0 items-center gap-1.5 px-1 pb-1.5 text-xs text-muted-foreground/80">
        <span>워크스페이스</span>
        <span className="opacity-60">›</span>
        <span>최근 활동</span>
      </nav>
      <div className="flex min-w-0 items-center gap-3 px-1">
      <div className="min-w-0">
        <div className="truncate text-[22px] font-bold leading-tight text-foreground">
          최근 활동
        </div>
      </div>
      {onNewSession && (
        <Button
          size="sm"
          onClick={onNewSession}
          title="New session"
          className="ml-auto h-[38px] rounded-full px-4"
        >
          <Plus className="h-3.5 w-3.5" />
          새 세션
        </Button>
      )}
      </div>
    </div>
  );
}
