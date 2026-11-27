import { z } from "zod";
import type { ModelPreset } from "@soulstream/model-catalog";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import type { ModelCatalogSource } from "../model/model_catalog_source.js";

const SETTING_KEY = "summary_settings";
const SEED_ACTOR = "system:summary-settings-seed";

export const SUMMARY_MODEL_PRESETS_MAX = 5;
const SELECTABLE_BACKENDS: ReadonlySet<string> = new Set(["claude", "antigravity", "codex"]);
const SECTION_LABELS = { turn: "턴 요약", session: "세션 요약" } as const;

const SummarySectionSchema = z.object({
  enabled: z.boolean(),
  model_presets: z.array(z.string().trim().min(1)).max(
    SUMMARY_MODEL_PRESETS_MAX,
    `모델은 ${SUMMARY_MODEL_PRESETS_MAX}개까지 고를 수 있습니다.`,
  ),
}).strict();
export const SummarySettingsSchema = z.object({
  turn: SummarySectionSchema,
  session: SummarySectionSchema,
}).strict();

export type SummarySection = z.infer<typeof SummarySectionSchema>;
export type SummarySettingsValue = z.infer<typeof SummarySettingsSchema>;
export type SummarySettingsReader = { current(): SummarySettingsValue };

export const SUMMARY_SETTINGS_OFF: SummarySettingsValue = {
  turn: { enabled: false, model_presets: [] },
  session: { enabled: false, model_presets: [] },
};

export type SummarySettingsResult = {
  value: SummarySettingsValue;
  version: number;
  source: "default" | "settings";
  updated_at: string | null;
  updated_by: string | null;
  /** Preset ids the server accepts, so the editor offers nothing it would reject. */
  selectable_preset_ids: string[];
};
export type SummarySettingsUpdate = { value: unknown; expectedVersion: number; updatedBy: string };

type Row = {
  value: unknown;
  version: number | string;
  updated_at: Date | string | null;
  updated_by: string | null;
};

export class SummarySettingsError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

/**
 * A Claude preset is selectable unless its env points the CLI at another provider
 * (ANTHROPIC_* keys): the one-shot Claude runner does not pass preset env, so such a
 * call would hit the Claude subscription with a foreign model name and fail.
 */
export function isSelectableSummaryPreset(preset: ModelPreset): boolean {
  if (!SELECTABLE_BACKENDS.has(preset.backend)) return false;
  if (preset.backend !== "claude") return true;
  return !Object.keys(preset.env ?? {}).some(key => key.startsWith("ANTHROPIC_"));
}

export function summarySettingsIssues(value: SummarySettingsValue, presets: readonly ModelPreset[]): string[] {
  const messages: string[] = [];
  for (const section of ["turn", "session"] as const) {
    const label = SECTION_LABELS[section];
    const { enabled, model_presets } = value[section];
    const seen = new Set<string>();
    for (const id of model_presets) {
      const preset = presets.find(entry => entry.id === id);
      if (!preset) messages.push(`${label}: 모델 "${id}"은(는) 카탈로그에 없습니다.`);
      else if (!isSelectableSummaryPreset(preset)) messages.push(`${label}: ${preset.label}은(는) 요약에 쓸 수 없습니다.`);
      if (seen.has(id)) messages.push(`${label}: 같은 모델을 두 번 넣을 수 없습니다 (${id}).`);
      seen.add(id);
    }
    if (enabled && model_presets.length === 0) messages.push(`${label}: 켜려면 모델을 하나 이상 골라 주세요.`);
  }
  return messages;
}

/** Inserts the first-run value computed from the config file; an existing row is never touched. */
export async function seedSummarySettings(
  sql: SqlClient,
  catalog: ModelCatalogSource,
  value: SummarySettingsValue,
  info: (value: SummarySettingsValue) => void,
): Promise<void> {
  const issues = summarySettingsIssues(value, catalog.snapshot().presets);
  if (issues.length) throw new Error(`Seeded summary settings are invalid: ${issues.join(" ")}`);
  const rows = await sql<Array<{ value: SummarySettingsValue }>>`
    INSERT INTO system_settings (setting_key, value, version, updated_at, updated_by)
    VALUES (${SETTING_KEY}, ${sql.json(value)}, 1, NOW(), ${SEED_ACTOR})
    ON CONFLICT (setting_key) DO NOTHING
    RETURNING value`;
  if (rows[0]) info(rows[0].value);
}

