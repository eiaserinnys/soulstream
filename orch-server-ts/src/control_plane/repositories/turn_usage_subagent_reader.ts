import type { SqlClient } from "../control_plane_types.js";
import { asNumber, normalizedInputTokens, numberField } from "./turn_usage_sql_fields.js";
import {
  computeSessionSubagentRollups,
  type TurnSubagentModelUsage,
  type TurnSubagentRollup,
  type TurnSubagentUsageTurn,
} from "./turn_usage_subagents.js";

export interface SessionSubagentUsage {
  rollups: Map<number, TurnSubagentRollup>;
  anchorEventIds: Set<number>;
}

type SubagentUsageSqlRow = {
  session_id: string;
  event_id: string | number;
  model: string | null;
  input_tokens: string | number | null;
  cached_input_tokens: string | number | null;
  cache_write_tokens: string | number | null;
  output_tokens: string | number | null;
  cost_usd: string | number | null;
  model_usage: unknown;
  is_anchor: boolean;
};

export async function readSubagentUsage(
  sql: SqlClient,
  sessionIds: readonly string[],
  scope: { since?: Date; until: Date },
  path: "list" | "summary" = "summary",
): Promise<Map<string, SessionSubagentUsage>> {
  const uniqueSessionIds = [...new Set(sessionIds)];
  if (uniqueSessionIds.length === 0) return new Map();
  const ctes = createSubagentUsageCtes(sql, uniqueSessionIds, scope, path);
  const rows = await sql<SubagentUsageSqlRow[]>`
    ${ctes}
    SELECT
      au.session_id,
      au.id AS event_id,
      au.model,
      au.input_tokens,
      au.cached_input_tokens,
      au.cache_write_tokens,
      au.output_tokens,
      au.cost_usd,
      au.is_anchor,
      CASE WHEN jsonb_typeof(au.complete_model_usage) = 'object'
        THEN au.complete_model_usage
        ELSE paired.model_usage
      END AS model_usage
    FROM all_usage au
    LEFT JOIN LATERAL (
      SELECT r.payload->'model_usage' AS model_usage
      FROM events r
      WHERE r.session_id = au.session_id
        AND r.event_type = 'result'
        AND r.payload->>'success' = 'true'
        AND r.id < au.id
        AND r.id > coalesce(au.prev_usage_turn_id, 0)
      ORDER BY r.id DESC
      LIMIT 1
    ) paired ON true
    ORDER BY au.session_id, au.id
  `;

  const turnsBySession = new Map<string, TurnSubagentUsageTurn[]>();
  const anchorIdsBySession = new Map<string, Set<number>>();
  for (const row of rows) {
    const eventId = Number(row.event_id);
    const turns = turnsBySession.get(row.session_id) ?? [];
    turns.push({
      event_id: eventId,
      model: row.model,
      input_tokens: asNumber(row.input_tokens),
      cached_input_tokens: asNumber(row.cached_input_tokens),
      cache_write_tokens: asNumber(row.cache_write_tokens),
      output_tokens: asNumber(row.output_tokens),
      cost_usd: asNumber(row.cost_usd),
      model_usage: row.model_usage,
    });
    turnsBySession.set(row.session_id, turns);
    if (row.is_anchor) {
      const anchorIds = anchorIdsBySession.get(row.session_id) ?? new Set<number>();
      anchorIds.add(eventId);
      anchorIdsBySession.set(row.session_id, anchorIds);
    }
  }

  const result = new Map<string, SessionSubagentUsage>();
  for (const [sessionId, turns] of turnsBySession) {
    result.set(sessionId, {
      rollups: computeSessionSubagentRollups(turns),
      anchorEventIds: anchorIdsBySession.get(sessionId) ?? new Set<number>(),
    });
  }
  return result;
}

export function subagentRollupFields(rollup: TurnSubagentRollup): {
  subagent_input_tokens: number;
  subagent_cached_input_tokens: number;
  subagent_cache_write_tokens: number;
  subagent_output_tokens: number;
  subagent_cost_usd?: number;
  subagent_models: TurnSubagentModelUsage[];
} {
  return {
    subagent_input_tokens: rollup.subagent_input_tokens,
    subagent_cached_input_tokens: rollup.subagent_cached_input_tokens,
    subagent_cache_write_tokens: rollup.subagent_cache_write_tokens,
    subagent_output_tokens: rollup.subagent_output_tokens,
    ...(rollup.subagent_cost_usd === undefined ? {} : { subagent_cost_usd: rollup.subagent_cost_usd }),
    subagent_models: rollup.subagent_models,
  };
}

