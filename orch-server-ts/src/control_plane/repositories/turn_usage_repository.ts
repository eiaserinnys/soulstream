import type { SqlClient } from "../control_plane_types.js";

export interface TurnUsageQuery {
  sessionId?: string;
  since?: Date;
  until: Date;
  cursor: number;
  limit: number;
}

export interface TurnUsageSummaryQuery {
  since: Date;
  until: Date;
}

export interface TurnUsageRow {
  session_id: string;
  event_id: number;
  at: Date;
  kind: "complete" | "failed" | "no_usage";
  model?: string;
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  first_call_input_tokens?: number;
  first_call_cached_tokens?: number;
  injection_chars?: number;
  ended?: string;
  tool_calls?: number;
  name?: string;
  agent_id?: string;
  node_id?: string;
  model_preset?: string;
  session_created_at?: Date;
}

export interface TurnUsageSessionRow {
  session_id: string;
  turns: number;
  turns_without_usage: number;
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  model?: string | null;
  first_call_input_tokens?: number;
  display_name?: string | null;
  agent_id?: string | null;
  node_id?: string | null;
  created_at?: Date | string;
  injection_chars?: number;
}

type TurnUsageScope = {
  sessionId?: string;
  since?: Date;
  until?: Date;
};

type TurnUsageListSqlRow = Omit<TurnUsageRow,
  | "event_id"
  | "at"
  | "input_tokens"
  | "cached_input_tokens"
  | "cache_write_tokens"
  | "output_tokens"
  | "cost_usd"
  | "first_call_input_tokens"
  | "first_call_cached_tokens"
  | "injection_chars"
  | "tool_calls"
  | "session_created_at"
> & {
  event_id: string | number;
  at: Date;
  input_tokens: string | number | null;
  cached_input_tokens: string | number | null;
  cache_write_tokens: string | number | null;
  output_tokens: string | number | null;
  cost_usd: string | number | null;
  first_call_input_tokens: string | number | null;
  first_call_cached_tokens: string | number | null;
  injection_chars: string | number | null;
  tool_calls: string | number | null;
  session_created_at: Date | null;
  total_count: string | number;
};

type TurnUsageSummarySqlRow = Omit<TurnUsageSessionRow,
  | "turns"
  | "turns_without_usage"
  | "input_tokens"
  | "cached_input_tokens"
  | "cache_write_tokens"
  | "output_tokens"
  | "cost_usd"
  | "first_call_input_tokens"
  | "injection_chars"
> & {
  turns: string | number;
  turns_without_usage: string | number;
  input_tokens: string | number | null;
  cached_input_tokens: string | number | null;
  cache_write_tokens: string | number | null;
  output_tokens: string | number | null;
  cost_usd: string | number | null;
  first_call_input_tokens: string | number | null;
  injection_chars: string | number | null;
};

