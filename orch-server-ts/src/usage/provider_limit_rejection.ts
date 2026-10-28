export type ProviderLimitProvider = "claude" | "codex" | "antigravity";

export type ProviderLimitRejection = {
  readonly rejectedUntil: string | null;
  readonly rateLimitType: string | null;
  readonly observedAt: string;
};

export type ProviderExecutionEvent = {
  readonly nodeId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAt: string;
};

type ProviderLimitAccountGroup = {
  readonly provider: string;
  readonly nodeIds: readonly string[];
};

export function observeProviderExecution(input: {
  readonly memory: Map<string, ProviderLimitRejection>;
  readonly sharedAccountGroups: readonly ProviderLimitAccountGroup[];
  readonly event: ProviderExecutionEvent;
  readonly now: Date;
  readonly poolNode?: boolean;
}): void {
  const provider = rejectedProvider(input.event);
  const payload = asRecord(input.event.payload);
  if (
    input.poolNode
    && (provider === "claude" || successfulProvider(input.event) === "claude")
  ) {
    observePoolClaudeExecution(input, provider, payload);
    return;
  }
  if (provider !== null && payload !== null) {
    const resetMs = parseTimestamp(payload.resets_at);
    const observedMs = parseTimestamp(input.event.createdAt);
    const nowMs = input.now.getTime();
    if (resetMs !== null && observedMs !== null && resetMs > nowMs) {
      const key = accountKey(input.event.nodeId, provider, input.sharedAccountGroups);
      const current = input.memory.get(key);
      const currentObservedMs = current === undefined ? null : parseTimestamp(current.observedAt);
      if (
        current === undefined
        || (currentObservedMs !== null && observedMs > currentObservedMs)
      ) {
        input.memory.set(key, {
          rejectedUntil: new Date(resetMs).toISOString(),
          rateLimitType: typeof payload.rate_limit_type === "string"
            ? payload.rate_limit_type
            : null,
          observedAt: new Date(observedMs).toISOString(),
        });
      }
    }
    return;
  }

  const successfulProviderName = successfulProvider(input.event);
  if (successfulProviderName === null) return;
  const observedMs = parseTimestamp(input.event.createdAt);
  if (observedMs === null) return;
  const key = accountKey(
    input.event.nodeId,
    successfulProviderName,
    input.sharedAccountGroups,
  );
  const current = input.memory.get(key);
  const rejectedAt = current === undefined ? null : parseTimestamp(current.observedAt);
  if (rejectedAt !== null && observedMs > rejectedAt) input.memory.delete(key);
}

export function getProviderLimitRejection(input: {
  readonly memory: ReadonlyMap<string, ProviderLimitRejection>;
  readonly sharedAccountGroups: readonly ProviderLimitAccountGroup[];
  readonly nodeId: string;
  readonly provider: ProviderLimitProvider;
  readonly accountId?: string;
  readonly scope?: "all" | "fable";
  readonly poolNode?: boolean;
  readonly now: Date;
}): ProviderLimitRejection | null {
  if (input.poolNode && input.provider === "claude") {
    if (!input.accountId || !input.scope) return null;
    return getPoolAccountRejection(input.memory, input.accountId, input.scope, input.now);
  }
  const value = input.memory.get(accountKey(
    input.nodeId,
    input.provider,
    input.sharedAccountGroups,
  ));
  if (value === undefined || value.rejectedUntil === null) return null;
  const rejectedUntilMs = parseTimestamp(value.rejectedUntil);
  return rejectedUntilMs !== null && rejectedUntilMs > input.now.getTime() ? value : null;
}

