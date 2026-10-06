import { useEffect, type RefObject } from "react";
import { ChatView, useDashboardStore } from "@seosoyoung/soul-ui";
import { createPersistentSessionsApi } from "../lib/persistent-sessions";

type PersistentSessionChatViewProps = {
  sessionId: string;
  presentation?: "default" | "manuscript";
  composerAnchorRef?: RefObject<HTMLDivElement | null>;
} & Omit<NonNullable<Parameters<typeof ChatView>[0]>, "presentation" | "composerAnchorRef">;

export function PersistentSessionChatView({ sessionId, ...props }: PersistentSessionChatViewProps) {
  const setDisplaySettings = useDashboardStore((state) => state.setPersistentSessionDisplaySettings);
  useEffect(() => {
    let active = true;
    setDisplaySettings(sessionId, null);
    void createPersistentSessionsApi().get(sessionId).then(({ session }) => {
      if (!active) return;
      setDisplaySettings(sessionId, session.persistent ? session.settings : null);
    }).catch(() => {
      if (active) setDisplaySettings(sessionId, null);
    });
    return () => { active = false; };
  }, [sessionId, setDisplaySettings]);
  return <ChatView {...props} />;
}
