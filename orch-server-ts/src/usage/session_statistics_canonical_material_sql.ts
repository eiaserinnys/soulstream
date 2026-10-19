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
    material_rows AS (
      SELECT
        'input_material'::text AS row_kind,
        material.session_id,
        material.event_id AS selection_event_id,
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
