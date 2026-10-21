import { useEffect, useRef } from 'react';
import { type ApiClient } from '../../api/client';
import { useChatStore } from '../../store/chatStore';
import { useSessionStore } from '../../store/sessionStore';
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
    if (previousSessionId && previousSessionId !== sessionId) clearSettings(previousSessionId);
    displaySettingsSessionRef.current = sessionId;
    if (sessionId && !api) clearSettings(sessionId);
  }, [api, clearSettings, ownsSessionConnection, sessionId]);

  useEffect(() => {
    if (!ownsSessionConnection) return;
    if (!sessionId) return;
    if (!api) {
      clearSettings(sessionId);
      return;
    }
    if (!detailedNetworkActive) return;
    let active = true;
    const requestId = beginLoad(sessionId);
    const reportState = useSessionStore.getState();
    void api.getPersistentSession(sessionId).then(({ session }) => {
      if (!active) return;
      if (session.persistent_report !== undefined) useSessionStore.getState().applyPersistentReport(sessionId, session.persistent_report,
        { snapshot: reportState.persistentReportsBySession[sessionId], generation: reportState.scopeGeneration });
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
      showWorkDetails: current.show_work_details === true,
    } : undefined,
    turnUsageMode: current?.turn_usage_mode ?? 'collapsed',
  };
}
