import { useEffect, useRef } from 'react';
import { type ApiClient } from '../../api/client';
import { useChatStore } from '../../store/chatStore';
import { persistentChatDisplaySettings } from '../settings/persistentSessionSettingsActions';

export function usePersistentChatDisplaySettings(
  api: ApiClient | null,
  detailedNetworkActive: boolean,
  sessionId: string | undefined,
  ownsSessionConnection = true,
) {
  const settings = useChatStore(state => sessionId
    ? state.persistentDisplaySettingsBySession[sessionId]
    : undefined);
  const beginLoad = useChatStore(state => state.beginPersistentDisplaySettingsLoad);
  const finishLoad = useChatStore(state => state.finishPersistentDisplaySettingsLoad);
  const clearSettings = useChatStore(state => state.clearPersistentDisplaySettings);
  const displaySettingsSessionRef = useRef(sessionId);

  useEffect(() => {
    if (!ownsSessionConnection) return;
    const previousSessionId = displaySettingsSessionRef.current;
    if (previousSessionId !== sessionId) clearSettings(previousSessionId);
    displaySettingsSessionRef.current = sessionId;
    if (!sessionId || !api) clearSettings(sessionId);
  }, [api, clearSettings, ownsSessionConnection, sessionId]);

  useEffect(() => {
    if (!ownsSessionConnection) return;
    if (!sessionId || !api) {
      clearSettings(sessionId);
      return;
    }
    if (!detailedNetworkActive) return;
    let active = true;
    const requestId = beginLoad(sessionId);
    void api.getPersistentSession(sessionId).then(({ session }) => {
      if (!active) return;
      const nextSettings = session.persistent ? persistentChatDisplaySettings(session) : null;
      finishLoad(sessionId, requestId, nextSettings);
    }).catch(() => {
      if (active) finishLoad(sessionId, requestId, null);
    });
    return () => { active = false; };
  }, [api, beginLoad, clearSettings, detailedNetworkActive, finishLoad, ownsSessionConnection, sessionId]);

  const current = settings?.settings;
  return {
    persistentDisplaySettings: current ? {
      showGenerationSeparator: current.show_generation_separator,
      showJevCandidates: current.show_jev_candidates,
    } : undefined,
    showTurnUsage: current?.show_turn_usage !== false,
  };
}
