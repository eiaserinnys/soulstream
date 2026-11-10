import type {
  NodeCommandResponse,
  PendingNodeCommand,
  RequestResponseNodeCommandPayload,
} from "../node/pending_commands.js";
import type { NodeConnectionSnapshot } from "../node/registry_types.js";
import type { SessionCommandTransportBridge } from "../session/session_command_transport.js";
import { supportsClaudeAccountPool } from "../node/registry_helpers.js";
import {
  getProviderLimitRejection,
  observeProviderExecution,
  type ProviderExecutionEvent,
  type ProviderLimitProvider,
  type ProviderLimitRejection,
} from "./provider_limit_rejection.js";
import {
  NOT_CONFIGURED_PROVIDER_LIMITS,
  parseProviderLimits,
  parseProviderUsageSnapshot,
  type ProviderLimits,
  type ProviderUsageSnapshot,
  type UsageSummaryClaudeAccount,
  type UsageSummaryClaudeAccountPool,
} from "./provider_usage_wire.js";
import {
  mergeClaudePoolObservations,
  type ClaudePoolAvailabilityAccount,
} from "./claude_account_pool_observation.js";
import { providerRequestKey, resolveProviderOwners } from "./usage_summary_account_groups.js";

export const USAGE_SUMMARY_NODE_TIMEOUT_MS = 15_000;

export const USAGE_SUMMARY_PROVIDER_NAMES = ["claude", "codex", "antigravity", "opencode_go"] as const;

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
  readonly source?: string | null;
  readonly purpose?: "execution" | "code_review" | "other";
};

export type UsageSummaryProvider = {
  readonly status: "auto" | "not_configured" | "error";
  readonly mode?: "legacy" | "pool";
  readonly accounts?: readonly UsageSummaryClaudeAccount[];
  readonly pool?: UsageSummaryClaudeAccountPool | null;
  readonly fable_pool?: UsageSummaryClaudeAccountPool | null;
  readonly source?: string | null;
  readonly sourceKind?: "remote" | "rollout" | "unknown";
  readonly observedAt?: string | null;
  readonly weeklyRemainingPercent: number | null;
  readonly weeklyResetAt: number | null;
  readonly shortRemainingPercent: number | null;
  readonly shortResetAt: number | null;
  readonly quotas: readonly UsageSummaryQuota[];
  readonly stale: boolean;
  readonly fetchedAt: string | null;
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
  /**
   * How long a provider's last successful sample stays fresh. Defaults to
   * two missed polls plus the command timeout, so one failed cycle is forgiven.
   */
  readonly staleAfterMs?: number;
  readonly now?: () => Date;
  readonly onWarning?: (message: string, error?: unknown) => void;
  /** Called after collection is committed; reuse this poller to wake policy admission. */
  readonly onCollected?: (snapshot: UsageSummarySnapshot) => void;
};

type ProviderUsageCommandPayload = RequestResponseNodeCommandPayload<"provider_usage_get">;

type ProviderUsageCommandResponse = NodeCommandResponse & {
  readonly success?: unknown;
  readonly data?: unknown;
  readonly error?: unknown;
};

type MutableNodeState = {
  readonly nodeId: string;
  readonly firstSeenAt: string;
  snapshot: ProviderUsageSnapshot | null;
  providerFetchedAt: Partial<Record<UsageSummaryProviderName, string>>;
  disconnectedSince: string | null;
};

export class UsageSummaryService {
  private readonly registry: UsageSummaryRegistry;
  private readonly bridge: UsageSummaryBridge;
  private readonly pollIntervalMs: number;
  private readonly sharedAccountGroups: readonly UsageSummarySharedAccountGroup[];
  private readonly nodeTimeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly now: () => Date;
  private readonly onCollected: UsageSummaryServiceOptions["onCollected"];
  private readonly onWarning: (message: string, error?: unknown) => void;
  private readonly nodes = new Map<string, MutableNodeState>();
  private readonly providerLimitRejections = new Map<string, ProviderLimitRejection>();
  private readonly snapshotListeners = new Set<(snapshot: UsageSummarySnapshot) => void>();
  private collectedAt: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeCollection: Promise<void> | undefined;

