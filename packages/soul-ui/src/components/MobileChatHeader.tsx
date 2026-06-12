/**
 * MobileChatHeader - 모바일 채팅 뷰 상단 헤더
 *
 * 백 버튼(← Sessions)과 현재 세션 정보를 표시합니다.
 */

import { ArrowLeft } from "lucide-react";
import { Button } from "./ui/button";
import { useDashboardStore } from "../stores/dashboard-store";
import { ProfileAvatar } from "./ProfileAvatar";
import { STATUS_CONFIG } from "./SessionItem";
import { cn } from "../lib/cn";

export function MobileChatHeader({
  onBack,
}: {
  onBack: () => void;
}) {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const activeSession = useDashboardStore((s) => s.activeSessionSummary);
  const statusConfig = STATUS_CONFIG[activeSession?.status ?? "unknown"] ?? STATUS_CONFIG.unknown;

  const displayText =
    activeSession?.displayName ||
    activeSession?.lastMessage?.preview ||
    activeSession?.prompt ||
    activeSessionKey ||
    "No session";

  return (
    <div className="shrink-0 px-3 py-2">
      <div className="flex h-[50px] items-center gap-2 rounded-full border border-glass-border glass-strong glass-shadow-xs px-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          data-testid="mobile-back-button"
          className="h-9 w-9 rounded-full"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <ProfileAvatar
          role="assistant"
          hasPortrait={!!activeSession?.agentPortraitUrl}
          fallbackEmoji="🤖"
          portraitUrl={activeSession?.agentPortraitUrl}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {displayText}
          </div>
          <div className={cn("mt-0.5 flex items-center gap-1 text-[10.5px] font-semibold", statusConfig.chipClass)}>
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                statusConfig.dotClass,
                statusConfig.animate && "animate-[lg-pulse_1.6s_infinite]",
              )}
            />
            {statusConfig.label}
          </div>
        </div>
      </div>
    </div>
  );
}
