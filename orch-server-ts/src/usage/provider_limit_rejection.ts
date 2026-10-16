export type ProviderLimitProvider = "claude" | "codex" | "antigravity";

export type ProviderLimitRejection = {
  readonly rejectedUntil: string;
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
}): void {
  const provider = rejectedProvider(input.event);
  const payload = asRecord(input.event.payload);
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
  readonly now: Date;
}): ProviderLimitRejection | null {
  const value = input.memory.get(accountKey(
    input.nodeId,
    input.provider,
    input.sharedAccountGroups,
  ));
  const rejectedUntilMs = value === undefined ? null : parseTimestamp(value.rejectedUntil);
  return rejectedUntilMs !== null && rejectedUntilMs > input.now.getTime()
    ? value ?? null
    : null;
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
