import type { NodeConnectionSnapshot } from "../node/registry_types.js";
import {
  MODEL_BACKENDS,
  type AgentBackend,
} from "@soulstream/model-catalog";
import type {
  UsageSummaryQuota,
  UsageSummarySnapshot,
} from "../usage/usage_summary_service.js";
import type { UsageSummaryClaudeAccount } from "../usage/provider_usage_wire.js";
import {
  rejectionReasonLabel,
  resolveClaudePoolAvailability,
  type PoolAccountRejection,
} from "./claude_account_pool_availability.js";
import type { ClaudePoolAvailabilityAccount } from "../usage/claude_account_pool_observation.js";
import type {
  ProviderLimitProvider,
  ProviderLimitRejection,
} from "../usage/provider_limit_rejection.js";
import { supportsClaudeAccountPool } from "../node/registry_helpers.js";
import {
  resolveWeeklyHeadroom,
  type WeeklyHeadroom,
} from "../usage/weekly_headroom.js";

const WEEKLY_HEADROOM_FLOOR_PERCENT = 1; // Matches soul-server-ts PR #1624 generation_weekly_floor.

export type StaticModelPreset = {
  readonly id: string;
  readonly label: string;
  readonly backend: AgentBackend;
  readonly available: boolean;
  readonly reason?: "env_unresolved";
  readonly usage_provider: "claude" | "codex" | "antigravity" | null;
  readonly usage_model_id?: string;
  /** Effort levels the node advertised for this preset. Absent = no effort control. */
  readonly supported_efforts?: readonly string[];
  /** Default effort the node advertised. Absent = backend default. */
  readonly default_effort?: string;
};

export type ModelPresetAvailability = {
  readonly id: string;
  readonly label: string;
  readonly backend: StaticModelPreset["backend"];
  readonly available: boolean;
  readonly reason:
    | "env_unresolved"
    | "not_authenticated"
    | "quota_exhausted"
    | "limit_rejected"
    | null;
  readonly reason_label: string | null;
  readonly resets_at: string | null;
  readonly usage_warning: boolean;
  readonly weekly_headroom: WeeklyHeadroom | null;
  /**
   * Canonical list of selectable efforts for this preset. Clients render choices
   * from this and nothing else — no per-frontend hardcoded table.
   */
  readonly supported_efforts?: readonly string[];
  readonly default_effort?: string;
};

export type ModelPresetAvailabilityRegistry = {
  getConnectedNode(nodeId: string): NodeConnectionSnapshot | undefined;
};

export type ModelPresetUsageSummary = {
  getSummary(): UsageSummarySnapshot;
  getLimitRejection(
    nodeId: string,
    provider: ProviderLimitProvider,
    accountId?: string,
    scope?: "all" | "fable",
  ): ProviderLimitRejection | null;
  getClaudePoolAccountsForAvailability(
    nodeId: string,
    accounts: readonly UsageSummaryClaudeAccount[],
  ): readonly ClaudePoolAvailabilityAccount[];
};

export class ModelPresetAvailabilityError extends Error {
  readonly statusCode = 400;
  readonly code:
    | "MODEL_PRESET_NOT_FOUND"
    | "MODEL_PRESET_UNAVAILABLE";

  constructor(
    code: ModelPresetAvailabilityError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ModelPresetAvailabilityError";
    this.code = code;
  }
}

export class ModelPresetAvailabilityService {
  constructor(
    private readonly registry: ModelPresetAvailabilityRegistry,
    private readonly usageSummary: ModelPresetUsageSummary,
    private readonly now: () => Date = () => new Date(),
  ) {}

  listForNode(nodeId: string): ModelPresetAvailability[] | undefined {
    const node = this.registry.getConnectedNode(nodeId);
    if (!node) return undefined;
    const summary = this.usageSummary.getSummary();
    return staticPresets(node).map((preset) => this.resolveAvailability(nodeId, preset, summary));
  }

  /** Validated node advertisement, independent of permissive manual usage fallback. */
  resolveStaticForNode(nodeId: string, presetId: string): StaticModelPreset {
    const node = this.registry.getConnectedNode(nodeId);
    const preset = node
      ? staticPresets(node).find((candidate) => candidate.id === presetId)
      : undefined;
    if (!preset) {
      throw new ModelPresetAvailabilityError(
        "MODEL_PRESET_NOT_FOUND",
        `Model preset '${presetId}' is not advertised by node ${nodeId}`,
      );
    }
    return preset;
  }

  resolveForNode(
    nodeId: string,
    presetId: string,
  ): ModelPresetAvailability {
    const preset = this.resolveStaticForNode(nodeId, presetId);
    return this.resolveAvailability(nodeId, preset, this.usageSummary.getSummary());
  }

