import {
  normalizeSessionStatisticsEvent,
  type FactDraft,
} from "./session_statistics_normalizer.js";
import type { EventIngressQuerySql } from "../node/event_ingress_repository.js";
import type { EventIngressEnvelope } from "../node/event_ingress_types.js";

export type ApplySessionStatisticsProjectionInput = {
  eventId: number;
  envelope: EventIngressEnvelope;
};

export async function applySessionStatisticsProjection(
  sql: EventIngressQuerySql,
  input: ApplySessionStatisticsProjectionInput,
): Promise<void> {
  const normalized = normalizeSessionStatisticsEvent({
    sessionId: input.envelope.session_id,
    eventId: input.eventId,
    eventType: input.envelope.event_type,
    createdAt: input.envelope.created_at,
    payload: input.envelope.payload,
  });
  await insertSessionStatisticsFacts(sql, normalized.facts);
}

export async function insertSessionStatisticsFacts(
  sql: EventIngressQuerySql,
  facts: readonly FactDraft[],
): Promise<void> {
  if (facts.length === 0) return;
  const rows = facts.map((fact) => ({
    ...fact,
    event_id: String(fact.event_id),
  }));
  await sql`
    INSERT INTO session_statistics_facts (
      session_id, event_id, part_key, fact_kind, recorded_at,
      source_event_type, normalization_version, accounting_key, input_id,
      candidate_type, provider, backend, model, usage_snapshot, quality,
      representation, input_total, output_total, total_tokens, cache_read,
      cache_write, reasoning_output, known_cost_usd, priced_tokens,
      unpriced_tokens, pricing_complete, pricing_version, raw_numeric,
      category, source_key, estimate_source, raw_chars_utf16,
      approximate_tokens, boundary_type
    )
    SELECT
      fact.session_id, fact.event_id, fact.part_key, fact.fact_kind,
      fact.recorded_at, fact.source_event_type, fact.normalization_version,
      fact.accounting_key, fact.input_id, fact.candidate_type, fact.provider,
      fact.backend, fact.model, fact.usage_snapshot, fact.quality,
      fact.representation, fact.input_total, fact.output_total,
      fact.total_tokens, fact.cache_read, fact.cache_write,
      fact.reasoning_output, fact.known_cost_usd, fact.priced_tokens,
      fact.unpriced_tokens, fact.pricing_complete, fact.pricing_version,
      fact.raw_numeric, fact.category, fact.source_key, fact.estimate_source,
      fact.raw_chars_utf16, fact.approximate_tokens, fact.boundary_type
    FROM jsonb_to_recordset(${sql.json(rows)}::jsonb) AS fact(
      session_id TEXT,
      event_id BIGINT,
      part_key TEXT,
      fact_kind TEXT,
      recorded_at TIMESTAMPTZ,
      source_event_type TEXT,
      normalization_version INTEGER,
      accounting_key TEXT,
      input_id TEXT,
      candidate_type TEXT,
      provider TEXT,
      backend TEXT,
      model TEXT,
      usage_snapshot JSONB,
      quality JSONB,
      representation TEXT,
      input_total BIGINT,
      output_total BIGINT,
      total_tokens BIGINT,
      cache_read BIGINT,
      cache_write BIGINT,
      reasoning_output BIGINT,
      known_cost_usd NUMERIC,
      priced_tokens BIGINT,
      unpriced_tokens BIGINT,
      pricing_complete BOOLEAN,
      pricing_version TEXT,
      raw_numeric JSONB,
      category TEXT,
      source_key TEXT,
      estimate_source TEXT,
      raw_chars_utf16 BIGINT,
      approximate_tokens BIGINT,
      boundary_type TEXT
    )
    ON CONFLICT (session_id, event_id, part_key) DO NOTHING
  `;
}
