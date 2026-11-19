import type { LivePostgresSql } from "../runtime/live_db_sql.js";

import type { ClaudeCentralPoolSettings } from "./types.js";

export const CLAUDE_CENTRAL_POOL_SETTING_KEY = "claude_central_pool";
const SETTING_UPDATED_BY = "claude-central-pool";

export type ClaudeCentralSettingsRepository = {
  read(): Promise<ClaudeCentralPoolSettings>;
  write(settings: ClaudeCentralPoolSettings): Promise<ClaudeCentralPoolSettings>;
};

type Row = { value: unknown };

export function createSqlClaudeCentralSettingsRepository(options: {
  readonly resolveSql: () => Promise<LivePostgresSql>;
}): ClaudeCentralSettingsRepository {
  return {
    async read() {
      const sql = await options.resolveSql();
      const rows = await sql<Row[]>`
        SELECT value FROM system_settings WHERE setting_key = ${CLAUDE_CENTRAL_POOL_SETTING_KEY}
      `;
      return parseSettings(rows[0]?.value);
    },

    async write(settings) {
      const sql = await options.resolveSql();
      const value = {
        default_receive: settings.default_receive,
        nodes: settings.nodes,
      };
      const rows = await sql<Row[]>`
        INSERT INTO system_settings (setting_key, value, updated_by)
        VALUES (${CLAUDE_CENTRAL_POOL_SETTING_KEY}, ${sql.json(value)}, ${SETTING_UPDATED_BY})
        ON CONFLICT (setting_key) DO UPDATE SET
          value = EXCLUDED.value,
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by
        RETURNING value
      `;
      return parseSettings(rows[0]?.value);
    },
  };
}

export function defaultCentralPoolSettings(): ClaudeCentralPoolSettings {
  return { default_receive: true, nodes: {} };
}

export function parseSettings(value: unknown): ClaudeCentralPoolSettings {
  if (!isRecord(value)) return defaultCentralPoolSettings();
  const defaultReceive = typeof value.default_receive === "boolean" ? value.default_receive : true;
  const nodes: Record<string, boolean> = {};
  if (isRecord(value.nodes)) {
    for (const [nodeId, receive] of Object.entries(value.nodes)) {
      if (nodeId.length > 0 && typeof receive === "boolean") nodes[nodeId] = receive;
    }
  }
  return { default_receive: defaultReceive, nodes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
