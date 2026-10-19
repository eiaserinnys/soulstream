import type {
  EventIngressQuerySql,
  EventIngressSqlFragment,
} from "../node/event_ingress_repository.js";

export type SessionStatisticsCanonicalReadOptions = {
  asOf: string;
  readPurpose:
    | { kind: "overview" }
    | { kind: "day"; recordedAtFrom: string; recordedAtBefore: string };
};

export function createSessionStatisticsPeriodSeedCtes(
  sql: EventIngressQuerySql,
  fragment: EventIngressSqlFragment,
  authorizedSessionIds: readonly string[],
  recordedAtFrom: string | null,
  recordedAtBefore: string | null,
  options: SessionStatisticsCanonicalReadOptions,
): unknown {
  const asOf = options.asOf;
  const dayPurpose = options.readPurpose.kind === "day" ? options.readPurpose : null;
  const includesDayMaterials = dayPurpose !== null;
  const dayFrom = dayPurpose?.recordedAtFrom ?? null;
  const dayBefore = dayPurpose?.recordedAtBefore ?? null;
  const includesMaterialBoundaries = dayPurpose !== null;

  return fragment`
    authorized_sessions AS (
      SELECT value AS session_id
      FROM jsonb_array_elements_text(${sql.json([...new Set(authorizedSessionIds)])}::jsonb)
    ),
    period_seed_facts AS (
      SELECT fact.*
      FROM session_statistics_facts AS fact
      JOIN authorized_sessions AS allowed USING (session_id)
      WHERE fact.fact_kind IN ('usage', 'boundary')
        AND fact.recorded_at < ${asOf}::timestamptz
        AND (${recordedAtFrom}::timestamptz IS NULL
          OR fact.recorded_at >= ${recordedAtFrom}::timestamptz)
        AND (${recordedAtBefore}::timestamptz IS NULL
          OR fact.recorded_at < ${recordedAtBefore}::timestamptz)
        AND (${includesMaterialBoundaries} OR fact.source_event_type <> 'input_material_manifest')
    ),
    day_material_seed_facts AS (
      SELECT fact.*
      FROM session_statistics_facts AS fact
      JOIN authorized_sessions AS allowed USING (session_id)
      WHERE ${includesDayMaterials}
        AND fact.fact_kind IN ('input_material', 'tool_call')
        AND fact.recorded_at >= ${dayFrom}::timestamptz
        AND fact.recorded_at < LEAST(${dayBefore}::timestamptz, ${asOf}::timestamptz)
    ),
    seed_command_keys AS (
      SELECT DISTINCT session_id, accounting_key
      FROM (
        SELECT session_id, accounting_key
        FROM period_seed_facts
        WHERE accounting_key IS NOT NULL
          AND (fact_kind = 'usage' OR (fact_kind = 'boundary' AND boundary_type = 'command_started'))
        UNION ALL
        SELECT session_id, accounting_key
        FROM day_material_seed_facts
        WHERE accounting_key IS NOT NULL
      ) AS seed_keys
    ),
    seed_legacy_events AS (
      SELECT DISTINCT session_id, event_id
      FROM period_seed_facts
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
        FROM session_statistics_facts AS boundary
        WHERE boundary.session_id = seed.session_id
          AND boundary.fact_kind = 'boundary'
          AND boundary.boundary_type = 'input'
          AND boundary.event_id <= seed.event_id
          AND boundary.recorded_at < ${asOf}::timestamptz
        ORDER BY boundary.event_id DESC
        LIMIT 1
      ) AS previous_input ON true
      LEFT JOIN LATERAL (
        SELECT boundary.event_id
        FROM session_statistics_facts AS boundary
        WHERE boundary.session_id = seed.session_id
          AND boundary.fact_kind = 'boundary'
          AND boundary.boundary_type = 'input'
          AND boundary.event_id > previous_input.event_id
          AND boundary.recorded_at < ${asOf}::timestamptz
        ORDER BY boundary.event_id ASC
        LIMIT 1
      ) AS next_input ON true
      WHERE previous_input.event_id IS NOT NULL
    ),
    legacy_interval_facts AS (
      SELECT related.*
      FROM session_statistics_facts AS related
      JOIN legacy_seed_intervals AS interval
        ON interval.session_id = related.session_id
       AND related.event_id >= interval.interval_start_event_id
       AND (interval.interval_end_event_id IS NULL OR related.event_id < interval.interval_end_event_id)
      WHERE related.fact_kind = 'usage'
        AND related.recorded_at < ${asOf}::timestamptz
    ),
    legacy_interval_keys AS (
      SELECT DISTINCT session_id, accounting_key
      FROM legacy_interval_facts
      WHERE accounting_key IS NOT NULL
    ),
    keyed_sibling_facts AS (
      SELECT sibling.*
      FROM session_statistics_facts AS sibling
      JOIN seed_command_keys AS seed
        ON seed.session_id = sibling.session_id
       AND seed.accounting_key = sibling.accounting_key
      WHERE sibling.fact_kind = 'usage'
        AND sibling.recorded_at < ${asOf}::timestamptz
    ),
    legacy_keyed_sibling_facts AS (
      SELECT sibling.*
      FROM session_statistics_facts AS sibling
      JOIN legacy_interval_keys AS seed
        ON seed.session_id = sibling.session_id
       AND seed.accounting_key = sibling.accounting_key
      WHERE sibling.fact_kind = 'usage'
        AND sibling.recorded_at < ${asOf}::timestamptz
    ),
    seeded_keyed_sibling_facts AS (
      SELECT * FROM keyed_sibling_facts
      UNION
      SELECT * FROM legacy_keyed_sibling_facts
    ),
    base_relevant_event_positions AS (
      SELECT session_id, event_id, input_id
      FROM period_seed_facts
      UNION
      SELECT session_id, event_id, input_id
      FROM day_material_seed_facts
      UNION
      SELECT session_id, event_id, input_id
      FROM seeded_keyed_sibling_facts
      UNION
      SELECT session_id, event_id, input_id
      FROM legacy_interval_facts
    ),
    relevant_input_ids AS (
      SELECT DISTINCT session_id, input_id
      FROM base_relevant_event_positions
      WHERE input_id IS NOT NULL
    ),
    explicit_input_usage_facts AS (
      SELECT usage.*
      FROM relevant_input_ids AS input
      JOIN session_statistics_facts AS usage
        ON usage.session_id = input.session_id
       AND usage.input_id = input.input_id
      WHERE usage.fact_kind = 'usage'
        AND usage.recorded_at < ${asOf}::timestamptz
    ),
    explicit_input_command_keys AS (
      SELECT DISTINCT session_id, accounting_key
      FROM explicit_input_usage_facts
      WHERE accounting_key IS NOT NULL
    ),
    explicit_input_keyed_sibling_facts AS (
      SELECT sibling.*
      FROM session_statistics_facts AS sibling
      JOIN explicit_input_command_keys AS seed
        ON seed.session_id = sibling.session_id
       AND seed.accounting_key = sibling.accounting_key
      WHERE sibling.fact_kind = 'usage'
        AND sibling.recorded_at < ${asOf}::timestamptz
    ),
    all_keyed_sibling_facts AS (
      SELECT * FROM seeded_keyed_sibling_facts
      UNION
      SELECT * FROM explicit_input_keyed_sibling_facts
    ),
    relevant_event_positions AS (
      SELECT * FROM base_relevant_event_positions
      UNION
      SELECT session_id, event_id, input_id
      FROM explicit_input_usage_facts
      UNION
      SELECT session_id, event_id, input_id
      FROM explicit_input_keyed_sibling_facts
    ),
    previous_input_boundary_facts AS (
      SELECT previous.*
      FROM relevant_event_positions AS position
      JOIN LATERAL (
        SELECT boundary.*
        FROM session_statistics_facts AS boundary
        WHERE boundary.session_id = position.session_id
          AND boundary.fact_kind = 'boundary'
          AND boundary.boundary_type = 'input'
          AND boundary.event_id <= position.event_id
          AND boundary.recorded_at < ${asOf}::timestamptz
        ORDER BY boundary.event_id DESC
        LIMIT 1
      ) AS previous ON true
    ),
    next_input_boundary_facts AS (
      SELECT next_boundary.*
      FROM relevant_event_positions AS position
      JOIN LATERAL (
        SELECT boundary.*
        FROM session_statistics_facts AS boundary
        WHERE boundary.session_id = position.session_id
          AND boundary.fact_kind = 'boundary'
          AND boundary.boundary_type = 'input'
          AND boundary.event_id > position.event_id
          AND boundary.recorded_at < ${asOf}::timestamptz
        ORDER BY boundary.event_id ASC
        LIMIT 1
      ) AS next_boundary ON true
    ),
    exact_input_boundary_facts AS (
      SELECT boundary.*
      FROM relevant_event_positions AS position
      JOIN session_statistics_facts AS boundary
        ON boundary.session_id = position.session_id
       AND boundary.input_id = position.input_id
      WHERE position.input_id IS NOT NULL
        AND boundary.fact_kind = 'boundary'
        AND boundary.boundary_type = 'input'
        AND boundary.recorded_at < ${asOf}::timestamptz
    ),
    interval_input_starts AS (
      SELECT * FROM previous_input_boundary_facts
      UNION
      SELECT * FROM exact_input_boundary_facts
      UNION
      SELECT *
      FROM period_seed_facts
      WHERE fact_kind = 'boundary' AND boundary_type = 'input'
    ),
    interval_boundary_facts AS (
      SELECT boundary.*
      FROM interval_input_starts AS input_start
      LEFT JOIN LATERAL (
        SELECT later_input.event_id
        FROM session_statistics_facts AS later_input
        WHERE later_input.session_id = input_start.session_id
          AND later_input.fact_kind = 'boundary'
          AND later_input.boundary_type = 'input'
          AND later_input.event_id > input_start.event_id
          AND later_input.recorded_at < ${asOf}::timestamptz
        ORDER BY later_input.event_id ASC
        LIMIT 1
      ) AS next_input ON true
      JOIN session_statistics_facts AS boundary
        ON boundary.session_id = input_start.session_id
       AND boundary.fact_kind = 'boundary'
       AND boundary.event_id >= input_start.event_id
       AND (next_input.event_id IS NULL OR boundary.event_id < next_input.event_id)
       AND boundary.recorded_at < ${asOf}::timestamptz
    ),
    boundary_facts AS (
      SELECT * FROM period_seed_facts WHERE fact_kind = 'boundary'
      UNION
      SELECT * FROM previous_input_boundary_facts
      UNION
      SELECT * FROM next_input_boundary_facts
      UNION
      SELECT * FROM exact_input_boundary_facts
      UNION
      SELECT * FROM interval_boundary_facts
    ),
    scoped_facts AS (
      SELECT * FROM period_seed_facts
      UNION
      SELECT * FROM day_material_seed_facts
      UNION
      SELECT * FROM all_keyed_sibling_facts
      UNION
      SELECT * FROM boundary_facts
      UNION
      SELECT * FROM legacy_interval_facts
      UNION
      SELECT * FROM explicit_input_usage_facts
    )
  `;
}
