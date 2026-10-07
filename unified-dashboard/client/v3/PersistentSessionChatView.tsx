import { useEffect, type RefObject } from "react";
import { ChatView, useDashboardStore, type ChatSessionStoreScope } from "@seosoyoung/soul-ui";
import { createPersistentSessionsApi } from "../lib/persistent-sessions";

type PersistentSessionChatViewProps = {
  sessionId: string;
  presentation?: "default" | "manuscript";
  composerAnchorRef?: RefObject<HTMLDivElement | null>;
  storeScope?: ChatSessionStoreScope;
  loadDisplaySettings?: boolean;
} & Omit<NonNullable<Parameters<typeof ChatView>[0]>, "presentation" | "composerAnchorRef">;

export function PersistentSessionChatView({ sessionId, storeScope, loadDisplaySettings = true, ...props }: PersistentSessionChatViewProps) {
  const setGlobalDisplaySettings = useDashboardStore((state) => state.setPersistentSessionDisplaySettings);
  const setDisplaySettings = storeScope?.store.getState().setPersistentSessionDisplaySettings
    ?? setGlobalDisplaySettings;
  useEffect(() => {
    if (!loadDisplaySettings) return;
    let active = true;
    setDisplaySettings(sessionId, null);
    void createPersistentSessionsApi().get(sessionId).then(({ session }) => {
      if (!active) return;
      setDisplaySettings(sessionId, session.persistent ? session.settings : null);
    }).catch(() => {
      if (active) setDisplaySettings(sessionId, null);
    });
    return () => { active = false; };
  }, [loadDisplaySettings, sessionId, setDisplaySettings]);
  return <ChatView {...props} storeScope={storeScope} />;
}
