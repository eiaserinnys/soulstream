import type { ApiRequestContext } from './clientCore';

/** A model choice as the server stores it. The preset is null only when nothing valid was recorded. */
export interface PersistentSessionModel {
  model_preset: string | null;
  reasoning_effort: string | null;
}

export interface PersistentSessionSettings {
  default_model: PersistentSessionModel;
  /** Stored by the server and not shown or edited by this app. */
  fallback_model?: PersistentSessionModel | null;
  show_generation_separator?: boolean;
  show_character?: boolean;
  show_jev_candidates?: boolean;
  animate_character?: boolean;
  show_turn_usage?: boolean;
}

export interface PersistentSessionResource {
  session_id: string;
  display_name: string | null;
  /** The server reads both from the stored row, so an old or half-registered session can have neither. */
  node_id: string | null;
  folder_id: string | null;
  agent_id: string | null;
  agent_name?: string | null;
  persistent: boolean;
  settings: PersistentSessionSettings;
  runtime: {
    current_model: PersistentSessionModel & { model: string | null };
    pending: { target_model_preset: string | null; target_reasoning_effort: string | null } | null;
  };
}

export interface PersistentSessionCreateDefaults {
  node_id: string;
  preferred_agent_id: string | null;
  settings: PersistentSessionSettings;
  /** The sentence the server uses when the first message is left empty. */
  initial_instruction: string;
  unavailable_reason: string | null;
}

/** Partial settings the server accepts on PUT; omitted keys keep their stored values. */
export interface PersistentSessionSettingsPatch {
  default_model?: PersistentSessionModelWrite;
  fallback_model?: PersistentSessionModelWrite | null;
  show_generation_separator?: boolean;
  show_character?: boolean;
  show_jev_candidates?: boolean;
  animate_character?: boolean;
  show_turn_usage?: boolean;
}

/** Model fields used when changing the default model. */
export interface PersistentSessionModelWrite {
  model_preset: string;
  reasoning_effort: string | null;
}

/** The server takes any of the three; `enabled: false` cannot be combined with a name or settings. */
export type PersistentSessionWrite =
  | { enabled: false }
  | { display_name?: string; enabled?: true; settings?: PersistentSessionSettingsPatch };

export interface PersistentSessionCreate {
  display_name: string;
  agent_id: string;
  folder_id: string;
  initial_instruction: string;
  settings: { default_model: PersistentSessionModelWrite };
}

export interface PersistentSessionInstruction {
  id: string;
  text: string;
  source_turns: string[];
  created_at: string;
  updated_at: string;
  origin: string;
}

export interface PersistentSessionInstructionWrite {
  text?: string;
  status?: 'active' | 'removed';
}

export function createPersistentSessionEndpoints({ base, authFetch, readJson }: ApiRequestContext) {
  const root = `${base}/api/persistent-sessions`;
  const itemUrl = (sessionId: string) => `${root}/${encodeURIComponent(sessionId)}`;
  return {
    listPersistentSessions: (): Promise<{
      sessions: PersistentSessionResource[];
      total: number;
      create_defaults: PersistentSessionCreateDefaults;
    }> => authFetch(root).then((response) => readJson(response, 'listPersistentSessions')),
    getPersistentSession: (sessionId: string): Promise<{ session: PersistentSessionResource }> =>
      authFetch(itemUrl(sessionId)).then((response) => readJson(response, 'getPersistentSession')),
    updatePersistentSession: (sessionId: string, input: PersistentSessionWrite): Promise<{
      session: PersistentSessionResource;
      model_change: 'none' | 'next_execution_start';
    }> => authFetch(itemUrl(sessionId), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }).then((response) => readJson(response, 'updatePersistentSession')),
    createPersistentSession: (input: PersistentSessionCreate): Promise<{
      session: PersistentSessionResource;
      creation: 'started';
      warnings: unknown[];
    }> => authFetch(root, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }).then((response) => readJson(response, 'createPersistentSession')),
    getPersistentSessionInstructions: (sessionId: string): Promise<{ instructions: PersistentSessionInstruction[] }> =>
      authFetch(`${itemUrl(sessionId)}/instructions`).then((response) => readJson(response, 'getPersistentSessionInstructions')),
    createPersistentSessionInstruction: (sessionId: string, text: string): Promise<{ instruction: PersistentSessionInstruction }> =>
      authFetch(`${itemUrl(sessionId)}/instructions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      }).then((response) => readJson(response, 'createPersistentSessionInstruction')),
    updatePersistentSessionInstruction: (sessionId: string, instructionId: string, input: PersistentSessionInstructionWrite): Promise<{ instruction: PersistentSessionInstruction }> =>
      authFetch(`${itemUrl(sessionId)}/instructions/${encodeURIComponent(instructionId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      }).then((response) => readJson(response, 'updatePersistentSessionInstruction')),
  };
}
