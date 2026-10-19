import type { EventIngressQuerySql, EventIngressSqlFragment } from "../node/event_ingress_repository.js";

export function createSessionStatisticsScopeCtes(
  sql: EventIngressQuerySql,
  fragment: EventIngressSqlFragment,
  authorizedSessionIds: readonly string[],
  recordedAtFrom: string | null,
  recordedAtBefore: string | null,
): unknown {
  return fragment`
authorized_sessions AS (
      SELECT value AS session_id
      FROM jsonb_array_elements_text(${sql.json([...new Set(authorizedSessionIds)])}::jsonb)
    ),
    full_facts AS (
      SELECT fact.*
      FROM session_statistics_facts AS fact
      JOIN authorized_sessions AS allowed USING (session_id)
      WHERE ${recordedAtFrom}::timestamptz IS NULL
    ),
    range_seed_facts AS (
      SELECT fact.*
      FROM session_statistics_facts AS fact
      JOIN authorized_sessions AS allowed USING (session_id)
      WHERE ${recordedAtFrom}::timestamptz IS NOT NULL
        AND fact.recorded_at >= ${recordedAtFrom}::timestamptz
        AND fact.recorded_at < ${recordedAtBefore}::timestamptz
    ),
    seed_usage_keys AS (
      SELECT DISTINCT session_id, accounting_key
      FROM range_seed_facts
      WHERE fact_kind = 'usage' AND accounting_key IS NOT NULL
    ),
    boundary_facts AS (
      SELECT fact.*
      FROM session_statistics_facts AS fact
      JOIN authorized_sessions AS allowed USING (session_id)
      WHERE fact.fact_kind = 'boundary'
    ),
    seed_legacy_events AS (
      SELECT DISTINCT session_id, event_id
      FROM range_seed_facts
      WHERE fact_kind = 'usage'
        AND accounting_key IS NULL
        AND candidate_type IN ('failed_result', 'failed_error')
    ),
    legacy_seed_intervals AS (
      SELECT
        seed.session_id,
        seed.event_id,
        previous_input.event_id AS interval_start_event_id,
        next_input.event_id AS interval_end_event_id
      FROM seed_legacy_events AS seed
      LEFT JOIN LATERAL (
        SELECT boundary.event_id
        FROM boundary_facts AS boundary
        WHERE boundary.session_id = seed.session_id
          AND boundary.boundary_type = 'input'
          AND boundary.event_id <= seed.event_id
        ORDER BY boundary.event_id DESC
        LIMIT 1
      ) AS previous_input ON true
      LEFT JOIN LATERAL (
        SELECT boundary.event_id
        FROM boundary_facts AS boundary
        WHERE boundary.session_id = seed.session_id
          AND boundary.boundary_type = 'input'
          AND boundary.event_id > previous_input.event_id
        ORDER BY boundary.event_id ASC
        LIMIT 1
      ) AS next_input ON true
      WHERE previous_input.event_id IS NOT NULL
    ),
    keyed_sibling_facts AS (
      SELECT sibling.*
      FROM session_statistics_facts AS sibling
      JOIN seed_usage_keys AS seed
        ON seed.session_id = sibling.session_id
       AND seed.accounting_key = sibling.accounting_key
      WHERE sibling.fact_kind = 'usage'
    ),
    legacy_interval_facts AS (
      SELECT related.*
      FROM session_statistics_facts AS related
      JOIN legacy_seed_intervals AS interval
        ON interval.session_id = related.session_id
       AND related.event_id >= interval.interval_start_event_id
       AND (interval.interval_end_event_id IS NULL OR related.event_id < interval.interval_end_event_id)
      WHERE related.fact_kind = 'usage'
    ),
    material_facts AS (
      SELECT fact.*
      FROM session_statistics_facts AS fact
      JOIN authorized_sessions AS allowed USING (session_id)
      WHERE fact.fact_kind = 'input_material'
    ),
    scoped_facts AS (
      SELECT * FROM full_facts
      UNION
      SELECT * FROM range_seed_facts
      UNION
      SELECT * FROM keyed_sibling_facts
      UNION
      SELECT * FROM boundary_facts
      UNION
      SELECT * FROM legacy_interval_facts
      UNION
      SELECT * FROM material_facts
    )
  `;
}
