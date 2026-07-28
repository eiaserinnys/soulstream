import type { NodeConnectionSnapshot } from "../node/registry_types.js";
import type {
  UsageSummaryQuota,
  UsageSummarySnapshot,
} from "../usage/usage_summary_service.js";

export type StaticModelPreset = {
  readonly id: string;
  readonly label: string;
  readonly backend: "claude" | "codex" | "openai-agents";
  readonly available: boolean;
  readonly reason?: "env_unresolved";
  readonly usage_provider: "claude" | "codex" | null;
  readonly usage_model_id?: string;
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
    | null;
  readonly reason_label: string | null;
  readonly resets_at: string | null;
  readonly usage_warning: boolean;
};

export type ModelPresetAvailabilityRegistry = {
  getConnectedNode(nodeId: string): NodeConnectionSnapshot | undefined;
};

export type ModelPresetUsageSummary = {
  getSummary(): UsageSummarySnapshot;
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
    return staticPresets(node).map((preset) =>
      resolvePresetAvailability(nodeId, preset, summary, this.now()),
    );
  }

  resolveForNode(
    nodeId: string,
    presetId: string,
  ): ModelPresetAvailability {
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
    return resolvePresetAvailability(
      nodeId,
      preset,
      this.usageSummary.getSummary(),
      this.now(),
    );
  }

  requireAvailable(nodeId: string, presetId: string): ModelPresetAvailability {
    const availability = this.resolveForNode(nodeId, presetId);
    if (availability.available) return availability;
    throw new ModelPresetAvailabilityError(
      "MODEL_PRESET_UNAVAILABLE",
      `Model preset '${presetId}' is unavailable on node ${nodeId}: ${
        availability.reason_label ?? availability.reason ?? "unavailable"
      }`,
    );
  }
}

export function resolvePresetAvailability(
  nodeId: string,
  preset: StaticModelPreset,
  summary: UsageSummarySnapshot,
  now: Date,
): ModelPresetAvailability {
  const base = publicPreset(preset);
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

  const nodeUsage = summary.nodes.find((node) => node.nodeId === nodeId);
  const provider = nodeUsage?.providers[preset.usage_provider] ?? null;
  if (!nodeUsage || nodeUsage.stale || provider === null) {
    return availablePreset(base, true);
  }
  if (provider.status === "error") {
    return availablePreset(base, true);
  }
  if (provider.status === "not_configured") {
    return {
      ...base,
      available: false,
      reason: "not_authenticated",
      reason_label: "미인증",
      resets_at: null,
      usage_warning: false,
    };
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
    available: false,
    reason: "quota_exhausted",
    reason_label: quotaReasonLabel(exhausted),
    resets_at:
      exhausted.resetAt === null
        ? null
        : new Date(exhausted.resetAt * 1_000).toISOString(),
    usage_warning: false,
  };
}

function publicPreset(
  preset: StaticModelPreset,
): Pick<ModelPresetAvailability, "id" | "label" | "backend"> {
  return {
    id: preset.id,
    label: preset.label,
    backend: preset.backend,
  };
}

function availablePreset(
  preset: Pick<ModelPresetAvailability, "id" | "label" | "backend">,
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
  if (quota.model === null) {
    return `${quota.window === "7d" ? "7일" : quota.window ?? quota.label} 사용량 제한`;
  }
  const scopeLabel = quota.label.includes("7일")
    ? quota.label
    : `${quota.window === "7d" ? "7일" : quota.window ?? "모델"} (${quota.label})`;
  return `${scopeLabel} 사용량 제한`;
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
  return value === "claude" || value === "codex" || value === "openai-agents";
}

function isUsageProvider(
  value: unknown,
): value is StaticModelPreset["usage_provider"] {
  return value === "claude" || value === "codex" || value === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
