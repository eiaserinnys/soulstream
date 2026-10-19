import type { FactDraft } from "./session_statistics_normalizer.js";
import type {
  EventIngressQuerySql,
  EventIngressSqlFragment,
} from "../node/event_ingress_repository.js";
import { createSessionStatisticsScopeCtes } from "./session_statistics_canonical_scope_sql.js";
import { createSessionStatisticsUsageCtes } from "./session_statistics_canonical_usage_sql.js";
import { createSessionStatisticsMaterialCtes } from "./session_statistics_canonical_material_sql.js";

export type CanonicalSessionStatisticsRow = {
  row_kind: "usage" | "input_material" | "tool_call" | "boundary";
  session_id: string;
  selection_event_id: number;
  input_id: string | null;
  missing_identity: string | null;
  accounting_key: string | null;
  owner_event_id: number | null;
  candidate_event_id: number | null;
  candidate_type: FactDraft["candidate_type"];
  representation: FactDraft["representation"];
  state: "owned" | "pending" | "missing" | "ambiguous_legacy" | "unresolved_legacy" | "identity_conflict";
  selection_quality: string[];
  owner_recorded_at: string | null;
  fact: FactDraft | null;
};

type CanonicalSqlRow = Omit<
  CanonicalSessionStatisticsRow,
  "selection_event_id" | "owner_event_id" | "candidate_event_id" | "owner_recorded_at"
> & {
  selection_event_id: number | string;
  owner_event_id: number | string | null;
  candidate_event_id: number | string | null;
  owner_recorded_at: string | Date | null;
};

function parseEventId(value: number | string, field: string): number {
  const eventId = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(eventId)) {
    throw new Error(`canonical session statistics ${field} is not a safe event id`);
  }
  return eventId;
}

function toCanonicalRow(row: CanonicalSqlRow): CanonicalSessionStatisticsRow {
  return {
    ...row,
    selection_event_id: parseEventId(row.selection_event_id, "selection_event_id"),
    owner_event_id: row.owner_event_id === null
      ? null
      : parseEventId(row.owner_event_id, "owner_event_id"),
    candidate_event_id: row.candidate_event_id === null
      ? null
      : parseEventId(row.candidate_event_id, "candidate_event_id"),
    owner_recorded_at: row.owner_recorded_at instanceof Date
      ? row.owner_recorded_at.toISOString()
      : row.owner_recorded_at,
  };
}

/** Select canonical owners before callers apply provider/model/project filters. */
export async function createCanonicalSessionStatisticsFacts(
  sql: EventIngressQuerySql,
  authorizedSessionIds: readonly string[],
  range?: { recordedAtFrom: string; recordedAtBefore: string },
): Promise<readonly CanonicalSessionStatisticsRow[]> {
  if (authorizedSessionIds.length === 0) return [];
  if (range !== undefined) {
    const from = Date.parse(range.recordedAtFrom);
    const before = Date.parse(range.recordedAtBefore);
    if (!Number.isFinite(from) || !Number.isFinite(before) || from >= before) {
      throw new Error("session statistics seed range must be a valid increasing timestamp interval");
    }
  }
  const recordedAtFrom = range?.recordedAtFrom ?? null;
  const recordedAtBefore = range?.recordedAtBefore ?? null;
  // The adapter exposes the underlying tag; raw postgres.js tags work directly too.
  const fragment = sql.fragment ?? sql as unknown as EventIngressSqlFragment;
  const scopeCtes = createSessionStatisticsScopeCtes(
    sql, fragment, authorizedSessionIds, recordedAtFrom, recordedAtBefore,
  );
  const usageCtes = createSessionStatisticsUsageCtes(fragment);
  const materialCtes = createSessionStatisticsMaterialCtes(fragment);
  const rows = await sql<readonly CanonicalSqlRow[]>`
    WITH ${scopeCtes},
      ${usageCtes},
      ${materialCtes}
    SELECT * FROM (
      SELECT row_kind, session_id, selection_event_id, input_id, missing_identity, accounting_key,
        owner_event_id, candidate_event_id, candidate_type, representation,
        state, selection_quality, owner_recorded_at, fact
      FROM usage_rows
      UNION ALL
      SELECT row_kind, session_id, selection_event_id, input_id, missing_identity, accounting_key,
        owner_event_id, candidate_event_id, candidate_type, representation,
        state, selection_quality, owner_recorded_at, fact
      FROM material_rows
      UNION ALL
      SELECT row_kind, session_id, selection_event_id, input_id, missing_identity, accounting_key,
        owner_event_id, candidate_event_id, candidate_type, representation,
        state, selection_quality, owner_recorded_at, fact
      FROM supporting_fact_rows
      UNION ALL
      SELECT row_kind, session_id, selection_event_id, input_id, missing_identity, accounting_key,
        owner_event_id, candidate_event_id, candidate_type, representation,
        state, selection_quality, owner_recorded_at, fact
      FROM input_coverage_rows
      UNION ALL
      SELECT row_kind, session_id, selection_event_id, input_id, missing_identity, accounting_key,
        owner_event_id, candidate_event_id, candidate_type, representation,
        state, selection_quality, owner_recorded_at, fact
      FROM unmatched_incomplete_owner_rows
    ) AS canonical_rows
    ORDER BY session_id, row_kind, accounting_key NULLS FIRST,
      coalesce(candidate_event_id, owner_event_id, 0),
      coalesce(fact ->> 'part_key', '')
  `;
  return rows.map(toCanonicalRow);
}
