import { useTranslation } from "react-i18next";
import { memo, useRef } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { useChatStore } from "../../stores/chat-store-scope";
import { ProfileAvatar } from "../ProfileAvatar";
import { useGlassSurface } from "../LiquidGlassProvider";

export const ChatThinkingIndicator = memo(function ChatThinkingIndicator({ presentation = "default" }: { presentation?: "default" | "manuscript" }) {
  const { t } = useTranslation();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const webglActive = useGlassSurface(bubbleRef, { enabled: presentation !== "manuscript" });
  const activeSession = useChatStore((state) => state.activeSessionSummary);

  if (presentation === "manuscript") {
    return (
      <div className="flex items-center gap-2 py-1.5 text-muted-foreground" data-slot="chat-thinking-indicator">
        <ThinkingOrb
          state="working"
          size={20}
          theme="auto"
          aria-label={t("ui.chat.thinking")}
          data-thinking-orb-state="working"
        />
        <span aria-hidden="true" className="text-xs leading-none text-muted-foreground">{t("ui.chat.thinkingProgress")}</span>
      </div>
    );
  }

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
        className="flex max-w-[86%] items-center gap-2 rounded-floor bg-[var(--lg-card)] px-3.5 py-2.5 shadow-[0_6px_20px_-14px_rgb(20_26_40_/_45%)]"
        data-liquid-glass-webgl={webglActive ? "true" : undefined}
      >
        <ThinkingOrb
          state="working"
          size={20}
          theme="auto"
          aria-label={t("ui.chat.thinking")}
          data-thinking-orb-state="working"
        />
        <span
          aria-hidden="true"
          className="text-xs leading-none text-muted-foreground"
        >
          {t("ui.chat.thinkingProgress")}
        </span>
      </div>
    </div>
  );
});