export async function listTurnUsage(
  sql: SqlClient,
  query: TurnUsageQuery,
): Promise<{ rows: TurnUsageRow[]; total: number }> {
  const ctes = createTurnUsageCtes(sql, query);
  const rawRows = await sql<TurnUsageListSqlRow[]>`
    ${ctes}, page AS MATERIALIZED (
      SELECT t.*, count(*) OVER ()::bigint AS total_count
      FROM turn_rows t
      ORDER BY t.at, t.session_id, t.event_id
      LIMIT ${query.limit} OFFSET ${query.cursor}
    ), page_bounds AS MATERIALIZED (
      SELECT p.*,
        CASE WHEN p.kind = 'no_usage' THEN coalesce(p.next_user_id, (
          SELECT next_user.id
          FROM events next_user
          WHERE next_user.session_id = p.session_id
            AND next_user.event_type = 'user_message'
            AND next_user.id > p.event_id
          ORDER BY next_user.id ASC
          LIMIT 1
        )) END AS turn_next_user_id
      FROM page p
    )
    SELECT
      t.session_id,
      t.event_id,
      t.at,
      t.kind,
      t.model,
      t.input_tokens,
      t.cached_input_tokens,
      t.cache_write_tokens,
      t.output_tokens,
      t.cost_usd,
      t.first_call_input_tokens,
      t.first_call_cached_tokens,
      s.display_name AS name,
      s.agent_id,
      s.node_id,
      s.model_preset,
      s.created_at AS session_created_at,
      (
        SELECT CASE WHEN jsonb_typeof(manifest.payload->'total_chars') = 'number'
          THEN (manifest.payload->>'total_chars')::numeric END
        FROM events manifest
        WHERE manifest.session_id = t.session_id
          AND manifest.event_type = 'context_manifest'
          AND manifest.id < t.event_id
        ORDER BY manifest.id DESC
        LIMIT 1
      ) AS injection_chars,
      CASE WHEN t.kind = 'no_usage' THEN (
        SELECT CASE WHEN jsonb_typeof(ended.payload->'termination_reason') = 'string'
          THEN ended.payload->>'termination_reason' END
        FROM events ended
        WHERE ended.session_id = t.session_id
          AND ended.event_type = 'session_ended'
          AND ended.id > t.event_id
          AND (t.turn_next_user_id IS NULL OR ended.id < t.turn_next_user_id)
        ORDER BY ended.id DESC
        LIMIT 1
      ) END AS ended,
      CASE WHEN t.kind = 'no_usage' THEN (
        SELECT count(*)::integer
        FROM events tool
        WHERE tool.session_id = t.session_id
          AND tool.event_type = 'tool_start'
          AND tool.id > t.event_id
          AND (t.turn_next_user_id IS NULL OR tool.id < t.turn_next_user_id)
      ) END AS tool_calls,
      t.total_count
    FROM page_bounds t
    LEFT JOIN sessions s ON s.session_id = t.session_id
    ORDER BY t.at, t.session_id, t.event_id
  `;

  let total = asNumber(rawRows[0]?.total_count) ?? 0;
  if (rawRows.length === 0 && query.cursor > 0) {
    const counts = await sql<Array<{ total: string | number }>>`
      ${ctes}
      SELECT count(*)::bigint AS total FROM turn_rows
    `;
    total = asNumber(counts[0]?.total) ?? 0;
  }

  return {
    total,
    rows: rawRows.map((row) => ({
      session_id: row.session_id,
      event_id: Number(row.event_id),
      at: row.at,
      kind: row.kind,
      ...optionalString("model", row.model),
      ...optionalNumber("input_tokens", row.input_tokens),
      ...optionalNumber("cached_input_tokens", row.cached_input_tokens),
      ...optionalNumber("cache_write_tokens", row.cache_write_tokens),
      ...optionalNumber("output_tokens", row.output_tokens),
      ...optionalNumber("cost_usd", row.cost_usd),
      ...optionalNumber("first_call_input_tokens", row.first_call_input_tokens),
      ...optionalNumber("first_call_cached_tokens", row.first_call_cached_tokens),
      ...optionalNumber("injection_chars", row.injection_chars),
      ...optionalString("ended", row.ended),
      ...optionalNumber("tool_calls", row.tool_calls),
      ...optionalString("name", row.name),
      ...optionalString("agent_id", row.agent_id),
      ...optionalString("node_id", row.node_id),
      ...optionalString("model_preset", row.model_preset),
      ...(row.session_created_at ? { session_created_at: row.session_created_at } : {}),
    })),
  };
}

