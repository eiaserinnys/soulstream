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
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
      <span className="text-sm font-semibold">Feeds</span>
      {onNewSession && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewSession}
          title="New session"
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          New
        </Button>
      )}
    </div>
  );
}
