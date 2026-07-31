import type { LivePostgresSql } from "../runtime/live_db_sql.js";
import { parseChildSessionRelationKey } from
  "./turn_summary_speaker.js";

const EXTERNAL_INPUT_TYPES = ["user_message", "intervention_sent"] as const;

type EvidenceEvent = {
  readonly id: number;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
};

export type TurnSummaryStartEvidence =
  | {
    readonly kind: "user_message";
    readonly evidenceState: "complete";
  }
  | {
    readonly kind: "intervention_sent";
    readonly evidenceState: "complete";
  }
  | {
    readonly kind: "system_notification";
    readonly evidenceState: "complete";
  }
  | {
    readonly kind: "completion_notification";
    readonly evidenceState:
      | "complete"
      | "legacy_missing_relation"
      | "legacy_missing_current_terminal"
      | "legacy_missing_previous_terminal";
    readonly childSessionId: string | null;
    readonly currentRevision: number | null;
    readonly previousCompletedRevision: number | null;
    readonly currentTerminalStatus: string | null;
    readonly hasNewExternalInput: boolean | null;
  };

export async function loadTurnSummaryStartEvidence(
  sql: LivePostgresSql,
  parentEvents: readonly EvidenceEvent[],
  turnStartEventId: number,
): Promise<TurnSummaryStartEvidence> {
  const start = parentEvents.find((event) => event.id === turnStartEventId);
  if (start?.eventType === "user_message") {
    return { kind: "user_message", evidenceState: "complete" };
  }
  if (start?.eventType === "intervention_sent") {
    return { kind: "intervention_sent", evidenceState: "complete" };
  }
  if (
    start?.eventType !== "session_notification" ||
    stringValue(start.payload.delivery_intent) !== "completion_notification"
  ) {
    return { kind: "system_notification", evidenceState: "complete" };
  }

  const currentRelation = parseChildSessionRelationKey(
    stringValue(start.payload.relation_key) ?? undefined,
  );
  if (currentRelation === undefined) {
    return missingCompletionEvidence("legacy_missing_relation");
  }

  const previousNotifications = parentEvents.filter((event) =>
    event.id < turnStartEventId &&
    event.eventType === "session_notification" &&
    stringValue(event.payload.delivery_intent) === "completion_notification"
  );
  const parsedPrevious = previousNotifications.map((event) =>
    parseChildSessionRelationKey(
      stringValue(event.payload.relation_key) ?? undefined,
    )
  );
  const sameChildPrevious = parsedPrevious.filter(
    (relation): relation is NonNullable<typeof relation> =>
      relation?.childSessionId === currentRelation.childSessionId,
  );
  const terminalRevisions = [...new Set([
    currentRelation.terminalRevision,
    ...sameChildPrevious.map((relation) => relation.terminalRevision),
  ])];
  const childRows = await sql`
    SELECT id, event_type, payload
    FROM events
    WHERE session_id = ${currentRelation.childSessionId}
      AND (
        (event_type = 'session_ended'
          AND id = ANY(${terminalRevisions}::int[]))
        OR (
          event_type = ANY(${EXTERNAL_INPUT_TYPES}::text[])
          AND id <= ${currentRelation.terminalRevision}
        )
      )
    ORDER BY id ASC
  `;
  const childEvents = childRows.map(normalizeChildEvent).filter(isDefined);
  const terminalStatusByRevision = new Map<number, string>();
  for (const event of childEvents) {
    if (event.eventType !== "session_ended") continue;
    const status = stringValue(event.payload.status);
    if (status !== null) {
      terminalStatusByRevision.set(event.id, status.toLowerCase());
    }
  }

  const currentStatus =
    terminalStatusByRevision.get(currentRelation.terminalRevision) ?? null;
  if (currentStatus === null) {
    return completionEvidence({
      evidenceState: "legacy_missing_current_terminal",
      childSessionId: currentRelation.childSessionId,
      currentRevision: currentRelation.terminalRevision,
      currentTerminalStatus: null,
    });
  }

  const previousEvidenceMissing =
    parsedPrevious.some((relation) => relation === undefined) ||
    sameChildPrevious.some((relation) =>
      !terminalStatusByRevision.has(relation.terminalRevision)
    );
  const previousCompletedRevision = sameChildPrevious.reduce<number | null>(
    (latest, relation) =>
      terminalStatusByRevision.get(relation.terminalRevision) === "completed" &&
          (latest === null || relation.terminalRevision > latest)
        ? relation.terminalRevision
        : latest,
    null,
  );
  if (previousEvidenceMissing) {
    return completionEvidence({
      evidenceState: "legacy_missing_previous_terminal",
      childSessionId: currentRelation.childSessionId,
      currentRevision: currentRelation.terminalRevision,
      previousCompletedRevision,
      currentTerminalStatus: currentStatus,
    });
  }

  const lowerBound = previousCompletedRevision ?? currentRelation.terminalRevision;
  const hasNewExternalInput = previousCompletedRevision === null
    ? false
    : childEvents.some((event) =>
      EXTERNAL_INPUT_TYPES.includes(
        event.eventType as typeof EXTERNAL_INPUT_TYPES[number],
      ) &&
      event.id > lowerBound &&
      event.id <= currentRelation.terminalRevision
    );
  return {
    kind: "completion_notification",
    evidenceState: "complete",
    childSessionId: currentRelation.childSessionId,
    currentRevision: currentRelation.terminalRevision,
    previousCompletedRevision,
    currentTerminalStatus: currentStatus,
    hasNewExternalInput,
  };
}

function missingCompletionEvidence(
  evidenceState: "legacy_missing_relation",
): TurnSummaryStartEvidence {
  return completionEvidence({ evidenceState });
}

function completionEvidence(overrides: Partial<{
  evidenceState: Extract<
    TurnSummaryStartEvidence,
    { kind: "completion_notification" }
  >["evidenceState"];
  childSessionId: string | null;
  currentRevision: number | null;
  previousCompletedRevision: number | null;
  currentTerminalStatus: string | null;
}>): TurnSummaryStartEvidence {
  return {
    kind: "completion_notification",
    evidenceState: overrides.evidenceState ?? "legacy_missing_relation",
    childSessionId: overrides.childSessionId ?? null,
    currentRevision: overrides.currentRevision ?? null,
    previousCompletedRevision: overrides.previousCompletedRevision ?? null,
    currentTerminalStatus: overrides.currentTerminalStatus ?? null,
    hasNewExternalInput: null,
  };
}

function normalizeChildEvent(row: Record<string, unknown>): EvidenceEvent | null {
  const id = positiveInteger(row.id);
  if (id === null) return null;
  return {
    id,
    eventType: String(row.event_type ?? ""),
    payload: recordValue(parseJsonValue(row.payload)),
  };
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