  chooseUsablePreset(nodeId: string, candidateIds: readonly string[]): string {
    const candidates = [...new Set(candidateIds)];
    const firstCandidate = candidates[0]!;

    const advertised = new Map(
      (this.listForNode(nodeId) ?? []).map((preset) => [preset.id, preset]),
    );
    const ordered = candidates.flatMap((id) => {
      const preset = advertised.get(id);
      return preset === undefined ? [] : [preset];
    });
    const withHeadroom = ordered.find((preset) =>
      preset.available
      && (preset.weekly_headroom?.remaining_percent == null
        || preset.weekly_headroom.remaining_percent >= WEEKLY_HEADROOM_FLOOR_PERCENT),
    );
    if (withHeadroom) return withHeadroom.id;
    return ordered.find((preset) => preset.available)?.id ?? firstCandidate;
  }

  private resolveAvailability(
    nodeId: string,
    preset: StaticModelPreset,
    summary: UsageSummarySnapshot,
  ): ModelPresetAvailability {
    const provider = preset.usage_provider;
    const node = this.registry.getConnectedNode(nodeId);
    const supportsPool = supportsClaudeAccountPool(node?.capabilities);
    const nodeUsage = summary.nodes.find((node) => node.nodeId === nodeId);
    const providerUsage = provider === null ? null : nodeUsage?.providers[provider] ?? null;
    if (provider === "claude" && supportsPool && providerUsage?.mode === "pool") {
      const accounts = this.usageSummary.getClaudePoolAccountsForAvailability(
        nodeId,
        providerUsage.accounts ?? [],
      );
      const scopes: readonly ("all" | "fable")[] = isFablePreset(preset)
        ? ["all", "fable"]
        : ["all"];
      const poolRejections = accounts.flatMap((account) => [
        ...(account.peer_blocks ?? []).map((block) => ({
          accountId: account.id,
          scope: block.scope,
          rejection: { rejectedUntil: block.until, rateLimitType: null },
        })),
        ...scopes.flatMap((scope) => {
          const rejection = this.usageSummary.getLimitRejection(nodeId, "claude", account.id, scope);
          return rejection === null ? [] : [{ accountId: account.id, scope, rejection }];
        }),
      ]);
      return resolvePresetAvailability(
        nodeId,
        preset,
        summary,
        this.now(),
        null,
        poolRejections,
        accounts,
        supportsPool,
      );
    }
    return resolvePresetAvailability(
      nodeId,
      preset,
      summary,
      this.now(),
      provider === null ? null : this.usageSummary.getLimitRejection(nodeId, provider),
      [],
      undefined,
      supportsPool,
    );
  }

  requireAvailable(
    nodeId: string,
    presetId: string,
    options?: { allowLimitRejected?: boolean },
  ): ModelPresetAvailability {
    const availability = this.resolveForNode(nodeId, presetId);
    if (availability.available || (
      options?.allowLimitRejected === true && availability.reason === "limit_rejected"
    )) return availability;
    const message = availability.reason === "limit_rejected"
      ? `Model preset '${presetId}' is unavailable on node ${nodeId}: ${availability.reason_label} (resets_at: ${availability.resets_at})`
      : `Model preset '${presetId}' is unavailable on node ${nodeId}: ${
          availability.reason_label ?? availability.reason ?? "unavailable"
        }`;
    throw new ModelPresetAvailabilityError(
      "MODEL_PRESET_UNAVAILABLE",
      message,
    );
  }
}

export function resolvePresetAvailability(
  nodeId: string,
  preset: StaticModelPreset,
  summary: UsageSummarySnapshot,
  now: Date,
  rejection: ProviderLimitRejection | null = null,
  poolRejections: readonly PoolAccountRejection[] = [],
  poolAccounts?: readonly UsageSummaryClaudeAccount[],
  useClaudePool = true,
): ModelPresetAvailability {
  const nodeUsage = summary.nodes.find((node) => node.nodeId === nodeId);
  const provider = preset.usage_provider === null
    ? null
    : nodeUsage?.providers[preset.usage_provider] ?? null;
  const weeklyHeadroom = preset.usage_provider === null
    ? null
    : resolveWeeklyHeadroom(
        provider,
        provider?.quotas.filter((quota) =>
          normalizedQuotaWindow(quota.window) === "7일"
          && isQuotaApplicable(preset, quota),
        ) ?? [],
        nodeUsage?.stale ?? false,
        now,
      );
  const base = { ...publicPreset(preset), weekly_headroom: weeklyHeadroom };
  if (!preset.available || preset.reason === "env_unresolved") {
    return {
      ...base,
      available: false,
      reason: "env_unresolved",
      reason_label: "키 미설정",
      resets_at: null,
      usage_warning: false,
    };
  }
  if (preset.usage_provider === null) return availablePreset(base, false);

  if (preset.usage_provider === "claude" && useClaudePool && provider?.mode === "pool") {
    return resolveClaudePoolAvailability(
      base,
      isFablePreset(preset),
      nodeUsage === undefined || nodeUsage.stale,
      poolAccounts ?? provider.accounts ?? [],
      isFablePreset(preset) ? provider.fable_pool : provider.pool,
      poolRejections,
      now,
    );
  }

  const freshProvider = nodeUsage !== undefined && !nodeUsage.stale
    ? provider
    : null;
  if (freshProvider?.status === "not_configured") {
    return {
      ...base,
      available: false,
      reason: "not_authenticated",
      reason_label: "미인증",
      resets_at: null,
      usage_warning: false,
    };
  }

  if (
    rejection !== null
    && rejection.rejectedUntil !== null
    && Date.parse(rejection.rejectedUntil) > now.getTime()
  ) {
    return {
      ...base,
      available: false,
      reason: "limit_rejected",
      reason_label: rejectionReasonLabel(rejection.rateLimitType),
      resets_at: rejection.rejectedUntil,
      usage_warning: false,
    };
  }

  if (!nodeUsage || nodeUsage.stale || provider === null) {
    return availablePreset(base, true);
  }
  if (provider.status === "error") {
    return availablePreset(base, true);
  }

  const nowEpochSeconds = now.getTime() / 1_000;
  const exhausted = provider.quotas.find((quota) =>
    quota.remainingPercent !== null
    && quota.remainingPercent <= 0
    && isQuotaApplicable(preset, quota)
    && !(quota.resetAt !== null && quota.resetAt < nowEpochSeconds),
  );
  if (!exhausted) return availablePreset(base, false);
  return {
    ...base,
    // Exhausted subscription quota is display information; paid credits may still run.
    available: true,
    reason: "quota_exhausted",
    reason_label: quotaReasonLabel(exhausted),
    resets_at:
      exhausted.resetAt === null
        ? null
        : new Date(exhausted.resetAt * 1_000).toISOString(),
    usage_warning: false,
  };
}

