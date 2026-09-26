import type {
  NodeCommandResponse,
  PendingNodeCommand,
  RequestResponseNodeCommandPayload,
} from "../node/pending_commands.js";
import type { NodeConnectionSnapshot } from "../node/registry_types.js";
import type { SessionCommandTransportBridge } from "../session/session_command_transport.js";

export const USAGE_SUMMARY_NODE_TIMEOUT_MS = 15_000;

export const USAGE_SUMMARY_PROVIDER_NAMES = ["claude", "codex", "gemini"] as const;

export type UsageSummaryProviderName = (typeof USAGE_SUMMARY_PROVIDER_NAMES)[number];

export type UsageSummarySharedAccountGroup = {
  readonly provider: UsageSummaryProviderName;
  readonly nodeIds: readonly string[];
};

export type UsageSummaryQuota = {
  readonly id: string;
  readonly label: string;
  readonly window: string | null;
  readonly model: string | null;
  readonly remainingPercent: number | null;
  readonly resetAt: number | null;
};

export type UsageSummaryProvider = {
  readonly status: "auto" | "not_configured" | "error";
  readonly weeklyRemainingPercent: number | null;
  readonly weeklyResetAt: number | null;
  readonly shortRemainingPercent: number | null;
  readonly shortResetAt: number | null;
  readonly quotas: readonly UsageSummaryQuota[];
};

export type UsageSummaryNode = {
  readonly nodeId: string;
  readonly fetchedAt: string | null;
  readonly stale: boolean;
  readonly staleSince: string | null;
  readonly providers: Readonly<Record<UsageSummaryProviderName, UsageSummaryProvider | null>>;
};

export type UsageSummarySnapshot = {
  readonly generatedAt: string;
  readonly collectedAt: string | null;
  readonly nodes: readonly UsageSummaryNode[];
};

export type UsageSummaryRegistry = {
  readonly listConnectedNodes: () => readonly NodeConnectionSnapshot[];
  readonly getConnectedNode: (nodeId: string) => NodeConnectionSnapshot | undefined;
  readonly createCommand: <
    TPayload extends RequestResponseNodeCommandPayload,
    TResponse extends NodeCommandResponse = NodeCommandResponse,
  >(
    nodeId: string,
    payload: TPayload,
    options?: { timeoutMs?: number },
  ) => PendingNodeCommand<TPayload, TResponse>;
};

export type UsageSummaryBridge = Pick<SessionCommandTransportBridge, "sendPendingCommand">;

export type UsageSummaryServiceOptions = {
  readonly registry: UsageSummaryRegistry;
  readonly bridge: UsageSummaryBridge;
  readonly pollIntervalMs: number;
  readonly sharedAccountGroups: readonly UsageSummarySharedAccountGroup[];
  readonly nodeTimeoutMs?: number;
  readonly now?: () => Date;
  readonly onWarning?: (message: string, error?: unknown) => void;
};

type ProviderUsageCommandPayload = RequestResponseNodeCommandPayload<"provider_usage_get">;

type ProviderUsageCommandResponse = NodeCommandResponse & {
  readonly success?: unknown;
  readonly data?: unknown;
  readonly error?: unknown;
};

type ProviderUsageSnapshot = {
  readonly providers: Readonly<Record<UsageSummaryProviderName, ProviderLimits>>;
};

type ProviderLimits = {
  readonly status: "auto" | "not_configured" | "error";
  readonly weeklyUsedPercent: number | null;
  readonly weeklyResetAt: number | null;
  readonly shortUsedPercent: number | null;
  readonly shortResetAt: number | null;
  readonly quotas: readonly ProviderQuota[];
};

type ProviderQuota = {
  readonly id: string;
  readonly label: string;
  readonly window: string | null;
  readonly model: string | null;
  readonly remainingPercent: number | null;
  readonly resetAt: number | null;
};

type MutableNodeState = {
  readonly nodeId: string;
  snapshot: ProviderUsageSnapshot | null;
  fetchedAt: string | null;
  staleSince: string | null;
};

export class UsageSummaryService {
  private readonly registry: UsageSummaryRegistry;
  private readonly bridge: UsageSummaryBridge;
  private readonly pollIntervalMs: number;
  private readonly sharedAccountGroups: readonly UsageSummarySharedAccountGroup[];
  private readonly nodeTimeoutMs: number;
  private readonly now: () => Date;
  private readonly onWarning: (message: string, error?: unknown) => void;
  private readonly nodes = new Map<string, MutableNodeState>();
  private collectedAt: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeCollection: Promise<void> | undefined;

