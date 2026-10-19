import type {
  UsageStatsDayDetail,
  UsageStatsInputPart,
} from "@soulstream/wire-schema/session-statistics";
import type { SessionStatisticsReadResult } from "./session_statistics_types.js";
import { sessionStatisticsInPeriod } from "./session_statistics_scope.js";
import {
  sessionStatisticsCompareText,
  sessionStatisticsDate,
  sessionStatisticsSourceKey,
} from "./session_statistics_aggregate.js";
import { sessionStatisticsRowsForQuery } from "./session_statistics_coverage.js";

type Row = SessionStatisticsReadResult["rows"][number];
type MaterialResult = Pick<UsageStatsDayDetail, "input_material" | "tool_calls">;

const NON_COMPARABLE_REASONS = new Set([
  "hidden_system_or_schema",
  "replayed_history",
  "multiple_calls_or_carry",
  "missing_source_token_breakdown",
  "material_breakdown_unavailable",
]);

function rowDate(row: Row): string | null {
  return sessionStatisticsDate(row.owner_recorded_at ?? row.fact?.recorded_at ?? null);
}

function sampleId(row: Row): string {
  const fact = row.fact;
  const id = row.accounting_key ?? fact?.accounting_key ?? row.input_id ?? fact?.input_id
    ?? row.owner_event_id ?? row.candidate_event_id ?? row.selection_event_id;
  return JSON.stringify([row.session_id, String(id)]);
}

function hasMaterialForSample(
  sample: Row,
  materialSamples: ReadonlySet<string>,
  materialInputs: ReadonlySet<string>,
): boolean {
  if (materialSamples.has(sampleId(sample))) return true;
  const commandId = sample.accounting_key ?? sample.fact?.accounting_key ?? null;
  if (commandId !== null) return false;
  const inputId = sample.input_id ?? sample.fact?.input_id ?? null;
  return inputId !== null && materialInputs.has(JSON.stringify([sample.session_id, inputId]));
}

function materialSampleCoverage(materialRows: readonly Row[], readRows: readonly Row[], date: string) {
  const sampleTypes = new Map<string, Set<string>>();
  const materialSamples = new Set<string>();
  const materialInputs = new Set<string>();
  for (const row of materialRows) {
    const fact = row.fact!;
    const sample = sampleId(row);
    materialSamples.add(sample);
    if (fact.input_id !== null) materialInputs.add(JSON.stringify([row.session_id, fact.input_id]));
    const types = sampleTypes.get(sample) ?? new Set<string>();
    types.add(fact.source_event_type);
    sampleTypes.set(sample, types);
  }

  const usageSamples = new Map<string, Row>();
  const usageByInput = new Set<string>();
  const inputRows: Row[] = [];
  for (const row of readRows) {
    if (rowDate(row) !== date) continue;
    if (row.row_kind === "usage") {
      usageSamples.set(sampleId(row), row);
      const inputId = row.input_id ?? row.fact?.input_id ?? null;
      if (inputId !== null) usageByInput.add(JSON.stringify([row.session_id, inputId]));
    } else if (row.row_kind === "boundary" && row.fact?.fact_kind === "boundary"
      && row.fact.boundary_type === "input") inputRows.push(row);
  }

  const missingSamples = new Set<string>();
  for (const [sample, row] of usageSamples) {
    if (!hasMaterialForSample(row, materialSamples, materialInputs)) missingSamples.add(sample);
  }
  for (const row of inputRows) {
    const inputId = row.input_id ?? row.fact?.input_id ?? null;
    if (inputId !== null && usageByInput.has(JSON.stringify([row.session_id, inputId]))) continue;
    if (!hasMaterialForSample(row, materialSamples, materialInputs)) missingSamples.add(sampleId(row));
  }

  let manifestOnlySamples = 0;
  let partialSamples = 0;
  for (const types of sampleTypes.values()) {
    if (types.size === 1 && types.has("context_manifest")) manifestOnlySamples += 1;
    else partialSamples += 1;
  }
  return { manifestOnlySamples, partialSamples, missingSamples: missingSamples.size };
}