function isFablePreset(preset: StaticModelPreset): boolean {
  return [preset.usage_model_id, preset.id, preset.label]
    .some((value) => typeof value === "string" && normalizeModelIdentity(value).includes("fable"));
}

function publicPreset(
  preset: StaticModelPreset,
): Pick<
  ModelPresetAvailability,
  "id" | "label" | "backend" | "supported_efforts" | "default_effort"
> {
  return {
    id: preset.id,
    label: preset.label,
    backend: preset.backend,
    ...(preset.supported_efforts
      ? { supported_efforts: preset.supported_efforts }
      : {}),
    ...(preset.default_effort ? { default_effort: preset.default_effort } : {}),
  };
}

function isEffortList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function availablePreset(
  preset: Pick<
    ModelPresetAvailability,
    | "id"
    | "label"
    | "backend"
    | "supported_efforts"
    | "default_effort"
    | "weekly_headroom"
  >,
  usageWarning: boolean,
): ModelPresetAvailability {
  return {
    ...preset,
    available: true,
    reason: null,
    reason_label: null,
    resets_at: null,
    usage_warning: usageWarning,
  };
}

function staticPresets(node: NodeConnectionSnapshot): StaticModelPreset[] {
  return (node.modelPresets ?? []).flatMap((value) => {
    const parsed = parseStaticPreset(value);
    return parsed ? [parsed] : [];
  });
}

function parseStaticPreset(value: unknown): StaticModelPreset | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string"
    || typeof value.label !== "string"
    || !isBackend(value.backend)
    || typeof value.available !== "boolean"
    || !isUsageProvider(value.usage_provider)
  ) {
    return undefined;
  }
  if (
    value.reason !== undefined
    && value.reason !== "env_unresolved"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    label: value.label,
    ...(isEffortList(value.supported_efforts)
      ? { supported_efforts: value.supported_efforts }
      : {}),
    ...(typeof value.default_effort === "string"
      ? { default_effort: value.default_effort }
      : {}),
    backend: value.backend,
    available: value.available,
    ...(value.reason === "env_unresolved" ? { reason: value.reason } : {}),
    usage_provider: value.usage_provider,
    ...(typeof value.usage_model_id === "string"
      ? { usage_model_id: value.usage_model_id }
      : {}),
  };
}

function isQuotaApplicable(
  preset: StaticModelPreset,
  quota: UsageSummaryQuota,
): boolean {
  if (quota.model === null) return true;
  if (!preset.usage_model_id) return false;
  return modelIdentityMatches(
    normalizeModelIdentity(preset.usage_model_id),
    normalizeModelIdentity(quota.model),
  );
}

function quotaReasonLabel(quota: UsageSummaryQuota): string {
  const label = quota.label.trim() || quota.window || "모델";
  const windowLabel = normalizedQuotaWindow(quota.window);
  if (windowLabel && !hasWindowLabel(label)) {
    return `${windowLabel} (${label}) 사용량 제한`;
  }
  return `${label} 사용량 제한`;
}

function normalizedQuotaWindow(window: string | null): string | null {
  switch (window?.trim().toLowerCase()) {
    case "5h":
      return "5시간";
    case "7d":
    case "168h":
      return "7일";
    default:
      return null;
  }
}

function hasWindowLabel(label: string): boolean {
  return label.includes("5시간") || label.includes("7일");
}

function normalizeModelIdentity(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/\[[^\]]+\]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function modelIdentityMatches(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}-`) || right.startsWith(`${left}-`);
}

function isBackend(
  value: unknown,
): value is StaticModelPreset["backend"] {
  return typeof value === "string"
    && (MODEL_BACKENDS as readonly string[]).includes(value);
}

function isUsageProvider(
  value: unknown,
): value is StaticModelPreset["usage_provider"] {
  return value === "claude" || value === "codex" || value === "antigravity" || value === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
