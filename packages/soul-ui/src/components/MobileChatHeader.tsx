/**
 * MobileChatHeader - 모바일 채팅 뷰 상단 헤더
 *
 * 백 버튼(← Sessions)과 현재 세션 정보를 표시합니다.
 */

import { ArrowLeft } from "lucide-react";
import { Button } from "./ui/button";
import { useDashboardStore } from "../stores/dashboard-store";

export function MobileChatHeader({
  onBack,
}: {
  onBack: () => void;
}) {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const sessions = useDashboardStore((s) => s.sessions);

  const activeSession = activeSessionKey
    ? sessions.find((s) => s.agentSessionId === activeSessionKey)
    : null;

  const displayText =
    activeSession?.displayName ||
    activeSession?.lastMessage?.preview ||
    activeSession?.prompt ||
    activeSessionKey ||
    "No session";

  return (
    <div className="flex items-center gap-2 px-2 h-10 border-b border-border bg-popover shrink-0">
      <Button
        variant="ghost"
        size="icon"
        onClick={onBack}
        data-testid="mobile-back-button"
      >
        <ArrowLeft className="h-5 w-5" />
      </Button>
      <span className="text-sm font-medium truncate flex-1">
        {displayText}
      </span>
    </div>
  );
}