export async function summarizeTurnUsage(
  sql: SqlClient,
  query: TurnUsageSummaryQuery,
): Promise<TurnUsageSessionRow[]> {
  const ctes = createTurnUsageCtes(sql, query);
  const rows = await sql<TurnUsageSummarySqlRow[]>`
    ${ctes}
    SELECT
      grouped.session_id,
      grouped.turns,
      grouped.turns_without_usage,
      grouped.input_tokens,
      grouped.cached_input_tokens,
      grouped.cache_write_tokens,
      grouped.output_tokens,
      grouped.cost_usd,
      model.model,
      first_usage.first_call_input_tokens,
      s.display_name,
      s.agent_id,
      s.node_id,
      s.created_at,
      manifest.injection_chars
    FROM (
      SELECT
        session_id,
        count(*) FILTER (WHERE kind <> 'no_usage')::integer AS turns,
        count(*) FILTER (WHERE kind = 'no_usage')::integer AS turns_without_usage,
        sum(input_tokens) AS input_tokens,
        sum(cached_input_tokens) AS cached_input_tokens,
        sum(cache_write_tokens) AS cache_write_tokens,
        sum(output_tokens) AS output_tokens,
        sum(cost_usd) AS cost_usd
      FROM turn_rows
      GROUP BY session_id
    ) grouped
    LEFT JOIN (
      SELECT DISTINCT ON (session_id) session_id, model
      FROM usage_rec
      WHERE model IS NOT NULL
      ORDER BY session_id, created_at, id
    ) model USING (session_id)
    LEFT JOIN (
      SELECT DISTINCT ON (session_id) session_id, first_call_input_tokens
      FROM usage_rec
      ORDER BY session_id, created_at, id
    ) first_usage USING (session_id)
    LEFT JOIN sessions s ON s.session_id = grouped.session_id
    LEFT JOIN LATERAL (
      SELECT CASE WHEN jsonb_typeof(manifest.payload->'total_chars') = 'number'
        THEN (manifest.payload->>'total_chars')::numeric END AS injection_chars
      FROM events manifest
      WHERE manifest.session_id = grouped.session_id
        AND manifest.event_type = 'context_manifest'
        AND manifest.created_at < ${query.until}
      ORDER BY manifest.id DESC
      LIMIT 1
    ) manifest ON true
    ORDER BY grouped.session_id
  `;

  return rows.map((row) => ({
    session_id: row.session_id,
    turns: asNumber(row.turns) ?? 0,
    turns_without_usage: asNumber(row.turns_without_usage) ?? 0,
    ...optionalNumber("input_tokens", row.input_tokens),
    ...optionalNumber("cached_input_tokens", row.cached_input_tokens),
    ...optionalNumber("cache_write_tokens", row.cache_write_tokens),
    ...optionalNumber("output_tokens", row.output_tokens),
    ...optionalNumber("cost_usd", row.cost_usd),
    ...optionalString("model", row.model),
    ...optionalNumber("first_call_input_tokens", row.first_call_input_tokens),
    ...optionalString("display_name", row.display_name),
    ...optionalString("agent_id", row.agent_id),
    ...optionalString("node_id", row.node_id),
    ...(row.created_at ? { created_at: row.created_at } : {}),
    ...optionalNumber("injection_chars", row.injection_chars),
  }));
}

