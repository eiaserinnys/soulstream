import type { LivePostgresSql } from "../runtime/live_db_sql.js";

import type { ClaudeCentralPoolSettings } from "./types.js";

export const CLAUDE_CENTRAL_POOL_SETTING_KEY = "claude_central_pool";
const SETTING_UPDATED_BY = "claude-central-pool";

export type ClaudeCentralSettingsPatch = {
  readonly default_receive?: boolean;
  readonly nodes?: Readonly<Record<string, boolean | null>>;
};

export type ClaudeCentralSettingsRepository = {
  read(): Promise<ClaudeCentralPoolSettings>;
  /**
   * 주어진 값만 바꾸는 병합 갱신. `default_receive`는 주어질 때만 바꾸고,
   * `nodes`의 각 키는 true/false면 그 값으로, null이면 그 키만 지운다.
   * 주지 않은 키는 그대로 남는다.
   */
  merge(patch: ClaudeCentralSettingsPatch): Promise<ClaudeCentralPoolSettings>;
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

    async merge(patch) {
      const sql = await options.resolveSql();
      const initial = applySettingsPatch(defaultCentralPoolSettings(), patch);
      const nodesToSet: Record<string, boolean> = {};
      const nodesToRemove: Record<string, null> = {};
      for (const [nodeId, receive] of Object.entries(patch.nodes ?? {})) {
        if (nodeId.length === 0) continue;
        if (receive === null) nodesToRemove[nodeId] = null;
        else nodesToSet[nodeId] = receive;
      }
      // 한 문장으로 병합해, 겹치는 PUT이 서로의 키를 지우지 않는다.
      // ON CONFLICT DO UPDATE는 동시에 들어온 다른 갱신이 만든 현재 행 위에서 다시 적용된다.
      const rows = await sql<Row[]>`
        INSERT INTO system_settings AS settings (setting_key, value, updated_by)
        VALUES (${CLAUDE_CENTRAL_POOL_SETTING_KEY}, ${sql.json(initial)}, ${SETTING_UPDATED_BY})
        ON CONFLICT (setting_key) DO UPDATE SET
          value = jsonb_build_object(
            'default_receive',
            CASE WHEN ${patch.default_receive !== undefined}
              THEN ${patch.default_receive ?? false}::boolean
              ELSE COALESCE((settings.value->>'default_receive')::boolean, true)
            END,
            'nodes',
            jsonb_strip_nulls(
              COALESCE(settings.value->'nodes', '{}'::jsonb)
                || ${sql.json(nodesToSet)}::jsonb
                || ${sql.json(nodesToRemove)}::jsonb
            )
          ),
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

export function applySettingsPatch(
  current: ClaudeCentralPoolSettings,
  patch: ClaudeCentralSettingsPatch,
): ClaudeCentralPoolSettings {
  const nodes: Record<string, boolean> = { ...current.nodes };
  for (const [nodeId, receive] of Object.entries(patch.nodes ?? {})) {
    if (nodeId.length === 0) continue;
    if (receive === null) delete nodes[nodeId];
    else nodes[nodeId] = receive;
  }
  return {
    default_receive: patch.default_receive ?? current.default_receive,
    nodes,
  };
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
