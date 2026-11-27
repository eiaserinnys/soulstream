import type { SqlClient } from "../control_plane/control_plane_types.js";

export const ANTIGRAVITY_ACKNOWLEDGEMENT = "인지했습니다";
const SETTING_KEY = "antigravity_backend";
const SEED_ACTOR = "system:antigravity-seed";

export type AntigravityBackendValue = { enabled: boolean; acknowledged_at?: string };
export type AntigravityBackendResult = {
  value: AntigravityBackendValue;
  version: number;
  source: "default" | "settings";
};
export type AntigravityBackendUpdate = { value: unknown; expectedVersion: number; updatedBy: string };

type Row = { value: unknown; version: number | string };

export class AntigravityBackendError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

/**
 * Seeds the install-wide switch once: an install that already runs Antigravity
 * (sessions or agent profiles pointing at one of its presets) keeps it on, a fresh one starts off.
 */
export async function seedAntigravityBackend(
  sql: SqlClient,
  antigravityPresetIds: readonly string[],
  info: (message: string) => void,
): Promise<void> {
  const ids = [...antigravityPresetIds];
  const rows = await sql<Array<{ value: AntigravityBackendValue }>>`
    INSERT INTO system_settings (setting_key, value, version, updated_at, updated_by)
    SELECT ${SETTING_KEY}, jsonb_build_object('enabled',
        EXISTS (SELECT 1 FROM sessions WHERE model_preset = ANY(${ids}::text[]))
        OR EXISTS (SELECT 1 FROM agent_profiles WHERE default_preset = ANY(${ids}::text[]))),
      1, NOW(), ${SEED_ACTOR}
    ON CONFLICT (setting_key) DO NOTHING
    RETURNING value`;
  const seeded = rows[0];
  if (seeded) info(`Antigravity backend setting seeded: enabled=${String(seeded.value.enabled)}`);
}

/** Process-local cache of the install-wide Antigravity switch; a missing row means off. */
export class AntigravityBackendSettings {
  private cached: Row | null = null;
  private revision = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly sql: () => Promise<SqlClient>,
    private readonly warn: (message: string) => void,
  ) {}

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, 30_000);
    this.timer.unref();
  }
  close(): void { if (this.timer) clearInterval(this.timer); }

  enabled(): boolean {
    const value = this.cached?.value as AntigravityBackendValue | undefined;
    return value?.enabled === true;
  }

  async refresh(): Promise<void> {
    const revision = this.revision;
    try {
      const sql = await this.sql();
      const rows = await sql<Row[]>`SELECT value, version FROM system_settings WHERE setting_key=${SETTING_KEY}`;
      if (revision === this.revision) this.cached = rows[0] ?? null;
    } catch (error) {
      this.warn(`Failed to refresh Antigravity backend setting: ${String(error)}`);
    }
  }

  async get(): Promise<AntigravityBackendResult> {
    if (!this.cached) return { value: { enabled: false }, version: 0, source: "default" };
    return { value: this.cached.value as AntigravityBackendValue, version: Number(this.cached.version), source: "settings" };
  }

  async put(input: AntigravityBackendUpdate): Promise<AntigravityBackendResult> {
    const messages: string[] = [];
    const raw = input.value as { enabled?: unknown; acknowledgement?: unknown } | null;
    const enabled = raw && typeof raw === "object" ? raw.enabled : undefined;
    if (typeof enabled !== "boolean") messages.push("value.enabled: must be a boolean");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      messages.push("expectedVersion: must be a non-negative safe integer");
    }
    if (typeof input.updatedBy !== "string" || !input.updatedBy.trim()) {
      messages.push("updatedBy: must be a non-empty string");
    }
    if (messages.length) throw new AntigravityBackendError(422, "ANTIGRAVITY_BACKEND_INVALID", messages.join("; "));
    if (enabled === true && raw?.acknowledgement !== ANTIGRAVITY_ACKNOWLEDGEMENT) {
      throw new AntigravityBackendError(422, "ANTIGRAVITY_ACKNOWLEDGEMENT_REQUIRED",
        `value.acknowledgement: must be exactly '${ANTIGRAVITY_ACKNOWLEDGEMENT}' to enable`);
    }
    const stored: AntigravityBackendValue = enabled === true
      ? { enabled: true, acknowledged_at: new Date().toISOString() }
      : { enabled: false };
    const sql = await this.sql();
    const json = sql.json(stored);
    const actor = input.updatedBy.trim().toLowerCase();
    const rows = input.expectedVersion === 0
      ? await sql<Row[]>`INSERT INTO system_settings (setting_key, value, version, updated_at, updated_by)
          VALUES (${SETTING_KEY}, ${json}, 1, NOW(), ${actor}) ON CONFLICT (setting_key) DO NOTHING RETURNING value, version`
      : await sql<Row[]>`UPDATE system_settings SET value=${json}, version=version+1, updated_at=NOW(), updated_by=${actor}
          WHERE setting_key=${SETTING_KEY} AND version=${input.expectedVersion} RETURNING value, version`;
    if (!rows[0]) {
      await this.refresh();
      throw new AntigravityBackendError(409, "ANTIGRAVITY_BACKEND_CONFLICT", "Antigravity setting changed; reload before saving");
    }
    this.revision++;
    this.cached = rows[0];
    return { value: stored, version: Number(rows[0].version), source: "settings" };
  }
}