function createSubagentUsageCtes(
  sql: SqlClient,
  sessionIds: string[],
  scope: { since?: Date; until: Date },
  path: "list" | "summary",
) {
  return sql`
    WITH picked AS MATERIALIZED (
      SELECT session_id, id, created_at, event_type
      FROM events
      WHERE event_type IN ('complete', 'error')
        ${path === "list" ? sql`AND session_id = ANY(${sessionIds}::text[])` : sql``}
        ${scope.since ? sql`AND created_at >= ${scope.since}` : sql``}
        AND created_at < ${scope.until}
      UNION ALL
      -- usage는 success=false result에서만 읽는다. 이 조건은 부분 인덱스
      -- idx_events_failed_result의 WHERE와 같다.
      SELECT session_id, id, created_at, event_type
      FROM events
      WHERE event_type = 'result' AND (payload->>'success') = 'false'
        ${path === "list" ? sql`AND session_id = ANY(${sessionIds}::text[])` : sql``}
        ${scope.since ? sql`AND created_at >= ${scope.since}` : sql``}
        AND created_at < ${scope.until}
    ), usage_raw AS MATERIALIZED (
      SELECT
        p.session_id,
        p.id,
        p.created_at,
        e.payload->'usage' AS usage,
        e.payload->'model' AS model_value,
        e.payload->'turn_cost_usd' AS cost_value,
        e.payload->'model_usage' AS complete_model_usage
      FROM picked p
      JOIN events e ON e.session_id = p.session_id AND e.id = p.id
      WHERE jsonb_typeof(e.payload->'usage') = 'object'
        ${path === "summary" ? sql`AND p.session_id = ANY(${sessionIds}::text[])` : sql``}
        AND (p.event_type <> 'result' OR e.payload->>'success' = 'false')
    ), usage_norm AS MATERIALIZED (
      SELECT
        session_id,
        id,
        created_at,
        CASE WHEN jsonb_typeof(model_value) = 'string' THEN model_value #>> '{}' END AS model,
        ${normalizedInputTokens(sql)} AS input_tokens,
        CASE WHEN usage ? 'cached_input_tokens'
          THEN ${numberField(sql, "usage", "cached_input_tokens")}
          ELSE ${numberField(sql, "usage", "cache_read_input_tokens")}
        END AS cached_input_tokens,
        CASE WHEN NOT (usage ? 'cached_input_tokens')
          THEN ${numberField(sql, "usage", "cache_creation_input_tokens")}
        END AS cache_write_tokens,
        ${numberField(sql, "usage", "output_tokens")} AS output_tokens,
        CASE WHEN jsonb_typeof(cost_value) = 'number' THEN (cost_value #>> '{}')::numeric END AS cost_usd,
        complete_model_usage
      FROM usage_raw
    ), usage_rec AS MATERIALIZED (
      SELECT *, lag(id) OVER (PARTITION BY session_id ORDER BY id) AS prev_usage_turn_id
      FROM usage_norm
    ), anchor_raw AS MATERIALIZED (
      SELECT f.session_id, a.id, a.payload
      FROM (
        SELECT session_id, min(id) AS min_event_id
        FROM usage_rec
        GROUP BY session_id
      ) f
      CROSS JOIN LATERAL (
        SELECT e.session_id, e.id, e.payload
        FROM events e
        WHERE e.session_id = f.session_id
          AND e.id < f.min_event_id
          AND e.event_type IN ('complete', 'result', 'error')
          AND jsonb_typeof(e.payload->'usage') = 'object'
          AND (e.event_type <> 'result' OR e.payload->>'success' = 'false')
        ORDER BY e.id DESC
        LIMIT 1
      ) a
    ), anchor_norm AS MATERIALIZED (
      SELECT
        session_id,
        id,
        payload->'usage' AS usage,
        payload->'model' AS model_value,
        payload->'turn_cost_usd' AS cost_value,
        payload->'model_usage' AS complete_model_usage
      FROM anchor_raw
    ), anchor_rec AS MATERIALIZED (
      SELECT
        session_id,
        id,
        CASE WHEN jsonb_typeof(model_value) = 'string' THEN model_value #>> '{}' END AS model,
        ${normalizedInputTokens(sql)} AS input_tokens,
        CASE WHEN usage ? 'cached_input_tokens'
          THEN ${numberField(sql, "usage", "cached_input_tokens")}
          ELSE ${numberField(sql, "usage", "cache_read_input_tokens")}
        END AS cached_input_tokens,
        CASE WHEN NOT (usage ? 'cached_input_tokens')
          THEN ${numberField(sql, "usage", "cache_creation_input_tokens")}
        END AS cache_write_tokens,
        ${numberField(sql, "usage", "output_tokens")} AS output_tokens,
        CASE WHEN jsonb_typeof(cost_value) = 'number' THEN (cost_value #>> '{}')::numeric END AS cost_usd,
        complete_model_usage,
        NULL::bigint AS prev_usage_turn_id
      FROM anchor_norm
    ), all_usage AS MATERIALIZED (
      SELECT session_id, id, model, input_tokens, cached_input_tokens, cache_write_tokens,
        output_tokens, cost_usd, complete_model_usage, prev_usage_turn_id, false AS is_anchor
      FROM usage_rec
      UNION ALL
      SELECT session_id, id, model, input_tokens, cached_input_tokens, cache_write_tokens,
        output_tokens, cost_usd, complete_model_usage, prev_usage_turn_id, true AS is_anchor
      FROM anchor_rec
    )
  `;
}
