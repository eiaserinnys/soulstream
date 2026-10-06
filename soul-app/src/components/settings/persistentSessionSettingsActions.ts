import type {
  PersistentSessionResource,
  PersistentSessionSettingsPatch,
  PersistentSessionWrite,
} from '../../api/persistentSessionEndpoints';
import type { PersistentChatDisplaySettings } from '../../store/chatStore';

type PersistentSessionUpdater = {
  updatePersistentSession(
    sessionId: string,
    input: PersistentSessionWrite,
  ): Promise<{ session: PersistentSessionResource; model_change: 'none' | 'next_execution_start' }>;
};

export async function savePersistentSessionSettings(
  api: PersistentSessionUpdater,
  sessionId: string,
  settings: PersistentSessionSettingsPatch,
  displayName?: string,
): Promise<PersistentSessionResource> {
  const input: PersistentSessionWrite = displayName === undefined
    ? { settings }
    : { display_name: displayName, settings };
  return (await api.updatePersistentSession(sessionId, input)).session;
}

export function persistentChatDisplaySettings(session: PersistentSessionResource): PersistentChatDisplaySettings {
  return {
    show_generation_separator: session.settings.show_generation_separator === true,
    show_jev_candidates: session.settings.show_jev_candidates === true,
    show_character: session.settings.show_character !== false,
    animate_character: session.settings.animate_character !== false,
    show_turn_usage: session.settings.show_turn_usage !== false,
  };
}
