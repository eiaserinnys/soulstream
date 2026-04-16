/**
 * FeedItem — 폴더 트리 상단의 특수 "📰 피드" 항목
 *
 * 일반 폴더 항목(FolderItem)과 달리 DnD/컨텍스트 메뉴/편집이 없고,
 * 클릭 시 viewMode를 "feed"로 전환한다.
 * 미읽음 카운트는 useFeedUnreadCount 훅으로 자체 조회한다.
 */

import { useDashboardStore } from "../stores/dashboard-store";
import { useFeedUnreadCount } from "../hooks/useFeedSessions";
import { cn } from "../lib/cn";
import { Badge } from "./ui/badge";
import { Newspaper } from "lucide-react";

export function FeedItem() {
  const viewMode = useDashboardStore((s) => s.viewMode);
  const selectFeed = useDashboardStore((s) => s.selectFeed);
  const feedUnreadCount = useFeedUnreadCount();

  return (
    <div
      className={cn(
        "flex items-center justify-between px-3 py-1.5 cursor-pointer text-sm hover:bg-accent/50",
        viewMode === "feed" && "bg-accent text-accent-foreground",
      )}
      onClick={selectFeed}
    >
      <div className="flex items-center gap-1.5">
        <Newspaper className="h-3.5 w-3.5" />
        <span>피드</span>
      </div>
      {feedUnreadCount > 0 ? (
        <Badge variant="destructive" className="ml-2 text-xs font-bold">
          {feedUnreadCount}
        </Badge>
      ) : null}
    </div>
  );
}
