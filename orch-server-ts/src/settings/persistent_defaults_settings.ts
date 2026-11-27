import {
  PersistentDefaultsSchema,
  persistentDefaultsIssues,
  type PersistentDefaults,
} from "@soulstream/model-catalog";
import { PERSISTENT_FALLBACK_MODELS_MAX } from "@soulstream/wire-schema/persistent-session-settings";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import type { ModelCatalogSource } from "../model/model_catalog_source.js";

export type PersistentDefaultsResult = {
  value: PersistentDefaults;
  version: number;
  source: "catalog" | "settings";
};
export type PersistentDefaultsUpdate = { value: unknown; expectedVersion: number; updatedBy: string };

type Row = { value: unknown; version: number | string };
type Catalog = ReturnType<ModelCatalogSource["snapshot"]>;
const SettingsValueSchema = PersistentDefaultsSchema.extend({
  fallback_models: PersistentDefaultsSchema.shape.fallback_models.max(PERSISTENT_FALLBACK_MODELS_MAX),
});
function antigravityPresetIds(catalog: Catalog): Set<string> {
  return new Set(catalog.presets.filter(preset => preset.backend === "antigravity").map(preset => preset.id));
}
/** Drops Antigravity presets from the defaults; the first remaining fallback replaces a dropped primary. */
function withoutAntigravity(defaults: PersistentDefaults, antigravity: ReadonlySet<string>): PersistentDefaults {
  const fallback_models = defaults.fallback_models.filter(entry => !antigravity.has(entry.model_preset));
  if (!antigravity.has(defaults.model_preset)) return { ...defaults, fallback_models };
  const [first, ...rest] = fallback_models;
  return first ? { ...defaults, model_preset: first.model_preset, fallback_models: rest } : defaults;
}

export class PersistentDefaultsError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

/** One process-local cache, shared by all orchestrator catalogue consumers. */
export class PersistentDefaultsSettings implements ModelCatalogSource {
  private cached: Row | null = null;
  private memo?: { catalog: Catalog; row: Row; result: Catalog };
  private offMemo?: { base: Catalog; result: Catalog };
  private revision = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly sql: () => Promise<SqlClient>,
    private readonly catalog: ModelCatalogSource,
    private readonly warn: (message: string) => void,
    private readonly antigravityEnabled: () => boolean = () => true,
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
      const rows = await sql<Row[]>`SELECT value, version FROM system_settings WHERE setting_key='persistent_defaults'`;
      if (revision === this.revision) {
        const row = rows[0] ?? null;
        if (row && this.cached && Number(row.version) === Number(this.cached.version)) return;
        if (row !== this.cached) {
          this.cached = row;
          this.memo = undefined;
        }
      }
    } catch (error) {
      this.warn(`Failed to refresh persistent defaults: ${String(error)}`);
    }
  }

  snapshot() {
    const base = this.baseSnapshot();
    if (this.antigravityEnabled()) return base;
    if (this.offMemo?.base === base) return this.offMemo.result;
    const result = {
      ...base,
      persistent_defaults: {
        ...base.persistent_defaults,
        ...withoutAntigravity(base.persistent_defaults, antigravityPresetIds(base)),
      },
    };
    this.offMemo = { base, result };
    return result;
  }

  private baseSnapshot() {
    const catalog = this.catalog.snapshot();
    const row = this.cached;
    if (!row) return catalog;
    if (this.memo?.catalog === catalog && this.memo.row === row) return this.memo.result;
    const parsed = SettingsValueSchema.safeParse(row.value);
    let result: Catalog;
    if (!parsed.success || persistentDefaultsIssues(parsed.data, catalog.presets).length) {
      this.warn("Stored persistent defaults do not match the current model catalogue; using catalogue defaults");
      result = catalog;
    } else {
      result = { ...catalog, persistent_defaults: { ...catalog.persistent_defaults, ...parsed.data } };
    }
    this.memo = { catalog, row, result };
    return result;
  }

  async get(): Promise<PersistentDefaultsResult> {
    const visible = (value: PersistentDefaults) => this.antigravityEnabled()
      ? value
      : withoutAntigravity(value, antigravityPresetIds(this.catalog.snapshot()));
    if (!this.cached) {
      const { model_preset, fallback_models } = this.catalog.snapshot().persistent_defaults;
      return { value: visible({ model_preset, fallback_models }), version: 0, source: "catalog" };
    }
    const parsed = SettingsValueSchema.safeParse(this.cached.value);
    if (!parsed.success) throw new PersistentDefaultsError(503, "PERSISTENT_DEFAULTS_UNAVAILABLE", "Stored persistent defaults are invalid");
    return { value: visible(parsed.data), version: Number(this.cached.version), source: "settings" };
  }

  async put(input: PersistentDefaultsUpdate): Promise<PersistentDefaultsResult> {
    const parsed = SettingsValueSchema.safeParse(input.value);
    const issues = parsed.success
      ? persistentDefaultsIssues(parsed.data, this.catalog.snapshot().presets)
      : parsed.error.issues;
    const messages = issues.map(issue => `${issue.path.map(String).join(".") || "value"}: ${issue.message}`);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      messages.push("expectedVersion: must be a non-negative safe integer");
    }
    if (typeof input.updatedBy !== "string" || !input.updatedBy.trim()) {
      messages.push("updatedBy: must be a non-empty string");
    }
    if (parsed.success && !this.antigravityEnabled()) {
      const antigravity = antigravityPresetIds(this.catalog.snapshot());
      const used = [parsed.data.model_preset, ...parsed.data.fallback_models.map(entry => entry.model_preset)]
        .filter(id => antigravity.has(id));
      if (used.length) messages.push(`Antigravity is disabled; cannot use ${used.join(", ")}`);
    }
    if (!parsed.success || messages.length) {
      throw new PersistentDefaultsError(422, "PERSISTENT_DEFAULTS_INVALID", messages.join("; "));
    }
    const sql = await this.sql();
    const value = sql.json(parsed.data);
    const actor = input.updatedBy.trim().toLowerCase();
    const rows = input.expectedVersion === 0
      ? await sql<Row[]>`INSERT INTO system_settings (setting_key, value, version, updated_at, updated_by)
          VALUES ('persistent_defaults', ${value}, 1, NOW(), ${actor}) ON CONFLICT (setting_key) DO NOTHING RETURNING value, version`
      : await sql<Row[]>`UPDATE system_settings SET value=${value}, version=version+1, updated_at=NOW(), updated_by=${actor}
          WHERE setting_key='persistent_defaults' AND version=${input.expectedVersion} RETURNING value, version`;
    if (!rows[0]) {
      await this.refresh();
      throw new PersistentDefaultsError(409, "PERSISTENT_DEFAULTS_CONFLICT", "Persistent defaults changed; reload before saving");
    }
    this.revision++;
    this.cached = rows[0];
    this.memo = undefined;
    return { value: parsed.data, version: Number(rows[0].version), source: "settings" };
  }
}
