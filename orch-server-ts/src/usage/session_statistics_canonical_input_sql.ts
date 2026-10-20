import type { EventIngressSqlFragment } from "../node/event_ingress_repository.js";

export function createSessionStatisticsInputLookupCtes(
  fragment: EventIngressSqlFragment,
): unknown {
  return fragment`
    exact_input_boundaries AS (
      SELECT
        session_id,
        input_id,
        min(event_id) AS event_id
      FROM scoped_facts
      WHERE fact_kind = 'boundary'
        AND boundary_type = 'input'
        AND input_id IS NOT NULL
      GROUP BY session_id, input_id
    ),
    input_lookup_positions AS (
      SELECT DISTINCT
        session_id,
        coalesce(owner_event_id, candidate_event_id, interval_start_event_id, 0)::bigint AS position_event_id
      FROM usage_selections
    ),
    input_lookup_scan AS (
      SELECT
        session_id,
        position_event_id,
        is_boundary,
        max(CASE WHEN is_boundary THEN position_event_id END) OVER (
          PARTITION BY session_id
          ORDER BY position_event_id, is_boundary DESC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS input_boundary_event_id
      FROM (
        SELECT
          session_id,
          event_id AS position_event_id,
          true AS is_boundary
        FROM scoped_facts
        WHERE fact_kind = 'boundary'
          AND boundary_type = 'input'
        UNION ALL
        SELECT
          session_id,
          position_event_id,
          false AS is_boundary
        FROM input_lookup_positions
      ) AS lookup_rows
    ),
    previous_input_boundaries AS (
      SELECT
        session_id,
        position_event_id,
        input_boundary_event_id
      FROM input_lookup_scan
      WHERE NOT is_boundary
    )
  `;
}
