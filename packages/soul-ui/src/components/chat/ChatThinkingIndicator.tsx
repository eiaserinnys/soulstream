import { memo, useRef } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { useDashboardStore } from "../../stores/dashboard-store";
import { ProfileAvatar } from "../ProfileAvatar";
import { useGlassSurface } from "../LiquidGlassProvider";

export const ChatThinkingIndicator = memo(function ChatThinkingIndicator() {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const webglActive = useGlassSurface(bubbleRef, { enabled: true });
  const activeSession = useDashboardStore((state) => state.activeSessionSummary);

  return (
    <div
      className="flex gap-2 px-3 py-1.5"
      data-slot="chat-thinking-indicator"
    >
      <ProfileAvatar
        role="assistant"
        hasPortrait={!!activeSession?.agentPortraitUrl}
        fallbackEmoji="🤖"
        portraitUrl={activeSession?.agentPortraitUrl}
      />
      <div
        ref={bubbleRef}
        data-slot="chat-message-bubble"
        className="flex max-w-[86%] items-center gap-2 rounded-[17px] rounded-bl-[7px] bg-[var(--lg-card)] px-3.5 py-2.5 shadow-[0_6px_20px_-14px_rgb(20_26_40_/_45%)]"
        data-liquid-glass-webgl={webglActive ? "true" : undefined}
      >
        <ThinkingOrb
          state="working"
          size={20}
          theme="auto"
          aria-label="생각 중입니다"
          data-thinking-orb-state="working"
        />
        <span
          aria-hidden="true"
          className="text-xs leading-none text-muted-foreground"
        >
          생각 중입니다…
        </span>
      </div>
    </div>
  );
});
