const HUMAN_CALLER_SOURCES = new Set([
  "browser",
  "slack",
  "soul-app",
]);

export type TurnSummarySpeaker =
  | {
    readonly kind: "user";
    readonly displayName: string;
    readonly source: string;
    readonly userId?: string;
  }
  | {
    readonly kind: "agent";
    readonly agentName: string;
  }
  | {
    readonly kind: "delegated_session";
    readonly childSessionId?: string;
    readonly agentName?: string;
  }
  | {
    readonly kind: "system";
  };

export function resolveTurnSummarySpeaker(
  eventType: string,
  payload: Record<string, unknown>,
): TurnSummarySpeaker | undefined {
  if (eventType === "session_notification") {
    if (nonEmptyString(payload.delivery_intent) !== "completion_notification") {
      return { kind: "system" };
    }
    const childSessionId = parseChildSessionRelationKey(
      nonEmptyString(payload.relation_key),
    )?.childSessionId;
    return {
      kind: "delegated_session",
      ...(childSessionId === undefined ? {} : { childSessionId }),
    };
  }

  const callerInfo = recordValue(payload.caller_info ?? payload.callerInfo);
  const source = nonEmptyString(callerInfo.source);
  if (source === undefined) return undefined;

  if (source === "agent") {
    return {
      kind: "agent",
      agentName: firstNonEmptyString(
        callerInfo.agent_name,
        callerInfo.display_name,
        callerInfo.agent_id,
        callerInfo.user_id,
      ) ?? "위임 에이전트",
    };
  }

  if (HUMAN_CALLER_SOURCES.has(source)) {
    const userId = nonEmptyString(callerInfo.user_id);
    return {
      kind: "user",
      displayName: firstNonEmptyString(
        callerInfo.display_name,
        userId,
      ) ?? "사용자",
      source,
      ...(userId === undefined ? {} : { userId }),
    };
  }

  return { kind: "system" };
}

export function formatTurnSummarySpeakerLabel(
  speaker: TurnSummarySpeaker,
): string {
  if (speaker.kind === "agent") {
    return `[발화자: ${speaker.agentName} (위임 에이전트 보고)]`;
  }
  if (speaker.kind === "delegated_session") {
    const identity =
      speaker.agentName ??
      (
        speaker.childSessionId === undefined
          ? "위임 세션"
          : `위임 세션 ${speaker.childSessionId.slice(0, 8)}`
      );
    const sessionId =
      speaker.childSessionId === undefined
        ? ""
        : `, session_id: ${speaker.childSessionId}`;
    return `[발화자: ${identity} (위임 세션 완료 보고${sessionId})]`;
  }
  if (speaker.kind === "system") {
    return "[발화자: 시스템]";
  }
  const userId = speaker.userId === undefined
    ? ""
    : `, user_id: ${speaker.userId}`;
  return `[발화자: ${speaker.displayName} (사용자, ${speaker.source}${userId})]`;
}

export function parseChildSessionRelationKey(
  relationKey: string | undefined,
): {
  readonly childSessionId: string;
  readonly terminalRevision: number;
} | undefined {
  if (relationKey === undefined) return undefined;
  const match = /^child_session:([^:]+):(\d+)$/.exec(relationKey);
  if (match === null) return undefined;
  const terminalRevision = Number(match[2]);
  if (!Number.isSafeInteger(terminalRevision) || terminalRevision <= 0) {
    return undefined;
  }
  return {
    childSessionId: match[1] ?? "",
    terminalRevision,
  };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = nonEmptyString(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