export function buildSessionStatisticsMaterial(
  read: SessionStatisticsReadResult,
  date: string,
): MaterialResult {
  const filteredRows = sessionStatisticsRowsForQuery(read);
  const ownerDates = new Map<string, string>();
  for (const row of filteredRows) {
    if (row.row_kind !== "usage" || row.state !== "owned" || row.fact?.fact_kind !== "usage"
      || row.accounting_key === null) continue;
    ownerDates.set(JSON.stringify([row.session_id, row.accounting_key]), row.owner_recorded_at ?? row.fact.recorded_at);
  }
  const queryRows = filteredRows.map((row) => {
    if ((row.row_kind !== "input_material" && row.row_kind !== "tool_call") || row.accounting_key === null) return row;
    const ownerDate = ownerDates.get(JSON.stringify([row.session_id, row.accounting_key]));
    return ownerDate === undefined ? row : { ...row, owner_recorded_at: ownerDate };
  }).filter((row) => sessionStatisticsInPeriod(read, row.owner_recorded_at ?? row.fact?.recorded_at ?? null));
  const materialRows: Row[] = [];
  const tools = new Set<string>();
  const sourceKeys = new Set<string>();
  for (const row of queryRows) {
    const fact = row.fact;
    if (!fact || row.state !== "owned" || rowDate(row) !== date) continue;
    if (row.row_kind === "input_material" && fact.fact_kind === "input_material") {
      const sourceKey = sessionStatisticsSourceKey(row.session_id, fact.event_id, fact.part_key);
      if (sourceKeys.has(sourceKey) || fact.category === "harness_internal") continue;
      sourceKeys.add(sourceKey);
      materialRows.push(row);
    } else if (row.row_kind === "tool_call" && fact.fact_kind === "tool_call") {
      tools.add(sessionStatisticsSourceKey(row.session_id, fact.event_id, fact.part_key));
    }
  }

  const grouped = new Map<string, {
    category: string;
    sourceKey: string | null;
    measurement: UsageStatsInputPart["measurement"];
    tokens: number;
    hasTokens: boolean;
  }>();
  for (const row of materialRows) {
    const fact = row.fact!;
    const measurement = fact.approximate_tokens === null ? "unobserved" : "estimate";
    const category = fact.category ?? "unknown";
    const key = JSON.stringify([category, fact.source_key, measurement]);
    const group = grouped.get(key) ?? {
      category,
      sourceKey: fact.source_key,
      measurement,
      tokens: 0,
      hasTokens: false,
    };
    if (fact.approximate_tokens !== null) {
      group.tokens += fact.approximate_tokens;
      group.hasTokens = true;
    }
    grouped.set(key, group);
  }

  const knownTotal = [...grouped.values()].reduce((total, group) => total + group.tokens, 0);
  const hasKnownTotal = [...grouped.values()].some((group) => group.hasTokens);
  const parts: UsageStatsInputPart[] = [...grouped.values()]
    .sort((left, right) => sessionStatisticsCompareText(left.category, right.category)
      || sessionStatisticsCompareText(left.sourceKey ?? "", right.sourceKey ?? "")
      || sessionStatisticsCompareText(left.measurement, right.measurement))
    .map((group) => ({
      category: group.category,
      source_key: group.sourceKey,
      approximate_tokens: group.hasTokens ? group.tokens : null,
      share: hasKnownTotal && knownTotal > 0 && group.hasTokens ? group.tokens / knownTotal : null,
      measurement: group.measurement,
    }));
  parts.push({
    category: "harness_internal",
    source_key: null,
    approximate_tokens: null,
    share: null,
    measurement: "unobserved",
  });

  const calibrationReasons = new Set<string>(["missing_source_token_breakdown"]);
  for (const row of queryRows) {
    if (rowDate(row) !== date || !row.fact) continue;
    for (const quality of row.fact.quality) {
      if (NON_COMPARABLE_REASONS.has(quality)) calibrationReasons.add(quality);
    }
  }
  const counts = materialSampleCoverage(materialRows, queryRows, date);
  return {
    input_material: {
      basis: "observed_input_material",
      unit: "approximate_tokens",
      estimate_method: "utf16_chars_div4_ceil_v1",
      method: "combined_visible",
      observed_approximate_tokens: hasKnownTotal ? knownTotal : null,
      parts,
      calibration: {
        status: "not_comparable",
        sample_count: 0,
        factor: null,
        reasons: [...calibrationReasons].sort(),
      },
      coverage: {
        complete_samples: 0,
        partial_samples: counts.partialSamples,
        manifest_only_samples: counts.manifestOnlySamples,
        missing_samples: counts.missingSamples,
      },
    },
    tool_calls: tools.size,
  };
}
