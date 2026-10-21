import type {
  EventIdentity,
  FactDraft,
  SessionStatisticsEventInput,
  UsageSnapshot,
} from "./session_statistics_fact_types.js";
import type { UsageStatsProvider } from "@soulstream/wire-schema/session-statistics";

const PROVIDERS = new Set<UsageStatsProvider>([
  "claude", "codex", "antigravity", "deepseek", "kimi", "unknown",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function addIssue(issues: Set<string>, code: string): void {
  issues.add(code);
}

export function knownInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function readNumeric(
  record: Record<string, unknown>,
  keys: readonly string[],
  issues: Set<string>,
): number | null {
  const present = keys.filter((key) => hasOwn(record, key));
  if (present.length === 0) return null;
  const values = present.map((key) => knownInteger(record[key]));
  if (values.some((value) => value === null)
    || values.some((value) => value !== values[0])) {
    addIssue(issues, "normalization_error");
    return null;
  }
  return values[0] ?? null;
}

export function numericFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  issues: Set<string>,
): Record<string, number | null> {
  const output: Record<string, number | null> = {};
  for (const field of fields) {
    if (!hasOwn(record, field)) continue;
    const value = knownInteger(record[field]);
    if (value === null) addIssue(issues, "normalization_error");
    output[field] = value;
  }
  return output;
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function inferProvider(model: string | null, usage: unknown): UsageStatsProvider {
  const value = model?.toLowerCase() ?? "";
  if (value === "kimi-for-coding" || value === "k3" || value.startsWith("kimi-")) return "kimi";
  if (value.startsWith("claude-")) return "claude";
  if (value.startsWith("gpt-")) return "codex";
  if (value.startsWith("gemini-")) return "antigravity";
  if (value.startsWith("deepseek-") || value.startsWith("opencode/deepseek-")) return "deepseek";
  if (isRecord(usage) && isRecord(usage.model_usage)) return "claude";
  return "unknown";
}

export function parseIdentity(
  payload: Record<string, unknown> | null,
  eventType: string,
  issues: Set<string>,
): EventIdentity {
  const quality = new Set<string>();
  const outputCommandId = payload ? payload.output_command_id : undefined;
  let accountingKey: string | null = null;
  if (typeof outputCommandId === "string" && outputCommandId.length > 0) {
    accountingKey = outputCommandId;
  } else if (outputCommandId !== undefined && outputCommandId !== null) {
    quality.add("identity_conflict");
    addIssue(issues, "identity_conflict");
  }

  const rawInputId = payload?.input_id;
  const inputId = typeof rawInputId === "string" && rawInputId.length > 0
    ? rawInputId
    : null;
  if (rawInputId !== undefined && rawInputId !== null && inputId === null) {
    quality.add("normalization_error");
    addIssue(issues, "normalization_error");
  }

  if (eventType === "usage_observation") {
    if (accountingKey === null || payload?.accounting_key !== accountingKey) {
      quality.add("identity_conflict");
      addIssue(issues, "identity_conflict");
    }
  }
  if (eventType === "input_material_manifest") {
    const executionInput = isRecord(payload?.execution_input) ? payload.execution_input : null;
    if (accountingKey === null || executionInput?.command_id !== accountingKey) {
      quality.add("identity_conflict");
      addIssue(issues, "identity_conflict");
    }
  }

  const rawModel = stringOrNull(payload?.model);
  if (payload && payload.model !== undefined && payload.model !== null && rawModel === null) {
    quality.add("normalization_error");
    addIssue(issues, "normalization_error");
  }
  const rawSnapshot = payload?.usage_snapshot;
  let snapshot: UsageSnapshot | null = null;
  if (rawSnapshot !== undefined && rawSnapshot !== null) {
    const provider = isRecord(rawSnapshot) ? rawSnapshot.provider : null;
    const backend = isRecord(rawSnapshot) ? rawSnapshot.backend : null;
    const attribution = isRecord(rawSnapshot) ? rawSnapshot.provider_attribution : null;
    const valid = isRecord(rawSnapshot)
      && rawSnapshot.schema_version === 1
      && typeof backend === "string"
      && typeof provider === "string"
      && PROVIDERS.has(provider as UsageStatsProvider)
      && (rawSnapshot.preset_id === null || typeof rawSnapshot.preset_id === "string")
      && (rawSnapshot.requested_model === null || typeof rawSnapshot.requested_model === "string")
      && (attribution === "configured_alias" || attribution === "unknown");
    if (valid) {
      snapshot = {
        schema_version: 1,
        backend: backend as string,
        provider: provider as UsageStatsProvider,
        preset_id: rawSnapshot.preset_id as string | null,
        requested_model: rawSnapshot.requested_model as string | null,
        provider_attribution: attribution as "configured_alias" | "unknown",
      };
    } else {
      quality.add("normalization_error");
      addIssue(issues, "normalization_error");
    }
  }
  // An unknown snapshot only says the runner could not map its requested alias (e.g. "opus");
  // the observed model in the event is still evidence for the provider.
  const provider = snapshot !== null && snapshot.provider !== "unknown"
    ? snapshot.provider
    : inferProvider(rawModel, payload?.usage);
  const backend = snapshot?.backend ?? stringOrNull(payload?.backend);
  const model = rawModel;
  return {
    accountingKey,
    inputId,
    provider,
    backend,
    model,
    snapshot,
    quality: [...quality].sort(compareText),
  };
}

export function blankFact(
  event: SessionStatisticsEventInput,
  identity: EventIdentity,
  partKey: string,
  factKind: FactDraft["fact_kind"],
  quality: readonly string[] = [],
): FactDraft {
  return {
    session_id: event.sessionId,
    event_id: event.eventId,
    part_key: partKey,
    fact_kind: factKind,
    recorded_at: event.createdAt,
    source_event_type: event.eventType,
    normalization_version: 1,
    accounting_key: identity.accountingKey,
    input_id: identity.inputId,
    candidate_type: null,
    provider: identity.provider,
    backend: identity.backend,
    model: identity.model,
    usage_snapshot: identity.snapshot,
    quality: [...new Set([...identity.quality, ...quality])].sort(compareText),
    representation: null,
    input_total: null,
    output_total: null,
    total_tokens: null,
    cache_read: null,
    cache_write: null,
    reasoning_output: null,
    known_cost_usd: null,
    priced_tokens: null,
    unpriced_tokens: null,
    pricing_complete: null,
    pricing_version: null,
    raw_numeric: null,
    category: null,
    source_key: null,
    estimate_source: null,
    raw_chars_utf16: null,
    approximate_tokens: null,
    boundary_type: null,
  };
}
