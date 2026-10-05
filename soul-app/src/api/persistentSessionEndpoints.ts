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
}

export interface PersistentSessionResource {
  session_id: string;
  display_name: string | null;
  node_id: string;
  folder_id: string | null;
  agent_id: string;
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

/** Only the default model is sent from this app; omitted settings keep their stored values. */
export interface PersistentSessionModelWrite {
  model_preset: string;
  reasoning_effort: string | null;
}

export type PersistentSessionWrite =
  | { enabled: false }
  | {
      display_name: string;
      enabled?: true;
      settings: { default_model: PersistentSessionModelWrite };
    };

export interface PersistentSessionCreate {
  display_name: string;
  agent_id: string;
  folder_id: string;
  initial_instruction: string;
  settings: { default_model: PersistentSessionModelWrite };
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
  };
}
