import {
  USAGE_STATS_PROVIDERS,
  USAGE_STATS_UNKNOWN_PROVIDER_LABEL,
} from "@soulstream/wire-schema/session-statistics";
import type {
  UsageStatsOptions,
  UsageStatsProvider,
} from "@soulstream/wire-schema/session-statistics";
import type { FactDraft } from "./session_statistics_fact_types.js";
import type { SessionStatisticsReadResult } from "./session_statistics_types.js";
import { createSessionStatisticsCoverageIndex } from "./session_statistics_coverage.js";
import type { SessionStatisticsCoverageIndex } from "./session_statistics_coverage.js";
import {
  selectOwnedSessionStatisticsRows,
  sessionStatisticsCompareText,
  sessionStatisticsSourceKey,
} from "./session_statistics_aggregate.js";
import { sourceTokenMetrics } from "./session_statistics_token_metrics.js";

type Row = SessionStatisticsReadResult["rows"][number];
type ModelOption = UsageStatsOptions["models"][number];
type Attribution = Pick<ModelOption, "provider" | "model" | "backend">;

const PROVIDER_LABELS: Record<UsageStatsProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  unknown: USAGE_STATS_UNKNOWN_PROVIDER_LABEL,
};

function attributionFromSnapshot(fact: FactDraft | null): Attribution | null {
  const snapshot = fact?.usage_snapshot;
  if (!snapshot) return null;
  const provider = snapshot.provider;
  const model = snapshot.requested_model;
  const backend = snapshot.backend;
  if (typeof provider !== "string" || !USAGE_STATS_PROVIDERS.includes(provider as UsageStatsProvider)
    || (model !== null && typeof model !== "string") || typeof backend !== "string") return null;
  return { provider: provider as UsageStatsProvider, model: model as string | null, backend };
}

function commandStartAttributions(rows: readonly Row[]): Map<string, Attribution> {
  const attributions = new Map<string, Attribution>();
  for (const row of rows) {
    const fact = row.fact;
    if (!fact || fact.fact_kind !== "boundary" || fact.boundary_type !== "command_started"
      || row.accounting_key === null) continue;
    const attribution = attributionFromSnapshot(fact);
    if (attribution) attributions.set(JSON.stringify([row.session_id, row.accounting_key]), attribution);
  }
  return attributions;
}

function rowAttribution(row: Row, starts: ReadonlyMap<string, Attribution>): Attribution {
  if (row.state === "owned" && row.fact?.fact_kind === "usage") {
    return {
      provider: row.fact.provider,
      model: row.fact.model,
      backend: row.fact.backend ?? "unknown",
    };
  }
  const key = row.accounting_key === null ? null : JSON.stringify([row.session_id, row.accounting_key]);
  return (key === null ? undefined : starts.get(key)) ?? {
    provider: "unknown",
    model: null,
    backend: "unknown",
  };
}

function modelSort(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return sessionStatisticsCompareText(left, right);
}

function projectTotalTokens(read: SessionStatisticsReadResult): Map<string, number> {
  const sessions = new Map(read.sessions.map((session) => [session.sessionId, session.projectId]));
  const totals = new Map<string, number>();
  const seen = new Set<string>();
  for (const row of selectOwnedSessionStatisticsRows(read, { respectQueryFilters: false })) {
    const fact = row.fact!;
    const projectId = sessions.get(row.session_id);
    const total = sourceTokenMetrics(fact).total_tokens;
    if (projectId === undefined || projectId === null || total === null) continue;
    const sourceKey = sessionStatisticsSourceKey(row.session_id, fact.event_id, fact.part_key);
    if (seen.has(sourceKey)) continue;
    seen.add(sourceKey);
    totals.set(projectId, (totals.get(projectId) ?? 0) + total);
  }
  return totals;
}

function compareProvider(left: UsageStatsProvider, right: UsageStatsProvider): number {
  return USAGE_STATS_PROVIDERS.indexOf(left) - USAGE_STATS_PROVIDERS.indexOf(right);
}

export function buildSessionStatisticsOptions(
  read: SessionStatisticsReadResult,
  index: SessionStatisticsCoverageIndex = createSessionStatisticsCoverageIndex(read),
): UsageStatsOptions {
  const starts = commandStartAttributions(read.rows);
  const models = new Map<string, ModelOption>();
  const projectSessions = new Set<string>();
  const periodRows = [
    ...index.owners.flatMap((owner) => [...owner.parts.map((part) => part.row), ...owner.factlessRows]),
    ...index.missing.map((record) => record.row),
    ...index.pending.filter((record) => !index.allMissingIdentityKeys.has(record.identityKey)).map((record) => record.row),
  ];
  for (const row of periodRows) {
    const attribution = rowAttribution(row, starts);
    const key = JSON.stringify([attribution.provider, attribution.model, attribution.backend]);
    models.set(key, {
      ...attribution,
      label: attribution.model ?? "모델 미확인",
    });
    projectSessions.add(row.session_id);
  }

  const sessionById = new Map(read.sessions.map((session) => [session.sessionId, session]));
  const totals = projectTotalTokens(read);
  const projects = [...projectSessions]
    .map((sessionId) => sessionById.get(sessionId))
    .filter((session): session is NonNullable<typeof session> => Boolean(session?.projectId))
    .map((session) => ({
      project_id: session.projectId!,
      label: session.projectLabel,
    }))
    .filter((project, index, all) => all.findIndex((other) => other.project_id === project.project_id) === index)
    .sort((left, right) => (totals.get(right.project_id) ?? 0) - (totals.get(left.project_id) ?? 0)
      || sessionStatisticsCompareText(left.project_id, right.project_id));
  const sortedModels = [...models.values()].sort((left, right) => compareProvider(left.provider, right.provider)
    || modelSort(left.model, right.model)
    || sessionStatisticsCompareText(left.backend, right.backend));
  const modelRosters = USAGE_STATS_PROVIDERS.map((provider) => ({
    provider,
    models: [...new Set(sortedModels.filter((model) => model.provider === provider).map((model) => model.model))]
      .sort(modelSort),
  }));

  return {
    providers: USAGE_STATS_PROVIDERS.map((provider) => ({ provider, label: PROVIDER_LABELS[provider] })),
    models: sortedModels,
    projects,
    project_roster: projects.slice(0, 5).map((project) => project.project_id),
    model_rosters: modelRosters,
  };
}