/** Process-local cache of the turn and session summary switches and model orders; a missing row means both off. */
export class SummarySettings implements SummarySettingsReader {
  private cached: Row | null = null;
  private parsed?: { row: Row; value: SummarySettingsValue };
  private revision = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly sql: () => Promise<SqlClient>,
    private readonly catalog: ModelCatalogSource,
    private readonly warn: (message: string) => void,
  ) {}

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, 30_000);
    this.timer.unref();
  }
  close(): void { if (this.timer) clearInterval(this.timer); }

  async refresh(): Promise<void> {
    const revision = this.revision;
    try {
      const sql = await this.sql();
      const rows = await sql<Row[]>`SELECT value, version, updated_at, updated_by FROM system_settings WHERE setting_key=${SETTING_KEY}`;
      if (revision === this.revision) this.cached = rows[0] ?? null;
    } catch (error) {
      this.warn(`Failed to refresh summary settings: ${String(error)}`);
    }
  }

  current(): SummarySettingsValue {
    const row = this.cached;
    if (!row) return SUMMARY_SETTINGS_OFF;
    if (this.parsed?.row === row) return this.parsed.value;
    const result = SummarySettingsSchema.safeParse(row.value);
    if (!result.success) this.warn("Stored summary settings are invalid; summaries stay off");
    const value = result.success ? result.data : SUMMARY_SETTINGS_OFF;
    this.parsed = { row, value };
    return value;
  }

  async get(): Promise<SummarySettingsResult> {
    const selectable_preset_ids = this.catalog.snapshot().presets.filter(isSelectableSummaryPreset).map(preset => preset.id);
    if (!this.cached) {
      return { value: SUMMARY_SETTINGS_OFF, version: 0, source: "default", updated_at: null, updated_by: null, selectable_preset_ids };
    }
    return {
      value: this.current(),
      version: Number(this.cached.version),
      source: "settings",
      updated_at: this.cached.updated_at === null ? null : new Date(this.cached.updated_at).toISOString(),
      updated_by: this.cached.updated_by,
      selectable_preset_ids,
    };
  }

  async put(input: SummarySettingsUpdate): Promise<SummarySettingsResult> {
    const parsed = SummarySettingsSchema.safeParse(input.value);
    const messages = parsed.success
      ? summarySettingsIssues(parsed.data, this.catalog.snapshot().presets)
      : parsed.error.issues.map(issue => `${issue.path.map(String).join(".") || "value"}: ${issue.message}`);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      messages.push("expectedVersion: must be a non-negative safe integer");
    }
    if (typeof input.updatedBy !== "string" || !input.updatedBy.trim()) {
      messages.push("updatedBy: must be a non-empty string");
    }
    if (!parsed.success || messages.length) {
      throw new SummarySettingsError(400, "SUMMARY_SETTINGS_INVALID", messages.join(" "));
    }
    const sql = await this.sql();
    const json = sql.json(parsed.data);
    const actor = input.updatedBy.trim().toLowerCase();
    const rows = input.expectedVersion === 0
      ? await sql<Row[]>`INSERT INTO system_settings (setting_key, value, version, updated_at, updated_by)
          VALUES (${SETTING_KEY}, ${json}, 1, NOW(), ${actor}) ON CONFLICT (setting_key) DO NOTHING RETURNING value, version, updated_at, updated_by`
      : await sql<Row[]>`UPDATE system_settings SET value=${json}, version=version+1, updated_at=NOW(), updated_by=${actor}
          WHERE setting_key=${SETTING_KEY} AND version=${input.expectedVersion} RETURNING value, version, updated_at, updated_by`;
    if (!rows[0]) {
      await this.refresh();
      throw new SummarySettingsError(409, "SUMMARY_SETTINGS_CONFLICT", "Summary settings changed; reload before saving");
    }
    this.revision++;
    this.cached = rows[0];
    return await this.get();
  }
}