function observePoolClaudeExecution(
  input: {
    readonly memory: Map<string, ProviderLimitRejection>;
    readonly event: ProviderExecutionEvent;
    readonly now: Date;
  },
  provider: ProviderLimitProvider | null,
  payload: Record<string, unknown> | null,
): void {
  if (provider === "claude" && payload !== null) {
    const accountId = stringValue(payload.account_id);
    const scope = poolScope(payload.scope);
    const observedMs = parseTimestamp(input.event.createdAt);
    const resetsAt = payload.resets_at;
    const resetMs = resetsAt === null ? null : parseTimestamp(resetsAt);
    if (
      accountId !== null && scope !== null && observedMs !== null
      && (resetsAt === null || (resetMs !== null && resetMs > input.now.getTime()))
    ) {
      const rateLimitType = typeof payload.rate_limit_type === "string"
        ? payload.rate_limit_type
        : null;
      const key = poolRejectionKey(accountId, scope, rateLimitType);
      const current = input.memory.get(key);
      const currentObservedMs = current === undefined ? null : parseTimestamp(current.observedAt);
      if (current === undefined || (currentObservedMs !== null && observedMs > currentObservedMs)) {
        input.memory.set(key, {
          rejectedUntil: resetMs === null ? null : new Date(resetMs).toISOString(),
          rateLimitType,
          observedAt: new Date(observedMs).toISOString(),
        });
      }
    }
    return;
  }

  const successPayload = payload;
  if (successPayload === null) return;
  const accountId = stringValue(successPayload.account_id);
  const scope = poolScope(successPayload.scope);
  const observedMs = parseTimestamp(input.event.createdAt);
  if (accountId === null || scope === null || observedMs === null) return;
  const prefix = poolRejectionPrefix(accountId, scope);
  for (const [key, rejection] of input.memory) {
    const rejectedAt = parseTimestamp(rejection.observedAt);
    if (key.startsWith(prefix) && rejectedAt !== null && observedMs > rejectedAt) {
      input.memory.delete(key);
    }
  }
}

function getPoolAccountRejection(
  memory: ReadonlyMap<string, ProviderLimitRejection>,
  accountId: string,
  scope: "all" | "fable",
  now: Date,
): ProviderLimitRejection | null {
  const prefix = poolRejectionPrefix(accountId, scope);
  const active: ProviderLimitRejection[] = [];
  for (const [key, rejection] of memory) {
    if (!key.startsWith(prefix)) continue;
    if (rejection.rejectedUntil === null) {
      active.push(rejection);
      continue;
    }
    const resetMs = parseTimestamp(rejection.rejectedUntil);
    if (resetMs !== null && resetMs > now.getTime()) active.push(rejection);
  }
  if (active.length === 0) return null;
  return active.reduce((longest, candidate) => {
    if (longest.rejectedUntil === null) return longest;
    if (candidate.rejectedUntil === null) return candidate;
    return Date.parse(candidate.rejectedUntil) > Date.parse(longest.rejectedUntil)
      ? candidate
      : longest;
  });
}

function rejectedProvider(event: ProviderExecutionEvent): ProviderLimitProvider | null {
  const payload = asRecord(event.payload);
  if (event.eventType !== "error" || payload?.type !== "error") return null;
  if (payload.error_code === "claude_rate_limit_stop_failure") return "claude";
  if (payload.error_code === "codex_usage_limit_exceeded") return "codex";
  return null;
}

function successfulProvider(event: ProviderExecutionEvent): ProviderLimitProvider | null {
  const payload = asRecord(event.payload);
  if (event.eventType === "result" && payload?.type === "result" && payload.success === true) {
    return "claude";
  }
  if (
    event.eventType === "complete"
    && payload?.type === "complete"
    && payload.raw_event_type === "turn/completed"
    && payload.status === "completed"
  ) {
    return "codex";
  }
  return null;
}

function accountKey(
  nodeId: string,
  provider: ProviderLimitProvider,
  groups: readonly ProviderLimitAccountGroup[],
): string {
  const group = groups.find((candidate) =>
    candidate.provider === provider && candidate.nodeIds.includes(nodeId),
  );
  const accountNodeId = group?.nodeIds[0] ?? nodeId;
  return `${provider}\u0000${accountNodeId}`;
}

function poolRejectionKey(
  accountId: string,
  scope: "all" | "fable",
  rateLimitType: string | null,
): string {
  return `${poolRejectionPrefix(accountId, scope)}${rateLimitType ?? "unknown"}`;
}

function poolRejectionPrefix(accountId: string, scope: "all" | "fable"): string {
  return `claude\u0000pool\u0000${accountId}\u0000${scope}\u0000`;
}

function poolScope(value: unknown): "all" | "fable" | null {
  return value === "all" || value === "fable" ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