function createTurnUsageCtes(sql: SqlClient, scope: TurnUsageScope) {
  const conditions = sql`
    ${scope.since ? sql`AND created_at >= ${scope.since}` : sql``}
    ${scope.until ? sql`AND created_at < ${scope.until}` : sql``}
    ${scope.sessionId ? sql`AND session_id = ${scope.sessionId}` : sql``}
  `;
  return sql`
    WITH picked AS MATERIALIZED (
      SELECT session_id, id, created_at, event_type
      FROM events
      WHERE event_type IN ('complete', 'result', 'error', 'user_message', 'session_ended')
        ${conditions}
    ), usage_raw AS MATERIALIZED (
      SELECT
        p.session_id,
        p.id,
        p.created_at,
        CASE WHEN p.event_type = 'complete' THEN 'complete' ELSE 'failed' END AS kind,
        e.payload->'usage' AS usage,
        e.payload->'model' AS model_value,
        e.payload->'turn_cost_usd' AS cost_value,
        e.payload->'first_call' AS first_call
      FROM picked p
      JOIN events e ON e.session_id = p.session_id AND e.id = p.id
      WHERE p.event_type IN ('complete', 'result', 'error')
        AND jsonb_typeof(e.payload->'usage') = 'object'
        AND (p.event_type <> 'result' OR e.payload->>'success' = 'false')
    ), usage_rec AS MATERIALIZED (
      SELECT
        session_id,
        id,
        created_at,
        kind,
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
        ${numberField(sql, "first_call", "input_tokens")} AS first_call_input_tokens,
        ${numberField(sql, "first_call", "cached_input_tokens")} AS first_call_cached_tokens
      FROM usage_raw
    ), marks AS (
      SELECT session_id, id, created_at,
        lead(id) OVER (PARTITION BY session_id ORDER BY id) AS next_user_id
      FROM picked WHERE event_type = 'user_message'
    ), no_usage AS (
      SELECT m.session_id, m.id, m.created_at, m.next_user_id
      FROM marks m
      WHERE NOT EXISTS (
        SELECT 1 FROM usage_rec u
        WHERE u.session_id = m.session_id AND u.id > m.id
          AND (m.next_user_id IS NULL OR u.id < m.next_user_id)
      )
      AND (
        m.next_user_id IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM picked x
          WHERE x.session_id = m.session_id AND x.event_type = 'session_ended' AND x.id > m.id
        )
      )
    ), turn_rows AS (
      SELECT
        session_id,
        id AS event_id,
        created_at AS at,
        kind,
        model,
        input_tokens,
        cached_input_tokens,
        cache_write_tokens,
        output_tokens,
        cost_usd,
        first_call_input_tokens,
        first_call_cached_tokens,
        NULL::bigint AS next_user_id
      FROM usage_rec
      UNION ALL
      SELECT
        session_id,
        id AS event_id,
        created_at AS at,
        'no_usage' AS kind,
        NULL::text AS model,
        NULL::numeric AS input_tokens,
        NULL::numeric AS cached_input_tokens,
        NULL::numeric AS cache_write_tokens,
        NULL::numeric AS output_tokens,
        NULL::numeric AS cost_usd,
        NULL::numeric AS first_call_input_tokens,
        NULL::numeric AS first_call_cached_tokens,
        next_user_id
      FROM no_usage
    )
  `;
}

function normalizedInputTokens(sql: SqlClient) {
  const codexValue = numberField(sql, "usage", "input_tokens");
  const claudeFields = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
  const hasInvalidValue = claudeFields.map((field) =>
    sql`(usage ? ${field} AND jsonb_typeof(usage->${field}) <> 'number')`
  );
  const hasNumericValue = claudeFields.map((field) =>
    sql`jsonb_typeof(usage->${field}) = 'number'`
  );
  const fieldValues = claudeFields.map((field) =>
    sql`coalesce(${numberField(sql, "usage", field)}, 0)`
  );
  return sql`
    CASE WHEN usage ? 'cached_input_tokens' THEN ${codexValue}
      WHEN ${hasInvalidValue[0]} OR ${hasInvalidValue[1]} OR ${hasInvalidValue[2]} THEN NULL
      WHEN ${hasNumericValue[0]} OR ${hasNumericValue[1]} OR ${hasNumericValue[2]}
        THEN ${fieldValues[0]} + ${fieldValues[1]} + ${fieldValues[2]}
      ELSE NULL
    END
  `;
}

function numberField(sql: SqlClient, object: "usage" | "first_call", field: string) {
  const source = object === "usage" ? sql`usage` : sql`first_call`;
  return sql`CASE WHEN jsonb_typeof(${source}->${field}) = 'number'
    THEN (${source}->>${field})::numeric END`;
}

function asNumber(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionalNumber<K extends string>(key: K, value: string | number | null | undefined): Partial<Record<K, number>> {
  const number = asNumber(value);
  return number === undefined ? {} : { [key]: number } as Record<K, number>;
}

function optionalString<K extends string>(key: K, value: string | null | undefined): Partial<Record<K, string>> {
  return value === null || value === undefined ? {} : { [key]: value } as Record<K, string>;
}