  constructor(options: UsageSummaryServiceOptions) {
    assertPositiveInteger(options.pollIntervalMs, "pollIntervalMs");
    const nodeTimeoutMs = options.nodeTimeoutMs ?? USAGE_SUMMARY_NODE_TIMEOUT_MS;
    assertPositiveInteger(nodeTimeoutMs, "nodeTimeoutMs");
    const staleAfterMs = options.staleAfterMs ?? (2 * options.pollIntervalMs + nodeTimeoutMs);
    assertPositiveInteger(staleAfterMs, "staleAfterMs");
    this.registry = options.registry;
    this.bridge = options.bridge;
    this.pollIntervalMs = options.pollIntervalMs;
    this.sharedAccountGroups = options.sharedAccountGroups;
    this.nodeTimeoutMs = nodeTimeoutMs;
    this.staleAfterMs = staleAfterMs;
    this.now = options.now ?? (() => new Date());
    this.onCollected = options.onCollected;
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
        .map((state) => this.summarizeNode(state)),
    };
  }

  subscribe(listener: (snapshot: UsageSummarySnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  async refreshNode(nodeId: string): Promise<UsageSummarySnapshot> {
    const now = this.now().toISOString();
    const state = this.nodes.get(nodeId) ?? {
      nodeId,
      firstSeenAt: now,
      snapshot: null,
      providerFetchedAt: {},
      disconnectedSince: null,
    };
    this.nodes.set(nodeId, state);
    try {
      if (this.activeCollection !== undefined) await this.activeCollection;
      const node = this.registry.getConnectedNode(nodeId);
      if (node === undefined) {
        state.disconnectedSince ??= this.now().toISOString();
        throw new Error(`Node is not connected: ${nodeId}`);
      }

      const previous = state.snapshot;
      let snapshot: ProviderUsageSnapshot;
      let fetchedAt: string;
      if (previous === null) {
        snapshot = await this.fetchNodeSnapshot(nodeId);
        fetchedAt = this.now().toISOString();
        for (const provider of USAGE_SUMMARY_PROVIDER_NAMES) {
          if (snapshot.providers[provider].status !== "error") {
            state.providerFetchedAt[provider] = fetchedAt;
          }
        }
      } else {
        const claude = await this.fetchNodeProvider(nodeId, "claude");
        fetchedAt = this.now().toISOString();
        // A provider-level error is a failed sample: keep the previous value
        // and its fetchedAt so a manual refresh does not raise the warning.
        const keepPreviousClaude = claude.status === "error";
        snapshot = {
          providers: {
            ...previous.providers,
            claude: keepPreviousClaude ? previous.providers.claude : claude,
          },
        };
        if (!keepPreviousClaude) state.providerFetchedAt.claude = fetchedAt;
      }
      state.snapshot = snapshot;
      state.disconnectedSince = null;
      this.collectedAt = fetchedAt;
      this.notifyCollected();
      return this.getSummary();
    } catch (error) {
      this.collectedAt = this.now().toISOString();
      this.notifyCollected();
      throw error;
    }
  }

  observeProviderExecution(input: ProviderExecutionEvent): void {
    observeProviderExecution({
      memory: this.providerLimitRejections,
      sharedAccountGroups: this.sharedAccountGroups,
      event: input,
      now: this.now(),
      poolNode: supportsClaudeAccountPool(
        this.registry.getConnectedNode(input.nodeId)?.capabilities,
      ),
    });
  }

  getLimitRejection(
    nodeId: string,
    provider: ProviderLimitProvider,
    accountId?: string,
    scope?: "all" | "fable",
  ): ProviderLimitRejection | null {
    return getProviderLimitRejection({
      memory: this.providerLimitRejections,
      sharedAccountGroups: this.sharedAccountGroups,
      nodeId,
      provider,
      accountId,
      scope,
      poolNode: supportsClaudeAccountPool(
        this.registry.getConnectedNode(nodeId)?.capabilities,
      ),
      now: this.now(),
    });
  }

  getClaudePoolAccountsForAvailability(
    nodeId: string,
    accounts: readonly UsageSummaryClaudeAccount[],
  ): readonly ClaudePoolAvailabilityAccount[] {
    if (!supportsClaudeAccountPool(this.registry.getConnectedNode(nodeId)?.capabilities)) return accounts;
    const group = this.sharedAccountGroups.find((candidate) =>
      candidate.provider === "claude" && candidate.nodeIds.includes(nodeId));
    if (group === undefined) return accounts;

    const peerAccounts = group.nodeIds.flatMap((memberNodeId) => {
      if (memberNodeId === nodeId) return [];
      const member = this.registry.getConnectedNode(memberNodeId);
      if (!supportsClaudeAccountPool(member?.capabilities)) return [];
      const provider = this.nodes.get(memberNodeId)?.snapshot?.providers.claude;
      return provider?.mode === "pool" && provider.accounts !== undefined
        ? [provider.accounts]
        : [];
    });
    return mergeClaudePoolObservations(accounts, peerAccounts);
  }

  private async runCollection(): Promise<void> {
    const cycleStartedAt = this.now().toISOString();
    const connectedNodes = this.registry.listConnectedNodes();
    const connectedIds = new Set(connectedNodes.map((node) => node.nodeId));

    for (const state of this.nodes.values()) {
      if (!connectedIds.has(state.nodeId)) {
        state.disconnectedSince ??= cycleStartedAt;
      }
    }

    for (const node of connectedNodes) {
      const state = this.nodes.get(node.nodeId) ?? {
        nodeId: node.nodeId,
        firstSeenAt: cycleStartedAt,
        snapshot: null,
        providerFetchedAt: {},
        disconnectedSince: null,
      };
      state.disconnectedSince = null;
      this.nodes.set(node.nodeId, state);
    }

    const providerOwners = resolveProviderOwners(connectedNodes, this.sharedAccountGroups);
    const providerRequests = this.createProviderRequests(
      connectedNodes,
      providerOwners,
    );

    await Promise.all(connectedNodes.map(async (node) => {
      const state = this.nodes.get(node.nodeId);
      if (state === undefined) throw new Error(`Missing usage state for node ${node.nodeId}`);
      const requiredProvider = (provider: UsageSummaryProviderName): Promise<ProviderLimits> => {
        const ownerId = providerOwners.get(providerRequestKey(node.nodeId, provider))
          ?? node.nodeId;
        const request = providerRequests.get(providerRequestKey(ownerId, provider));
        if (request === undefined) {
          throw new Error(`Missing ${provider} usage request for node ${node.nodeId}`);
        }
        return request;
      };
      const results = await Promise.allSettled(USAGE_SUMMARY_PROVIDER_NAMES.map((provider) =>
        Promise.resolve().then(() => requiredProvider(provider)),
      ));
      const fresh = new Map<UsageSummaryProviderName, ProviderLimits>();
      const failedValues = new Map<UsageSummaryProviderName, ProviderLimits>();
      const failedProviders: string[] = [];
      let firstError: unknown;
      results.forEach((result, index) => {
        const provider = USAGE_SUMMARY_PROVIDER_NAMES[index];
        if (provider === undefined) return;
        // A fulfilled command can still carry a provider-level failure when the
        // node caught a timeout or fetch error. Treat it as a failed sample so
        // one bad cycle keeps the previous value instead of replacing it.
        if (result.status === "fulfilled" && result.value.status !== "error") {
          fresh.set(provider, result.value);
          state.providerFetchedAt[provider] = cycleStartedAt;
          return;
        }
        if (result.status === "fulfilled") {
          failedValues.set(provider, result.value);
          failedProviders.push(`${provider}: status error`);
          return;
        }
        failedProviders.push(provider);
        if (firstError === undefined) firstError = result.reason;
      });
      const providerLimits = (provider: UsageSummaryProviderName): ProviderLimits =>
        fresh.get(provider)
        ?? state.snapshot?.providers[provider]
        ?? failedValues.get(provider)
        ?? { ...NOT_CONFIGURED_PROVIDER_LIMITS, status: "error" };
      const snapshot: ProviderUsageSnapshot = {
        providers: {
          claude: providerLimits("claude"),
          codex: providerLimits("codex"),
          antigravity: providerLimits("antigravity"),
          opencode_go: providerLimits("opencode_go"),
        },
      };
      state.snapshot = snapshot;
      if (failedProviders.length > 0) {
        const reasons = failedProviders.join(", ");
        this.onWarning(
          firstError === undefined
            ? `Usage summary collection failed for node ${node.nodeId} (${reasons})`
            : `Usage summary collection failed for node ${node.nodeId} (${reasons}): ${errorMessage(firstError)}`,
          firstError,
        );
      }
    }));
    this.collectedAt = this.now().toISOString();
    this.notifyCollected();
  }

  private notifyCollected(): void {
    const summary = this.getSummary();
    try {
      this.onCollected?.(summary);
    } catch (error) {
      this.onWarning("Usage collection listener failed", error);
    }
    for (const listener of this.snapshotListeners) {
      try {
        listener(summary);
      } catch (error) {
        this.onWarning("Usage summary subscriber failed", error);
      }
    }
  }

  private summarizeNode(state: MutableNodeState): UsageSummaryNode {
    const summary = summarizeNode(state, this.staleAfterMs, this.now());
    const node = this.registry.getConnectedNode(state.nodeId);
    if (
      node === undefined
      || supportsClaudeAccountPool(node.capabilities)
      || summary.providers.claude === null
    ) return summary;

    const {
      mode: _mode,
      accounts: _accounts,
      pool: _pool,
      fable_pool: _fablePool,
      ...legacyClaude
    } = summary.providers.claude;
    return {
      ...summary,
      providers: { ...summary.providers, claude: legacyClaude },
    };
  }

  private createProviderRequests(
    connectedNodes: readonly NodeConnectionSnapshot[],
    providerOwners: ReadonlyMap<string, string>,
  ): Map<string, Promise<ProviderLimits>> {
    const requests = new Map<string, Promise<ProviderLimits>>();
    for (const node of connectedNodes) {
      const supportsAntigravity = node.supportedBackends.includes("antigravity");
      if (!supportsAntigravity) {
        requests.set(providerRequestKey(node.nodeId, "antigravity"), Promise.resolve(NOT_CONFIGURED_PROVIDER_LIMITS));
      }
      // Go usage is requested only where the node advertises the preset; other
      // nodes stay not_configured without a command, like Antigravity above.
      const advertisesOpencodeGo = advertisesOpencodeGoUsage(node);
      if (!advertisesOpencodeGo) {
        requests.set(providerRequestKey(node.nodeId, "opencode_go"), Promise.resolve(NOT_CONFIGURED_PROVIDER_LIMITS));
      }
      const requestableProviders = USAGE_SUMMARY_PROVIDER_NAMES.filter((provider) =>
        (provider !== "antigravity" || supportsAntigravity) &&
        (provider !== "opencode_go" || advertisesOpencodeGo),
      );
      const ownedProviders = requestableProviders.filter((provider) =>
        (providerOwners.get(providerRequestKey(node.nodeId, provider)) ?? node.nodeId)
          === node.nodeId,
      );
      // A single full-snapshot command replaces the per-provider ones only when
      // the node serves every usage source it can offer, exactly as before: a
      // node without the Antigravity backend keeps per-provider commands.
      if (supportsAntigravity && ownedProviders.length === requestableProviders.length) {
        const snapshot = this.fetchNodeSnapshot(node.nodeId);
        for (const provider of requestableProviders) {
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

function summarizeNode(
  state: MutableNodeState,
  staleAfterMs: number,
  now: Date,
): UsageSummaryNode {
  if (state.snapshot === null) {
    return {
      nodeId: state.nodeId,
      fetchedAt: null,
      stale: true,
      staleSince: state.disconnectedSince ?? state.firstSeenAt,
      providers: { claude: null, codex: null, antigravity: null, opencode_go: null },
    };
  }
  const providers = {} as Record<UsageSummaryProviderName, UsageSummaryProvider>;
  let missingFetchedAt = false;
  let earliestFetchedAt: number | null = null;
  let earliestStaleAt: number | null = null;
  let anyStale = false;
  for (const provider of USAGE_SUMMARY_PROVIDER_NAMES) {
    const fetchedAt = state.providerFetchedAt[provider] ?? null;
    const fetchedTime = fetchedAt === null ? null : Date.parse(fetchedAt);
    const stale = state.disconnectedSince !== null
      || fetchedTime === null
      || now.getTime() - fetchedTime > staleAfterMs;
    providers[provider] = summarizeProvider(state.snapshot.providers[provider], fetchedAt, stale);
    if (fetchedTime === null) missingFetchedAt = true;
    else if (earliestFetchedAt === null || fetchedTime < earliestFetchedAt) {
      earliestFetchedAt = fetchedTime;
    }
    if (stale) {
      anyStale = true;
      const staleAt = fetchedTime === null ? Date.parse(state.firstSeenAt) : fetchedTime + staleAfterMs;
      if (earliestStaleAt === null || staleAt < earliestStaleAt) earliestStaleAt = staleAt;
    }
  }
  const staleSince = state.disconnectedSince
    ?? (earliestStaleAt === null ? null : new Date(earliestStaleAt).toISOString());
  return {
    nodeId: state.nodeId,
    fetchedAt: missingFetchedAt || earliestFetchedAt === null
      ? null
      : new Date(earliestFetchedAt).toISOString(),
    stale: anyStale,
    staleSince: anyStale ? staleSince : null,
    providers,
  };
}

function summarizeProvider(
  limits: ProviderLimits,
  fetchedAt: string | null,
  stale: boolean,
): UsageSummaryProvider {
  return {
    status: limits.status,
    ...(limits.mode === undefined ? {} : {
      mode: limits.mode,
      accounts: limits.accounts,
      pool: limits.pool,
      fable_pool: limits.fable_pool,
    }),
    source: limits.source ?? null,
    sourceKind: limits.sourceKind ?? "unknown",
    observedAt: limits.observedAt ?? null,
    weeklyRemainingPercent: remainingPercent(limits.weeklyUsedPercent),
    weeklyResetAt: limits.weeklyResetAt,
    shortRemainingPercent: remainingPercent(limits.shortUsedPercent),
    shortResetAt: limits.shortResetAt,
    quotas: limits.quotas.map((quota) => ({ ...quota })),
    stale,
    fetchedAt,
  };
}

function remainingPercent(usedPercent: number | null): number | null {
  if (usedPercent === null) return null;
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

/** Go is a subscription on the account behind the node's key, not a backend. */
function advertisesOpencodeGoUsage(node: NodeConnectionSnapshot): boolean {
  return (node.modelPresets ?? []).some((preset) =>
    typeof preset === "object" && preset !== null
    && (preset as { usage_provider?: unknown }).usage_provider === "opencode_go",
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}
