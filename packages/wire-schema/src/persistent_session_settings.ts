/**
 * 영구 에이전트 세션(PAS) 설정의 저장 모양과 읽기·쓰기 계약.
 *
 * 저장소는 sessions.metadata JSONB 배열의 `persistent_settings` 항목 하나다.
 * orch(조회)와 worker(저장)가 같은 reader·default·검증을 쓰도록 여기 한 곳에 둔다.
 */

export const PERSISTENT_SETTINGS_METADATA_TYPE = "persistent_settings";

export const PERSISTENT_TURN_USAGE_MODES = ["collapsed", "expanded", "hidden"] as const;
export type PersistentTurnUsageMode = (typeof PERSISTENT_TURN_USAGE_MODES)[number];

export type PersistentModelSelection = {
  model_preset: string;
  /** null = 추론 수준을 지정하지 않음(백엔드 기본). */
  reasoning_effort: string | null;
};

export type PersistentSessionSettings = {
  default_model: PersistentModelSelection;
  fallback_model: PersistentModelSelection | null;
  show_generation_separator: boolean;
  show_character: boolean;
  /** 채팅 창의 Jev 후보 줄을 보일지 여부. */
  show_jev_candidates: boolean;
  turn_usage_mode: PersistentTurnUsageMode;
  /** 호환 응답·metadata 키. 정본은 turn_usage_mode다. */
  show_turn_usage: boolean;
  animate_character: boolean;
};

/** 부분 입력. 생략한 키는 저장된 값을 보존한다. */
export type PersistentSettingsPatch = Partial<PersistentSessionSettings>;

/** 저장된 항목을 읽은 결과. 쓸 수 있는 기본 모델이 없으면 default_model은 null이다. */
export type StoredPersistentSettings = Omit<PersistentSessionSettings, "default_model"> & {
  default_model: PersistentModelSelection | null;
};

/** 최초 등록 때 서버가 채우는 기본값. 기본 모델은 세션의 현재 모델에서 온다. */
export const PERSISTENT_SETTINGS_DEFAULTS = {
  fallback_model: { model_preset: "codex-6.1-sol", reasoning_effort: "high" },
  show_generation_separator: true,
  show_character: true,
  show_jev_candidates: true,
  turn_usage_mode: "collapsed",
  show_turn_usage: true,
  animate_character: true,
} as const satisfies Omit<PersistentSessionSettings, "default_model">;

export type PersistentPendingTarget = {
  target_model_preset: string;
  target_reasoning_effort: string | null;
};

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

const SETTINGS_KEYS = [
  "default_model",
  "fallback_model",
  "show_generation_separator",
  "show_character",
  "show_jev_candidates",
  "turn_usage_mode",
  "show_turn_usage",
  "animate_character",
] as const;

export function parsePersistentSettingsPatch(input: unknown): ParseResult<PersistentSettingsPatch> {
  if (!isRecord(input)) return { ok: false, message: "settings must be a JSON object" };
  const unknownKey = Object.keys(input).find((key) => !(SETTINGS_KEYS as readonly string[]).includes(key));
  if (unknownKey !== undefined) {
    return { ok: false, message: `settings.${unknownKey} is not supported` };
  }
  const patch: PersistentSettingsPatch = {};
  if (input.default_model !== undefined) {
    const parsed = parseModelSelection(input.default_model, "settings.default_model");
    if (!parsed.ok) return parsed;
    patch.default_model = parsed.value;
  }
  if (input.fallback_model !== undefined) {
    if (input.fallback_model === null) {
      patch.fallback_model = null;
    } else {
      const parsed = parseModelSelection(input.fallback_model, "settings.fallback_model");
      if (!parsed.ok) return parsed;
      patch.fallback_model = parsed.value;
    }
  }
  if (input.turn_usage_mode !== undefined) {
    if (!isPersistentTurnUsageMode(input.turn_usage_mode)) {
      return { ok: false, message: "settings.turn_usage_mode must be collapsed, expanded, or hidden" };
    }
    patch.turn_usage_mode = input.turn_usage_mode;
  }
  for (const key of [
    "show_generation_separator",
    "show_character",
    "show_jev_candidates",
    "show_turn_usage",
    "animate_character",
  ] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return { ok: false, message: `settings.${key} must be a boolean` };
    patch[key] = value;
  }
  return { ok: true, value: patch };
}

