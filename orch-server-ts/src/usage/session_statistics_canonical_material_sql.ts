import type { EventIngressSqlFragment } from "../node/event_ingress_repository.js";

export function createSessionStatisticsMaterialCtes(
  fragment: EventIngressSqlFragment,
): unknown {
  return fragment`
    latest_new_manifests AS (
      SELECT DISTINCT ON (session_id, accounting_key)
        session_id, accounting_key, event_id, input_id
      FROM scoped_facts
      WHERE fact_kind = 'boundary'
        AND source_event_type = 'input_material_manifest'
        AND accounting_key IS NOT NULL
        AND NOT (quality @> '["identity_conflict"]'::jsonb)
      ORDER BY session_id, accounting_key, event_id DESC
    ),
    new_manifest_input_ids AS (
      SELECT DISTINCT session_id, input_id
      FROM latest_new_manifests
      WHERE input_id IS NOT NULL
    ),
    body_input_ids AS (
      SELECT DISTINCT session_id, input_id
      FROM scoped_facts
      WHERE fact_kind = 'input_material'
        AND source_event_type IN ('user_message', 'system_message')
        AND input_id IS NOT NULL
    ),
    latest_legacy_manifests AS (
      SELECT DISTINCT ON (material.session_id, material.input_id)
        material.session_id, material.input_id, material.event_id
      FROM scoped_facts AS material
      JOIN body_input_ids AS body USING (session_id, input_id)
      WHERE material.fact_kind = 'input_material'
        AND material.source_event_type = 'context_manifest'
        AND NOT EXISTS (
          SELECT 1 FROM new_manifest_input_ids AS new_manifest
          WHERE new_manifest.session_id = material.session_id
            AND new_manifest.input_id = material.input_id
        )
      ORDER BY material.session_id, material.input_id, material.event_id DESC
    ),
    legacy_manifest_input_ids AS (
      SELECT DISTINCT session_id, input_id FROM latest_legacy_manifests
    ),
    selected_material AS (
      SELECT material.*
      FROM scoped_facts AS material
      WHERE material.fact_kind = 'input_material'
        AND NOT (material.quality @> '["identity_conflict"]'::jsonb)
        AND NOT (material.quality @> '["unmatched_legacy_material"]'::jsonb)
        AND (
          (material.source_event_type = 'input_material_manifest' AND EXISTS (
            SELECT 1 FROM latest_new_manifests AS latest
            WHERE latest.session_id = material.session_id
              AND latest.accounting_key = material.accounting_key
              AND latest.event_id = material.event_id
          ))
          OR (material.source_event_type = 'context_manifest' AND EXISTS (
            SELECT 1 FROM latest_legacy_manifests AS latest
            WHERE latest.session_id = material.session_id
              AND latest.input_id = material.input_id
              AND latest.event_id = material.event_id
          ))
          OR (material.source_event_type IN ('user_message', 'system_message')
            AND (material.input_id IS NULL OR (
              NOT EXISTS (
                SELECT 1 FROM new_manifest_input_ids AS new_manifest
                WHERE new_manifest.session_id = material.session_id
                  AND new_manifest.input_id = material.input_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM legacy_manifest_input_ids AS legacy_manifest
                WHERE legacy_manifest.session_id = material.session_id
                  AND legacy_manifest.input_id = material.input_id
              )
            )))
          OR material.source_event_type = 'tool_result'
        )
    ),
    input_boundary_starts AS (
      SELECT DISTINCT ON (
        boundary.session_id,
        CASE WHEN boundary.input_id IS NULL
          THEN 'user_event:' || boundary.event_id::text
          ELSE 'input:' || boundary.input_id END
      )
        boundary.session_id,
        boundary.input_id,
        boundary.event_id AS start_event_id,
        boundary.recorded_at,
        CASE WHEN boundary.input_id IS NULL
          THEN 'user_event:' || boundary.event_id::text
          ELSE 'input:' || boundary.input_id END AS missing_identity
      FROM scoped_facts AS boundary
      WHERE boundary.fact_kind = 'boundary'
        AND boundary.boundary_type = 'input'
      ORDER BY
        boundary.session_id,
        CASE WHEN boundary.input_id IS NULL
          THEN 'user_event:' || boundary.event_id::text
          ELSE 'input:' || boundary.input_id END,
        boundary.event_id
    ),
    input_boundary_intervals AS (
      SELECT
        input_boundary.*,
        lead(start_event_id) OVER (
          PARTITION BY session_id ORDER BY start_event_id
        ) AS next_input_event_id,
        EXISTS (
          SELECT 1 FROM scoped_facts AS closing_boundary
          WHERE closing_boundary.session_id = input_boundary.session_id
            AND closing_boundary.fact_kind = 'boundary'
            AND closing_boundary.boundary_type = 'session_ended'
            AND closing_boundary.event_id > input_boundary.start_event_id
        ) AS has_session_end
      FROM input_boundary_starts AS input_boundary
    ),
    input_coverage_rows AS (
      SELECT
        'usage'::text AS row_kind,
        input_boundary.session_id,
        input_boundary.start_event_id AS selection_event_id,
        input_boundary.input_id,
        input_boundary.missing_identity,
        NULL::text AS accounting_key,
        NULL::bigint AS owner_event_id,
        input_boundary.start_event_id AS candidate_event_id,
        NULL::text AS candidate_type,
        'diagnostic'::text AS representation,
        CASE WHEN EXISTS (
          SELECT 1 FROM labeled_usage_selections AS incomplete_owner
          WHERE incomplete_owner.session_id = input_boundary.session_id
            AND incomplete_owner.input_boundary_event_id = input_boundary.start_event_id
            AND incomplete_owner.state = 'owned'
        ) OR input_boundary.next_input_event_id IS NOT NULL
          OR input_boundary.has_session_end THEN 'missing' ELSE 'pending' END::text AS state,
        '[]'::jsonb AS selection_quality,
        input_boundary.recorded_at AS owner_recorded_at,
        NULL::jsonb AS fact
      FROM input_boundary_intervals AS input_boundary
      WHERE NOT EXISTS (
        SELECT 1 FROM labeled_usage_selections AS selection
        WHERE selection.session_id = input_boundary.session_id
          AND selection.input_boundary_event_id = input_boundary.start_event_id
          AND selection.state <> 'owned'
      )
        AND (NOT EXISTS (
          SELECT 1
          FROM labeled_usage_selections AS selection
          JOIN scoped_facts AS selected_fact
            ON selected_fact.session_id = selection.session_id
           AND selected_fact.event_id = selection.selected_event_id
           AND selected_fact.fact_kind = 'usage'
           AND selected_fact.representation = selection.representation
          WHERE selection.session_id = input_boundary.session_id
            AND selection.input_boundary_event_id = input_boundary.start_event_id
            AND selection.state = 'owned'
            AND selected_fact.input_total IS NOT NULL
            AND selected_fact.output_total IS NOT NULL
        ) OR EXISTS (
          SELECT 1 FROM labeled_usage_selections AS incomplete_owner
          WHERE incomplete_owner.session_id = input_boundary.session_id
            AND incomplete_owner.input_boundary_event_id = input_boundary.start_event_id
            AND incomplete_owner.state = 'owned'
            AND NOT EXISTS (
              SELECT 1 FROM scoped_facts AS selected_fact
              WHERE selected_fact.session_id = incomplete_owner.session_id
                AND selected_fact.event_id = incomplete_owner.selected_event_id
                AND selected_fact.fact_kind = 'usage'
                AND selected_fact.representation = incomplete_owner.representation
                AND selected_fact.input_total IS NOT NULL
                AND selected_fact.output_total IS NOT NULL
            )
        ))
    ),
    unmatched_incomplete_owner_rows AS (
      SELECT
        'usage'::text AS row_kind,
        selection.session_id,
        selection.selection_event_id,
        selection.input_id,
        coalesce(
          CASE WHEN selection.input_id IS NOT NULL THEN 'input:' || selection.input_id END,
          CASE WHEN selection.accounting_key IS NOT NULL THEN 'command:' || selection.accounting_key END,
          CASE WHEN selection.candidate_event_id IS NOT NULL THEN 'event:' || selection.candidate_event_id::text END
        ) AS missing_identity,
        selection.accounting_key,
        NULL::bigint AS owner_event_id,
        NULL::bigint AS candidate_event_id,
        NULL::text AS candidate_type,
        'diagnostic'::text AS representation,
        'missing'::text AS state,
        selection.selection_quality,
        selection.owner_recorded_at,
        NULL::jsonb AS fact
      FROM labeled_usage_selections AS selection
      WHERE selection.state = 'owned'
        AND selection.input_boundary_event_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM scoped_facts AS selected_fact
          WHERE selected_fact.session_id = selection.session_id
            AND selected_fact.event_id = selection.selected_event_id
            AND selected_fact.fact_kind = 'usage'
            AND selected_fact.representation = selection.representation
            AND selected_fact.input_total IS NOT NULL
            AND selected_fact.output_total IS NOT NULL
        )
    ),
    material_rows AS (
      SELECT
        'input_material'::text AS row_kind,
        material.session_id,
        material.event_id AS selection_event_id,
        material.input_id,
        NULL::text AS missing_identity,
        material.accounting_key,
        material.event_id AS owner_event_id,
        material.event_id AS candidate_event_id,
        NULL::text AS candidate_type,
        NULL::text AS representation,
        'owned'::text AS state,
        '[]'::jsonb AS selection_quality,
        material.recorded_at AS owner_recorded_at,
        to_jsonb(material) AS fact
      FROM selected_material AS material
    ),
    supporting_fact_rows AS (
      SELECT
        fact.fact_kind AS row_kind,
        fact.session_id,
        fact.event_id AS selection_event_id,
        fact.input_id,
        NULL::text AS missing_identity,
        fact.accounting_key,
        fact.event_id AS owner_event_id,
        fact.event_id AS candidate_event_id,
        fact.candidate_type,
        fact.representation,
        'owned'::text AS state,
        '[]'::jsonb AS selection_quality,
        fact.recorded_at AS owner_recorded_at,
        to_jsonb(fact) AS fact
      FROM scoped_facts AS fact
      WHERE fact.fact_kind IN ('boundary', 'tool_call')
    )

  `;
}