  constructor(options: UsageSummaryServiceOptions) {
    assertPositiveInteger(options.pollIntervalMs, "pollIntervalMs");
    const nodeTimeoutMs = options.nodeTimeoutMs ?? USAGE_SUMMARY_NODE_TIMEOUT_MS;
    assertPositiveInteger(nodeTimeoutMs, "nodeTimeoutMs");
    this.registry = options.registry;
    this.bridge = options.bridge;
    this.pollIntervalMs = options.pollIntervalMs;
    this.sharedAccountGroups = options.sharedAccountGroups;
    this.nodeTimeoutMs = nodeTimeoutMs;
    this.now = options.now ?? (() => new Date());
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.collectOnce().catch((error) => {
      this.onWarning("Usage summary collection failed", error);
    });
    this.timer = setInterval(() => {
      void this.collectOnce().catch((error) => {
        this.onWarning("Usage summary collection failed", error);
      });
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.activeCollection;
  }

  async collectOnce(): Promise<void> {
    if (this.activeCollection !== undefined) return this.activeCollection;
    const collection = this.runCollection();
    this.activeCollection = collection;
    try {
      await collection;
    } finally {
      if (this.activeCollection === collection) this.activeCollection = undefined;
    }
  }

  getSummary(): UsageSummarySnapshot {
    return {
      generatedAt: this.now().toISOString(),
      collectedAt: this.collectedAt,
      nodes: [...this.nodes.values()]
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
        .map((state) => summarizeNode(state)),
    };
  }

  private async runCollection(): Promise<void> {
    const cycleStartedAt = this.now().toISOString();
    const connectedNodes = this.registry.listConnectedNodes();
    const connectedIds = new Set(connectedNodes.map((node) => node.nodeId));

    for (const state of this.nodes.values()) {
      if (!connectedIds.has(state.nodeId) && state.staleSince === null) {
        state.staleSince = cycleStartedAt;
      }
    }

    for (const node of connectedNodes) {
      const state = this.nodes.get(node.nodeId) ?? {
        nodeId: node.nodeId,
        snapshot: null,
        fetchedAt: null,
        staleSince: cycleStartedAt,
      };
      this.nodes.set(node.nodeId, state);
    }

    const providerOwners = resolveProviderOwners(
      connectedIds,
      this.sharedAccountGroups,
    );
    const providerRequests = this.createProviderRequests(
      connectedNodes,
      providerOwners,
    );

    await Promise.all(connectedNodes.map(async (node) => {
      const state = this.nodes.get(node.nodeId);
      if (state === undefined) throw new Error(`Missing usage state for node ${node.nodeId}`);
      try {
        const requiredProvider = (provider: UsageSummaryProviderName): Promise<ProviderLimits> => {
          const ownerId = providerOwners.get(providerRequestKey(node.nodeId, provider))
            ?? node.nodeId;
          const request = providerRequests.get(providerRequestKey(ownerId, provider));
          if (request === undefined) {
            throw new Error(`Missing ${provider} usage request for node ${node.nodeId}`);
          }
          return request;
        };
        const [claude, codex, gemini] = await Promise.all([
          requiredProvider("claude"),
          requiredProvider("codex"),
          requiredProvider("gemini"),
        ]);
        const snapshot: ProviderUsageSnapshot = {
          providers: { claude, codex, gemini },
        };
        state.snapshot = snapshot;
        state.fetchedAt = this.now().toISOString();
        state.staleSince = null;
      } catch (error) {
        state.staleSince ??= cycleStartedAt;
        this.onWarning(`Usage summary collection failed for node ${node.nodeId}`, error);
      }
    }));
    this.collectedAt = this.now().toISOString();
  }

  private createProviderRequests(
    connectedNodes: readonly NodeConnectionSnapshot[],
    providerOwners: ReadonlyMap<string, string>,
  ): Map<string, Promise<ProviderLimits>> {
    const requests = new Map<string, Promise<ProviderLimits>>();
    for (const node of connectedNodes) {
      const ownedProviders = USAGE_SUMMARY_PROVIDER_NAMES.filter((provider) =>
        (providerOwners.get(providerRequestKey(node.nodeId, provider)) ?? node.nodeId)
          === node.nodeId,
      );
      if (ownedProviders.length === USAGE_SUMMARY_PROVIDER_NAMES.length) {
        const snapshot = this.fetchNodeSnapshot(node.nodeId);
        for (const provider of USAGE_SUMMARY_PROVIDER_NAMES) {
          requests.set(
            providerRequestKey(node.nodeId, provider),
            snapshot.then((result) => result.providers[provider]),
          );
        }
        continue;
      }
      for (const provider of ownedProviders) {
        requests.set(
          providerRequestKey(node.nodeId, provider),
          this.fetchNodeProvider(node.nodeId, provider),
        );
      }
    }
    return requests;
  }

  private async fetchNodeSnapshot(nodeId: string): Promise<ProviderUsageSnapshot> {
    const response = await this.sendProviderUsageCommand(nodeId);
    return parseProviderUsageSnapshot(response.data);
  }

  private async fetchNodeProvider(
    nodeId: string,
    provider: UsageSummaryProviderName,
  ): Promise<ProviderLimits> {
    const response = await this.sendProviderUsageCommand(nodeId, provider);
    return parseProviderLimits(response.data, provider);
  }

  private async sendProviderUsageCommand(
    nodeId: string,
    provider?: UsageSummaryProviderName,
  ): Promise<ProviderUsageCommandResponse> {
    const node = this.registry.getConnectedNode(nodeId);
    if (node === undefined) throw new Error(`Node is not connected: ${nodeId}`);
    const command = this.registry.createCommand<
      ProviderUsageCommandPayload,
      ProviderUsageCommandResponse
    >(
      nodeId,
      provider === undefined
        ? { type: "provider_usage_get" }
        : { type: "provider_usage_get", provider },
      { timeoutMs: this.nodeTimeoutMs },
    );
    const response = await this.bridge.sendPendingCommand({ node, command });
    if (response.success !== true) {
      throw new Error(stringValue(response.error) || `Provider usage failed for node ${nodeId}`);
    }
    return response;
  }
}

function resolveProviderOwners(
  connectedIds: ReadonlySet<string>,
  groups: readonly UsageSummarySharedAccountGroup[],
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const group of groups) {
    const connectedMembers = group.nodeIds
      .filter((nodeId) => connectedIds.has(nodeId))
      .sort((left, right) => left.localeCompare(right));
    const representative = connectedMembers[0];
    if (representative === undefined) continue;
    for (const nodeId of connectedMembers) {
      owners.set(providerRequestKey(nodeId, group.provider), representative);
    }
  }
  return owners;
}

function providerRequestKey(nodeId: string, provider: UsageSummaryProviderName): string {
  return `${nodeId}\u0000${provider}`;
}

function summarizeNode(state: MutableNodeState): UsageSummaryNode {
  return {
    nodeId: state.nodeId,
    fetchedAt: state.fetchedAt,
    stale: state.staleSince !== null,
    staleSince: state.staleSince,
    providers: state.snapshot === null
      ? { claude: null, codex: null, gemini: null }
      : {
          claude: summarizeProvider(state.snapshot.providers.claude),
          codex: summarizeProvider(state.snapshot.providers.codex),
          gemini: summarizeProvider(state.snapshot.providers.gemini),
        },
  };
}

function summarizeProvider(limits: ProviderLimits): UsageSummaryProvider {
  return {
    status: limits.status,
    weeklyRemainingPercent: remainingPercent(limits.weeklyUsedPercent),
    weeklyResetAt: limits.weeklyResetAt,
    shortRemainingPercent: remainingPercent(limits.shortUsedPercent),
    shortResetAt: limits.shortResetAt,
    quotas: limits.quotas.map((quota) => ({ ...quota })),
  };
}

function remainingPercent(usedPercent: number | null): number | null {
  if (usedPercent === null) return null;
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

function parseProviderUsageSnapshot(value: unknown): ProviderUsageSnapshot {
  const record = requiredRecord(value, "provider usage snapshot");
  const providers = requiredRecord(record.providers, "provider usage providers");
  return {
    providers: {
      claude: parseProviderLimits(providers.claude, "claude"),
      codex: parseProviderLimits(providers.codex, "codex"),
      gemini: parseProviderLimits(providers.gemini, "gemini"),
    },
  };
}

function parseProviderLimits(value: unknown, provider: string): ProviderLimits {
  const record = requiredRecord(value, `${provider} limits`);
  const status = record.status;
  if (status !== "auto" && status !== "not_configured" && status !== "error") {
    throw new Error(`${provider} limits status is invalid`);
  }
  if (!Array.isArray(record.quotas)) throw new Error(`${provider} limits quotas must be an array`);
  return {
    status,
    weeklyUsedPercent: nullableNumber(record.weeklyUsedPercent, `${provider}.weeklyUsedPercent`),
    weeklyResetAt: nullableNumber(record.weeklyResetAt, `${provider}.weeklyResetAt`),
    shortUsedPercent: nullableNumber(record.shortUsedPercent, `${provider}.shortUsedPercent`),
    shortResetAt: nullableNumber(record.shortResetAt, `${provider}.shortResetAt`),
    quotas: record.quotas.map((quota, index) => parseQuota(quota, provider, index)),
  };
}

function parseQuota(value: unknown, provider: string, index: number): ProviderQuota {
  const record = requiredRecord(value, `${provider}.quotas[${index}]`);
  return {
    id: requiredString(record.id, `${provider}.quotas[${index}].id`),
    label: requiredString(record.label, `${provider}.quotas[${index}].label`),
    window: nullableString(record.window, `${provider}.quotas[${index}].window`),
    model: nullableString(record.model, `${provider}.quotas[${index}].model`),
    remainingPercent: nullableNumber(
      record.remainingPercent,
      `${provider}.quotas[${index}].remainingPercent`,
    ),
    resetAt: nullableNumber(record.resetAt, `${provider}.quotas[${index}].resetAt`),
  };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a string`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string or null`);
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number or null`);
  }
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}
