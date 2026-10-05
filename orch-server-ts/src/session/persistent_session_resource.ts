import {
  PERSISTENT_SETTINGS_DEFAULTS,
  readPersistentEnabled,
  readPersistentPendingTarget,
  readStoredPersistentSettings,
  type PersistentPendingTarget,
} from "@soulstream/wire-schema/persistent-session-settings";

/** Model selection as the settings screens see it; the preset is null until a real one is chosen. */
export type PersistentModelSelectionView = {
  model_preset: string | null;
  reasoning_effort: string | null;
};

export type PersistentSettingsView = {
  default_model: PersistentModelSelectionView;
  fallback_model: PersistentModelSelectionView | null;
  show_generation_separator: boolean;
  show_character: boolean;
  show_jev_candidates: boolean;
  show_turn_usage: boolean;
  animate_character: boolean;
};

export type PersistentSessionResource = {
  session_id: string;
  display_name: string | null;
  node_id: string | null;
  folder_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  persistent: boolean;
  settings: PersistentSettingsView;
  runtime: {
    current_model: PersistentModelSelectionView & { model: string | null };
    pending: PersistentPendingTarget | null;
  };
};

/** Row fields the resource is built from. `session_get` and the PAS list both provide them. */
export type PersistentSessionRowSource = Record<string, unknown>;

export function currentModelOfRow(row: PersistentSessionRowSource): PersistentModelSelectionView & { model: string | null } {
  return {
    model_preset: stringOrNull(row.model_preset),
    // "auto" is the DB-internal marker for "no explicit effort"; public views report it as unspecified.
    reasoning_effort: row.reasoning_effort === "auto" ? null : stringOrNull(row.reasoning_effort),
    model: stringOrNull(row.model),
  };
}

export function buildPersistentSessionResource(
  row: PersistentSessionRowSource,
  agentName: string | null,
): PersistentSessionResource {
  const current = currentModelOfRow(row);
  const stored = readStoredPersistentSettings(row.metadata);
  // A PAS that predates persistent_settings reads as its current model with server display defaults;
  // nothing is written until the first save.
  const settings: PersistentSettingsView = stored === undefined
    ? {
        default_model: { model_preset: current.model_preset, reasoning_effort: current.reasoning_effort },
        fallback_model: null,
        show_generation_separator: PERSISTENT_SETTINGS_DEFAULTS.show_generation_separator,
        show_character: PERSISTENT_SETTINGS_DEFAULTS.show_character,
        show_jev_candidates: PERSISTENT_SETTINGS_DEFAULTS.show_jev_candidates,
        show_turn_usage: PERSISTENT_SETTINGS_DEFAULTS.show_turn_usage,
        animate_character: PERSISTENT_SETTINGS_DEFAULTS.animate_character,
      }
    : {
        default_model: stored.default_model ?? { model_preset: null, reasoning_effort: null },
        fallback_model: stored.fallback_model,
        show_generation_separator: stored.show_generation_separator,
        show_character: stored.show_character,
        show_jev_candidates: stored.show_jev_candidates,
        show_turn_usage: stored.show_turn_usage,
        animate_character: stored.animate_character,
      };
  const agentId = stringOrNull(row.agent_id);
  return {
    session_id: String(row.session_id),
    display_name: typeof row.display_name === "string" ? row.display_name : null,
    node_id: stringOrNull(row.node_id),
    folder_id: stringOrNull(row.folder_id),
    agent_id: agentId,
    agent_name: agentName ?? agentId,
    persistent: readPersistentEnabled(row.metadata),
    settings,
    runtime: {
      current_model: current,
      pending: readPersistentPendingTarget(row.metadata),
    },
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