/** metadata 배열에서 마지막 `persistent_settings` 항목을 읽는다. 항목이 없으면 undefined. */
export function readStoredPersistentSettings(metadata: unknown): StoredPersistentSettings | undefined {
  const value = lastEntryValue(metadata, PERSISTENT_SETTINGS_METADATA_TYPE);
  if (value === undefined) return undefined;
  const record = isRecord(value) ? value : {};
  const defaultModel = parseModelSelection(record.default_model, "default_model");
  const fallbackModel = parseModelSelection(record.fallback_model, "fallback_model");
  const turnUsageMode = isPersistentTurnUsageMode(record.turn_usage_mode)
    ? record.turn_usage_mode
    : record.show_turn_usage === false ? "hidden" : "collapsed";
  return {
    default_model: defaultModel.ok ? defaultModel.value : null,
    fallback_model: fallbackModel.ok ? fallbackModel.value : null,
    show_generation_separator: typeof record.show_generation_separator === "boolean"
      ? record.show_generation_separator
      : PERSISTENT_SETTINGS_DEFAULTS.show_generation_separator,
    show_character: typeof record.show_character === "boolean"
      ? record.show_character
      : PERSISTENT_SETTINGS_DEFAULTS.show_character,
    // Entries saved before this key existed read as the server default; nothing is written by reading.
    show_jev_candidates: typeof record.show_jev_candidates === "boolean"
      ? record.show_jev_candidates
      : PERSISTENT_SETTINGS_DEFAULTS.show_jev_candidates,
    turn_usage_mode: turnUsageMode,
    show_turn_usage: turnUsageMode !== "hidden",
    animate_character: typeof record.animate_character === "boolean"
      ? record.animate_character
      : PERSISTENT_SETTINGS_DEFAULTS.animate_character,
  };
}

export function buildPersistentSettingsMetadataEntry(
  settings: PersistentSessionSettings,
): Record<string, unknown> {
  return {
    type: PERSISTENT_SETTINGS_METADATA_TYPE,
    value: { ...settings, show_turn_usage: settings.turn_usage_mode !== "hidden" },
  };
}

/** `persistent_session` 표시가 켜져 있는가. 항목이 없거나 깨졌으면 false. */
export function readPersistentEnabled(metadata: unknown): boolean {
  const value = lastEntryValue(metadata, "persistent_session");
  return isRecord(value) && value.enabled === true;
}

/** `persistent_generation`의 대기 변경에서 대상 프리셋과 추론 수준 두 값만 투영한다. */
export function readPersistentPendingTarget(metadata: unknown): PersistentPendingTarget | null {
  const value = lastEntryValue(metadata, "persistent_generation");
  const pending = isRecord(value) ? value.pending : undefined;
  if (!isRecord(pending) || typeof pending.target_model_preset !== "string") return null;
  return {
    target_model_preset: pending.target_model_preset,
    target_reasoning_effort: typeof pending.target_reasoning_effort === "string"
      ? pending.target_reasoning_effort
      : null,
  };
}

function parseModelSelection(value: unknown, label: string): ParseResult<PersistentModelSelection> {
  if (!isRecord(value)) return { ok: false, message: `${label} must be an object` };
  const preset = typeof value.model_preset === "string" ? value.model_preset.trim() : "";
  if (preset.length === 0) return { ok: false, message: `${label}.model_preset must be a non-empty string` };
  const effort = value.reasoning_effort;
  if (effort !== undefined && effort !== null && (typeof effort !== "string" || effort.trim().length === 0)) {
    return { ok: false, message: `${label}.reasoning_effort must be a non-empty string or null` };
  }
  return {
    ok: true,
    value: {
      model_preset: preset,
      reasoning_effort: typeof effort === "string" ? effort.trim() : null,
    },
  };
}

function lastEntryValue(metadata: unknown, type: string): unknown {
  if (!Array.isArray(metadata)) return undefined;
  for (let index = metadata.length - 1; index >= 0; index--) {
    const entry = metadata[index];
    if (isRecord(entry) && entry.type === type) return entry.value ?? null;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistentTurnUsageMode(value: unknown): value is PersistentTurnUsageMode {
  return typeof value === "string"
    && (PERSISTENT_TURN_USAGE_MODES as readonly string[]).includes(value);
}
