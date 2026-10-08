import type {
  PersistentSessionResource,
  PersistentSessionInstruction,
  PersistentSessionInstructionWrite,
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

type PersistentSessionInstructionApi = {
  getPersistentSessionInstructions(sessionId: string): Promise<{ instructions: PersistentSessionInstruction[] }>;
  createPersistentSessionInstruction(sessionId: string, text: string): Promise<{ instruction: PersistentSessionInstruction }>;
  updatePersistentSessionInstruction(sessionId: string, instructionId: string, input: PersistentSessionInstructionWrite): Promise<{ instruction: PersistentSessionInstruction }>;
};

export const loadPersistentSessionInstructions = (
  api: PersistentSessionInstructionApi,
  sessionId: string,
) => api.getPersistentSessionInstructions(sessionId);

export const addPersistentSessionInstruction = (
  api: PersistentSessionInstructionApi,
  sessionId: string,
  text: string,
) => api.createPersistentSessionInstruction(sessionId, text);

export const updatePersistentSessionInstruction = (
  api: PersistentSessionInstructionApi,
  sessionId: string,
  instructionId: string,
  input: PersistentSessionInstructionWrite,
) => api.updatePersistentSessionInstruction(sessionId, instructionId, input);

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
    turn_usage_mode: session.settings.turn_usage_mode,
  };
}
