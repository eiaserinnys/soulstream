import type { EventIngressSqlFragment } from "../node/event_ingress_repository.js";

export function createSessionStatisticsUsageCtes(
  fragment: EventIngressSqlFragment,
): unknown {
  return fragment`
    usage_events AS (
      SELECT
        session_id,
        event_id,
        min(accounting_key) AS accounting_key,
        min(input_id) AS input_id,
        min(candidate_type) AS candidate_type,
        min(recorded_at) AS recorded_at,
        bool_or(quality @> '["identity_conflict"]'::jsonb) AS identity_conflict
      FROM scoped_facts
      WHERE fact_kind = 'usage'
      GROUP BY session_id, event_id
    ),
    model_breakdown_validity AS (
      SELECT
        aggregate_fact.session_id,
        aggregate_fact.event_id,
        count(model_fact.part_key) > 0
          AND aggregate_fact.input_total IS NOT NULL
          AND aggregate_fact.output_total IS NOT NULL
          AND (
            (aggregate_fact.input_total IS NULL AND bool_and(model_fact.input_total IS NULL))
            OR (aggregate_fact.input_total IS NOT NULL
              AND bool_and(model_fact.input_total IS NOT NULL)
              AND sum(model_fact.input_total) = aggregate_fact.input_total)
          )
          AND (
            (aggregate_fact.output_total IS NULL AND bool_and(model_fact.output_total IS NULL))
            OR (aggregate_fact.output_total IS NOT NULL
              AND bool_and(model_fact.output_total IS NOT NULL)
              AND sum(model_fact.output_total) = aggregate_fact.output_total)
          )
          AND (
            (aggregate_fact.cache_read IS NULL AND bool_and(model_fact.cache_read IS NULL))
            OR (aggregate_fact.cache_read IS NOT NULL
              AND bool_and(model_fact.cache_read IS NOT NULL)
              AND sum(model_fact.cache_read) = aggregate_fact.cache_read)
          )
          AND (
            (aggregate_fact.cache_write IS NULL AND bool_and(model_fact.cache_write IS NULL))
            OR (aggregate_fact.cache_write IS NOT NULL
              AND bool_and(model_fact.cache_write IS NOT NULL)
              AND sum(model_fact.cache_write) = aggregate_fact.cache_write)
          )
          AND (
            (aggregate_fact.reasoning_output IS NULL AND bool_and(model_fact.reasoning_output IS NULL))
            OR (aggregate_fact.reasoning_output IS NOT NULL
              AND bool_and(model_fact.reasoning_output IS NOT NULL)
              AND sum(model_fact.reasoning_output) = aggregate_fact.reasoning_output)
          ) AS is_valid
      FROM scoped_facts AS aggregate_fact
      JOIN scoped_facts AS model_fact
        ON model_fact.session_id = aggregate_fact.session_id
       AND model_fact.event_id = aggregate_fact.event_id
       AND model_fact.fact_kind = 'usage'
       AND model_fact.representation = 'model_breakdown'
      WHERE aggregate_fact.fact_kind = 'usage'
        AND aggregate_fact.representation = 'aggregate'
      GROUP BY
        aggregate_fact.session_id, aggregate_fact.event_id,
        aggregate_fact.input_total, aggregate_fact.output_total,
        aggregate_fact.cache_read, aggregate_fact.cache_write,
        aggregate_fact.reasoning_output
    ),
    usage_profiles AS (
      SELECT
        event.*,
        EXISTS (
          SELECT 1 FROM scoped_facts AS fact
          WHERE fact.session_id = event.session_id AND fact.event_id = event.event_id
            AND fact.fact_kind = 'usage' AND fact.representation = 'aggregate'
        ) AS has_aggregate,
        EXISTS (
          SELECT 1 FROM scoped_facts AS fact
          WHERE fact.session_id = event.session_id AND fact.event_id = event.event_id
            AND fact.fact_kind = 'usage' AND fact.representation = 'model_breakdown'
        ) AS has_model_breakdown,
        coalesce((
          SELECT validity.is_valid
          FROM model_breakdown_validity AS validity
          WHERE validity.session_id = event.session_id AND validity.event_id = event.event_id
        ), false) AS model_breakdown_valid,
        coalesce((
          SELECT fact.quality @> '["model_breakdown_unverified"]'::jsonb
            OR jsonb_typeof(fact.raw_numeric -> 'model_usage') = 'object'
          FROM scoped_facts AS fact
          WHERE fact.session_id = event.session_id AND fact.event_id = event.event_id
            AND fact.fact_kind = 'usage' AND fact.representation = 'aggregate'
          LIMIT 1
        ), false) AS aggregate_breakdown_unverified
      FROM usage_events AS event
    ),
    terminal_candidates AS (
      SELECT profile.*,
        row_number() OVER (
          PARTITION BY session_id, accounting_key
          ORDER BY CASE candidate_type
            WHEN 'complete' THEN 4
            WHEN 'failed_error' THEN 3
            WHEN 'failed_result' THEN 2
            WHEN 'interrupt_observation' THEN 1
            ELSE 0
          END DESC, event_id DESC
        ) AS owner_rank
      FROM usage_profiles AS profile
      WHERE accounting_key IS NOT NULL
        AND NOT identity_conflict
        AND candidate_type IN ('complete', 'failed_error', 'failed_result', 'interrupt_observation')
    ),
    keyed_owners AS (
      SELECT * FROM terminal_candidates WHERE owner_rank = 1
    ),
    keyed_successes AS (
      SELECT profile.*,
        row_number() OVER (
          PARTITION BY session_id, accounting_key
          ORDER BY event_id DESC
        ) AS success_rank
      FROM usage_profiles AS profile
      WHERE accounting_key IS NOT NULL
        AND NOT identity_conflict
        AND candidate_type = 'success_result'
        AND NOT EXISTS (
          SELECT 1 FROM usage_profiles AS terminal
          WHERE terminal.session_id = profile.session_id
            AND terminal.accounting_key = profile.accounting_key
            AND NOT terminal.identity_conflict
            AND terminal.candidate_type IN ('complete', 'failed_error', 'failed_result', 'interrupt_observation')
        )
    ),
    keyed_pending AS (
      SELECT
        success.session_id,
        success.accounting_key,
        success.input_id,
        NULL::bigint AS owner_event_id,
        success.event_id AS candidate_event_id,
        success.candidate_type,
        'diagnostic'::text AS representation,
        CASE WHEN previous_boundary.event_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM scoped_facts AS closing_boundary
          WHERE closing_boundary.session_id = success.session_id
            AND closing_boundary.fact_kind = 'boundary'
            AND closing_boundary.boundary_type IN ('input', 'session_ended')
            AND closing_boundary.event_id > previous_boundary.event_id
        ) THEN 'missing' ELSE 'pending' END::text AS state,
        '[]'::jsonb AS selection_quality,
        success.recorded_at AS owner_recorded_at,
        NULL::bigint AS selected_event_id,
        'none'::text AS fact_mode,
        NULL::bigint AS interval_start_event_id,
        NULL::bigint AS interval_end_event_id,
        false AS model_unverified
      FROM keyed_successes AS success
      LEFT JOIN LATERAL (
        SELECT input_boundary.event_id
        FROM scoped_facts AS input_boundary
        WHERE input_boundary.session_id = success.session_id
          AND input_boundary.fact_kind = 'boundary'
          AND input_boundary.boundary_type = 'input'
          AND (
            (success.input_id IS NOT NULL AND input_boundary.input_id = success.input_id)
            OR (
              NOT EXISTS (
                SELECT 1 FROM scoped_facts AS exact_input
                WHERE exact_input.session_id = success.session_id
                  AND exact_input.fact_kind = 'boundary'
                  AND exact_input.boundary_type = 'input'
                  AND exact_input.input_id = success.input_id
              )
              AND input_boundary.event_id <= success.event_id
            )
          )
        ORDER BY
          CASE WHEN success.input_id IS NOT NULL AND input_boundary.input_id = success.input_id THEN 0 ELSE 1 END,
          CASE WHEN success.input_id IS NOT NULL AND input_boundary.input_id = success.input_id
            THEN input_boundary.event_id END ASC,
          CASE WHEN success.input_id IS NULL OR input_boundary.input_id IS DISTINCT FROM success.input_id
            THEN input_boundary.event_id END DESC
        LIMIT 1
      ) AS previous_boundary ON true
      WHERE success.success_rank = 1
    ),
    identity_conflict_selections AS (
      SELECT
        event.session_id,
        event.accounting_key,
        event.input_id,
        NULL::bigint AS owner_event_id,
        event.event_id AS candidate_event_id,
        event.candidate_type,
        'diagnostic'::text AS representation,
        'identity_conflict'::text AS state,
        '["identity_conflict"]'::jsonb AS selection_quality,
        event.recorded_at AS owner_recorded_at,
        NULL::bigint AS selected_event_id,
        'none'::text AS fact_mode,
        NULL::bigint AS interval_start_event_id,
        NULL::bigint AS interval_end_event_id,
        false AS model_unverified
      FROM usage_profiles AS event
      WHERE event.identity_conflict
    ),
    keyed_owner_selections AS (
      SELECT
        owner.session_id,
        owner.accounting_key,
        owner.input_id,
        owner.event_id AS owner_event_id,
        owner.event_id AS candidate_event_id,
        owner.candidate_type,
        CASE WHEN owner.model_breakdown_valid THEN 'model_breakdown'
          WHEN owner.has_aggregate THEN 'aggregate' ELSE 'diagnostic' END::text AS representation,
        'owned'::text AS state,
        CASE WHEN NOT owner.model_breakdown_valid AND owner.has_aggregate
          AND (owner.has_model_breakdown OR owner.aggregate_breakdown_unverified)
          THEN '["model_breakdown_unverified"]'::jsonb ELSE '[]'::jsonb END AS selection_quality,
        owner.recorded_at AS owner_recorded_at,
        owner.event_id AS selected_event_id,
        'event'::text AS fact_mode,
        NULL::bigint AS interval_start_event_id,
        NULL::bigint AS interval_end_event_id,
        (NOT owner.model_breakdown_valid AND owner.has_aggregate
          AND (owner.has_model_breakdown OR owner.aggregate_breakdown_unverified)) AS model_unverified
      FROM keyed_owners AS owner
    ),
    legacy_complete_selections AS (
      SELECT
        event.session_id,
        event.accounting_key,
        event.input_id,
        event.event_id AS owner_event_id,
        event.event_id AS candidate_event_id,
        event.candidate_type,
        CASE WHEN event.model_breakdown_valid THEN 'model_breakdown'
          WHEN event.has_aggregate THEN 'aggregate' ELSE 'diagnostic' END::text AS representation,
        'owned'::text AS state,
        CASE WHEN NOT event.model_breakdown_valid AND event.has_aggregate
          AND (event.has_model_breakdown OR event.aggregate_breakdown_unverified)
          THEN '["model_breakdown_unverified"]'::jsonb ELSE '[]'::jsonb END AS selection_quality,
        event.recorded_at AS owner_recorded_at,
        event.event_id AS selected_event_id,
        'event'::text AS fact_mode,
        NULL::bigint AS interval_start_event_id,
        NULL::bigint AS interval_end_event_id,
        (NOT event.model_breakdown_valid AND event.has_aggregate
          AND (event.has_model_breakdown OR event.aggregate_breakdown_unverified)) AS model_unverified
      FROM usage_profiles AS event
      WHERE event.accounting_key IS NULL
        AND NOT event.identity_conflict
        AND event.candidate_type = 'complete'
    ),
    legacy_failed_candidates AS (
      SELECT
        event.*,
        previous_input.event_id AS interval_start_event_id,
        next_input.event_id AS interval_end_event_id
      FROM usage_profiles AS event
      LEFT JOIN LATERAL (
        SELECT boundary.event_id
        FROM scoped_facts AS boundary
        WHERE boundary.session_id = event.session_id
          AND boundary.fact_kind = 'boundary'
          AND boundary.boundary_type = 'input'
          AND boundary.event_id <= event.event_id
        ORDER BY boundary.event_id DESC
        LIMIT 1
      ) AS previous_input ON true
      LEFT JOIN LATERAL (
        SELECT boundary.event_id
        FROM scoped_facts AS boundary
        WHERE boundary.session_id = event.session_id
          AND boundary.fact_kind = 'boundary'
          AND boundary.boundary_type = 'input'
          AND boundary.event_id > previous_input.event_id
        ORDER BY boundary.event_id ASC
        LIMIT 1
      ) AS next_input ON true
      WHERE event.accounting_key IS NULL
        AND NOT event.identity_conflict
        AND event.candidate_type IN ('failed_result', 'failed_error')
    ),
    unresolved_legacy_selections AS (
      SELECT
        event.session_id,
        NULL::text AS accounting_key,
        event.input_id,
        NULL::bigint AS owner_event_id,
        event.event_id AS candidate_event_id,
        event.candidate_type,
        'diagnostic'::text AS representation,
        'unresolved_legacy'::text AS state,
        '["unresolved_legacy_accounting"]'::jsonb AS selection_quality,
        event.recorded_at AS owner_recorded_at,
        NULL::bigint AS selected_event_id,
        'none'::text AS fact_mode,
        NULL::bigint AS interval_start_event_id,
        NULL::bigint AS interval_end_event_id,
        false AS model_unverified
      FROM legacy_failed_candidates AS event
      WHERE event.interval_start_event_id IS NULL
    ),
    legacy_failure_intervals AS (
      SELECT
        session_id,
        interval_start_event_id,
        interval_end_event_id,
        count(*) AS failure_count,
        count(DISTINCT candidate_type) AS candidate_type_count,
        min(candidate_type) AS candidate_type,
        min(event_id) AS failed_event_id,
        bool_or(exists (
          SELECT 1
          FROM usage_profiles AS other
          WHERE other.session_id = failed.session_id
            AND other.event_id >= failed.interval_start_event_id
            AND (failed.interval_end_event_id IS NULL OR other.event_id < failed.interval_end_event_id)
            AND NOT other.identity_conflict
            AND (
              (other.accounting_key IS NOT NULL
                AND other.candidate_type IN ('complete', 'failed_error', 'failed_result', 'interrupt_observation'))
              OR (other.accounting_key IS NULL AND other.candidate_type = 'complete')
            )
        )) AS has_other_owner
      FROM legacy_failed_candidates AS failed
      WHERE interval_start_event_id IS NOT NULL
      GROUP BY session_id, interval_start_event_id, interval_end_event_id
    ),
    legacy_failure_selections AS (
      SELECT
        interval.session_id,
        NULL::text AS accounting_key,
        failure.input_id,
        CASE WHEN interval.failure_count = 1 AND NOT interval.has_other_owner
          THEN interval.failed_event_id ELSE NULL END::bigint AS owner_event_id,
        CASE WHEN interval.failure_count = 1 AND NOT interval.has_other_owner
          THEN interval.failed_event_id ELSE NULL END::bigint AS candidate_event_id,
        CASE WHEN interval.candidate_type_count = 1 THEN interval.candidate_type ELSE NULL END::text AS candidate_type,
        CASE WHEN interval.failure_count = 1 AND NOT interval.has_other_owner THEN
          CASE WHEN failure.model_breakdown_valid THEN 'model_breakdown'
            WHEN failure.has_aggregate THEN 'aggregate' ELSE 'diagnostic' END
          ELSE 'diagnostic' END::text AS representation,
        CASE WHEN interval.failure_count = 1 AND NOT interval.has_other_owner
          THEN 'owned' ELSE 'ambiguous_legacy' END::text AS state,
        CASE WHEN interval.failure_count = 1 AND NOT interval.has_other_owner THEN
          CASE WHEN NOT failure.model_breakdown_valid AND failure.has_aggregate
            AND (failure.has_model_breakdown OR failure.aggregate_breakdown_unverified)
            THEN '["model_breakdown_unverified"]'::jsonb ELSE '[]'::jsonb END
          ELSE '["ambiguous_legacy_accounting"]'::jsonb END AS selection_quality,
        CASE WHEN interval.failure_count = 1 AND NOT interval.has_other_owner
          THEN failure.recorded_at ELSE NULL END AS owner_recorded_at,
        CASE WHEN interval.failure_count = 1 AND NOT interval.has_other_owner
          THEN interval.failed_event_id ELSE NULL END::bigint AS selected_event_id,
        CASE WHEN interval.failure_count = 1 AND NOT interval.has_other_owner
          THEN 'event' ELSE 'ambiguous_legacy' END::text AS fact_mode,
        interval.interval_start_event_id,
        interval.interval_end_event_id,
        (interval.failure_count = 1 AND NOT interval.has_other_owner
          AND NOT failure.model_breakdown_valid AND failure.has_aggregate
          AND (failure.has_model_breakdown OR failure.aggregate_breakdown_unverified)) AS model_unverified
      FROM legacy_failure_intervals AS interval
      LEFT JOIN usage_profiles AS failure
        ON failure.session_id = interval.session_id
       AND failure.event_id = interval.failed_event_id
    ),
    usage_selections AS (
      SELECT * FROM identity_conflict_selections
      UNION ALL SELECT * FROM keyed_owner_selections
      UNION ALL SELECT * FROM keyed_pending
      UNION ALL SELECT * FROM legacy_complete_selections
      UNION ALL SELECT * FROM unresolved_legacy_selections
      UNION ALL SELECT * FROM legacy_failure_selections
    ),
    labeled_usage_selections AS (
      SELECT
        selection.*,
        coalesce(owner_event_id, candidate_event_id, interval_start_event_id, 0)::bigint AS selection_event_id,
        input_boundary.event_id AS input_boundary_event_id,
        CASE WHEN selection.state IN (
          'missing', 'pending', 'ambiguous_legacy', 'unresolved_legacy', 'identity_conflict'
        ) THEN coalesce(
          CASE WHEN selection.input_id IS NOT NULL THEN 'input:' || selection.input_id END,
          CASE WHEN input_boundary.event_id IS NOT NULL THEN 'user_event:' || input_boundary.event_id::text END,
          CASE WHEN selection.accounting_key IS NOT NULL THEN 'command:' || selection.accounting_key END,
          CASE WHEN selection.candidate_event_id IS NOT NULL THEN 'event:' || selection.candidate_event_id::text END
        ) END AS missing_identity
      FROM usage_selections AS selection
      LEFT JOIN LATERAL (
        SELECT boundary.event_id
        FROM scoped_facts AS boundary
        WHERE boundary.session_id = selection.session_id
          AND boundary.fact_kind = 'boundary'
          AND boundary.boundary_type = 'input'
          AND (
            (selection.input_id IS NOT NULL AND boundary.input_id = selection.input_id)
            OR (boundary.event_id <= coalesce(
              selection.owner_event_id, selection.candidate_event_id,
              selection.interval_start_event_id, 0
            ))
          )
        ORDER BY
          CASE WHEN selection.input_id IS NOT NULL AND boundary.input_id = selection.input_id THEN 0 ELSE 1 END,
          CASE WHEN selection.input_id IS NOT NULL AND boundary.input_id = selection.input_id
            THEN boundary.event_id END ASC,
          CASE WHEN selection.input_id IS NULL OR boundary.input_id IS DISTINCT FROM selection.input_id
            THEN boundary.event_id END DESC
        LIMIT 1
      ) AS input_boundary ON true
    ),
    usage_rows AS (
      SELECT
        'usage'::text AS row_kind,
        selection.session_id,
        selection.selection_event_id,
        selection.input_id,
        selection.missing_identity,
        selection.accounting_key,
        selection.owner_event_id,
        selection.candidate_event_id,
        selection.candidate_type,
        selection.representation,
        selection.state,
        selection.selection_quality,
        selection.owner_recorded_at,
        CASE WHEN fact.part_key IS NULL THEN NULL::jsonb
          WHEN selection.model_unverified AND fact.representation = 'aggregate' THEN (
            SELECT jsonb_set(
              jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(
                      jsonb_set(to_jsonb(fact), '{model}', 'null'::jsonb, true),
                      '{known_cost_usd}', 'null'::jsonb, true
                    ),
                    '{priced_tokens}', '0'::jsonb, true
                  ),
                  '{unpriced_tokens}',
                  CASE WHEN fact.input_total IS NULL OR fact.output_total IS NULL
                    THEN 'null'::jsonb ELSE to_jsonb(fact.input_total + fact.output_total) END,
                  true
                ),
                '{pricing_complete}', 'false'::jsonb, true
              ),
              '{quality}', (
                SELECT jsonb_agg(quality_code ORDER BY quality_code)
                FROM (
                  SELECT DISTINCT value AS quality_code
                  FROM jsonb_array_elements_text(fact.quality)
                  UNION SELECT 'model_breakdown_unverified'
                ) AS quality_values
              ),
              true
            )
          )
          ELSE to_jsonb(fact) END AS fact
      FROM labeled_usage_selections AS selection
      LEFT JOIN LATERAL (
        SELECT selected_fact.*
        FROM scoped_facts AS selected_fact
        WHERE selected_fact.session_id = selection.session_id
          AND selected_fact.fact_kind = 'usage'
          AND (
            (selection.fact_mode = 'event'
              AND selected_fact.event_id = selection.selected_event_id
              AND (
                (selection.representation = 'aggregate' AND selected_fact.representation = 'aggregate')
                OR (selection.representation = 'model_breakdown' AND selected_fact.representation = 'model_breakdown')
              ))
            OR (selection.fact_mode = 'ambiguous_legacy'
              AND selected_fact.event_id >= selection.interval_start_event_id
              AND (selection.interval_end_event_id IS NULL OR selected_fact.event_id < selection.interval_end_event_id)
              AND selected_fact.accounting_key IS NULL
              AND selected_fact.candidate_type IN ('failed_result', 'failed_error')
              AND NOT (selected_fact.quality @> '["identity_conflict"]'::jsonb))
          )
      ) AS fact ON true
    )
  `;
}
