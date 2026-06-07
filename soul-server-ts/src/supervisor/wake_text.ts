import type { SessionRow } from "../db/session_db.js";
import { extractCallerInfoFromMetadata } from "../task/task_metadata.js";

import { classifyWakeEvent, type WakeClass } from "./wake_classification.js";
import type { SupervisorWakeEvent } from "./wake_router.js";

export interface SupervisorWakeSessionSummary {
  sessionId: string;
  title?: string | null;
  agentId?: string | null;
  callerDisplayName?: string | null;
  callerSource?: string | null;
  status?: string | null;
  lastMessagePreview?: string | null;
  awaySummary?: string | null;
  terminationReason?: string | null;
  terminationDetail?: string | null;
}

export interface BuildSupervisorWakeTextParams {
  supervisorId: string;
  wakeClass: string;
  events: SupervisorWakeEvent[];
  sessions?: Record<string, SupervisorWakeSessionSummary | undefined>;
  maxSessions?: number;
  maxEventsPerSession?: number;
  maxTextChars?: number;
}

const DEFAULT_MAX_SESSIONS = 5;
const DEFAULT_MAX_EVENTS_PER_SESSION = 6;
const DEFAULT_MAX_TEXT_CHARS = 320;
const NOISE_EVENT_TYPES = new Set(["text_delta", "progress", "debug"]);
const WAKE_CLASS_PRIORITY: Record<WakeClass, number> = {
  critical: 0,
  wake: 1,
  batch: 2,
  quiet: 3,
};

type WakeSessionRow = Partial<
  Pick<
    SessionRow,
    | "display_name"
    | "status"
    | "agent_id"
    | "last_message"
    | "away_summary"
    | "termination_reason"
    | "termination_detail"
    | "metadata"
  >
>;

export function wakeSessionSummaryFromRow(
  sessionId: string,
  row: WakeSessionRow | null | undefined,
): SupervisorWakeSessionSummary {
  const callerInfo = extractCallerInfoFromMetadata(row?.metadata);
  return {
    sessionId,
    title: row?.display_name ?? null,
    status: row?.status ?? null,
    agentId: row?.agent_id ?? null,
    callerDisplayName:
      typeof callerInfo?.display_name === "string" ? callerInfo.display_name : null,
    callerSource: typeof callerInfo?.source === "string" ? callerInfo.source : null,
    lastMessagePreview: extractLastMessagePreview(row?.last_message),
    awaySummary: row?.away_summary ?? null,
    terminationReason: row?.termination_reason ?? null,
    terminationDetail: row?.termination_detail ?? null,
  };
}

export function buildSupervisorWakeText(params: BuildSupervisorWakeTextParams): string {
  const maxSessions = params.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxEventsPerSession =
    params.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION;
  const maxTextChars = params.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const head = params.events[params.events.length - 1]?.offset ?? 0;
  const groups = groupEventsBySession(params.events);
  const triggerSessions = triggerSessionIds(groups);
  const lines = [
    `[supervisor wake] role=${params.supervisorId} class=${params.wakeClass} head=${head} trigger_sessions=${triggerSessions.join(",") || "none"}`,
    `events=${params.events.length} sessions=${groups.length}`,
  ];

  for (const group of groups.slice(0, maxSessions)) {
    const summary = params.sessions?.[group.sessionId] ?? { sessionId: group.sessionId };
    lines.push(...formatSessionGroup(group, summary, maxEventsPerSession, maxTextChars));
  }

  if (groups.length > maxSessions) {
    lines.push(`omitted_sessions=${groups.length - maxSessions}`);
  }
  lines.push("Decide whether this wake batch needs intervention.");
  return lines.join("\n");
}

function groupEventsBySession(events: SupervisorWakeEvent[]): Array<{
  sessionId: string;
  events: SupervisorWakeEvent[];
}> {
  const groups = new Map<string, { events: SupervisorWakeEvent[]; firstIndex: number }>();
  for (const [index, event] of events.entries()) {
    const sessionId = event.sourceSessionId ?? "unknown";
    const group = groups.get(sessionId);
    if (group) {
      group.events.push(event);
    } else {
      groups.set(sessionId, { events: [event], firstIndex: index });
    }
  }
  return Array.from(groups.entries())
    .map(([sessionId, group]) => ({
      sessionId,
      events: group.events,
      firstIndex: group.firstIndex,
      priority: groupPriority(group.events),
    }))
    .sort((left, right) =>
      left.priority - right.priority || left.firstIndex - right.firstIndex
    )
    .map(({ sessionId, events: groupEvents }) => ({
      sessionId,
      events: groupEvents,
    }));
}

function triggerSessionIds(groups: Array<{
  sessionId: string;
  events: SupervisorWakeEvent[];
}>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!hasTriggerEvent(group.events)) continue;
    if (seen.has(group.sessionId)) continue;
    seen.add(group.sessionId);
    result.push(group.sessionId);
  }
  return result;
}

function groupPriority(events: SupervisorWakeEvent[]): number {
  let priority = Number.POSITIVE_INFINITY;
  for (const event of events) {
    const wakeClass = classifyWakeEvent(event.eventType);
    if (!wakeClass) continue;
    priority = Math.min(priority, WAKE_CLASS_PRIORITY[wakeClass]);
  }
  return Number.isFinite(priority) ? priority : 4;
}

function hasTriggerEvent(events: SupervisorWakeEvent[]): boolean {
  return events.some((event) => {
    const wakeClass = classifyWakeEvent(event.eventType);
    return wakeClass !== null && wakeClass !== "quiet";
  });
}

function formatSessionGroup(
  group: { sessionId: string; events: SupervisorWakeEvent[] },
  summary: SupervisorWakeSessionSummary,
  maxEventsPerSession: number,
  maxTextChars: number,
): string[] {
  const facts = summarizeGroupEvents(group.events, maxTextChars);
  const lines = [`## session ${group.sessionId}`];
  pushValue(lines, "title", summary.title ?? group.sessionId, maxTextChars);
  pushValue(lines, "agent", summary.agentId, maxTextChars);
  if (summary.callerDisplayName || summary.callerSource) {
    const source = summary.callerSource ? ` (${summary.callerSource})` : "";
    pushValue(lines, "caller", `${summary.callerDisplayName ?? "unknown"}${source}`, maxTextChars);
  }
  pushValue(lines, "status", summary.status, maxTextChars);
  pushValue(lines, "last_user", facts.lastUser, maxTextChars);
  pushValue(lines, "last_assistant", facts.lastAssistant ?? summary.lastMessagePreview, maxTextChars);
  pushValue(lines, "tool_error", facts.toolError, maxTextChars);
  pushValue(lines, "error", facts.error, maxTextChars);
  const sessionSummary = facts.sessionEnded
    ? summary.awaySummary ?? summary.lastMessagePreview
    : null;
  pushValue(lines, "session_summary", sessionSummary, maxTextChars);
  pushValue(lines, "termination", facts.termination ?? summary.terminationReason, maxTextChars);

  const noiseSummary = formatCounts(countEvents(group.events, true));
  if (noiseSummary) lines.push(`noise=${noiseSummary}`);
  const eventSummary = formatCounts(countEvents(group.events, false));
  if (eventSummary) lines.push(`events=${eventSummary}`);

  const visibleEvents = group.events
    .filter((event) => !NOISE_EVENT_TYPES.has(event.eventType))
    .slice(0, maxEventsPerSession);
  for (const event of visibleEvents) {
    lines.push(formatEventLine(event, maxTextChars));
  }
  const meaningfulCount = group.events.filter((event) =>
    !NOISE_EVENT_TYPES.has(event.eventType)
  ).length;
  if (meaningfulCount > visibleEvents.length) {
    lines.push(`- ... ${meaningfulCount - visibleEvents.length} more meaningful events`);
  }
  return lines;
}

function summarizeGroupEvents(
  events: SupervisorWakeEvent[],
  maxTextChars: number,
): {
  lastUser: string | null;
  lastAssistant: string | null;
  toolError: string | null;
  error: string | null;
  sessionEnded: boolean;
  termination: string | null;
} {
  let lastUser: string | null = null;
  let lastAssistant: string | null = null;
  let toolError: string | null = null;
  let error: string | null = null;
  let sessionEnded = false;
  let termination: string | null = null;
  for (const event of events) {
    const payload = event.payload ?? {};
    if (event.eventType === "user_message") {
      lastUser = truncate(extractText(payload, ["text", "content", "message"]), maxTextChars);
    }
    if (event.eventType === "assistant_message") {
      lastAssistant = truncate(extractText(payload, ["content", "text", "message"]), maxTextChars);
    }
    if (event.eventType === "tool_result" && isErrorPayload(payload)) {
      const toolName = stringField(payload, "tool_name") ?? stringField(payload, "toolName") ?? "tool";
      const result = extractText(payload, ["result", "message", "content"]) ?? "error";
      toolError = truncate(`${toolName}: ${normalizeText(result)}`, maxTextChars);
    }
    if (event.eventType === "error") {
      error = truncate(extractText(payload, ["message", "detail", "error"]), maxTextChars);
    }
    if (event.eventType === "session_ended") {
      sessionEnded = true;
      termination = truncate(
        extractText(payload, ["termination_reason", "termination_detail", "status"]),
        maxTextChars,
      );
    }
  }
  return { lastUser, lastAssistant, toolError, error, sessionEnded, termination };
}

function formatEventLine(event: SupervisorWakeEvent, maxTextChars: number): string {
  const payload = event.payload ?? {};
  const detail =
    event.eventType === "assistant_message"
      ? extractText(payload, ["content", "text", "message"])
      : event.eventType === "user_message"
        ? extractText(payload, ["text", "content", "message"])
        : event.eventType === "tool_result" && isErrorPayload(payload)
          ? extractText(payload, ["result", "message", "content"])
          : event.eventType === "error"
            ? extractText(payload, ["message", "detail", "error"])
            : null;
  return detail
    ? `- #${event.offset} ${event.eventType}: ${truncate(detail, maxTextChars)}`
    : `- #${event.offset} ${event.eventType}`;
}

function countEvents(
  events: SupervisorWakeEvent[],
  noiseOnly: boolean,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const isNoise = NOISE_EVENT_TYPES.has(event.eventType);
    if (noiseOnly !== isNoise) continue;
    counts.set(event.eventType, (counts.get(event.eventType) ?? 0) + 1);
  }
  return counts;
}

function formatCounts(counts: Map<string, number>): string {
  return Array.from(counts.entries())
    .map(([eventType, count]) => `${eventType}:${count}`)
    .join(", ");
}

function pushValue(
  lines: string[],
  key: string,
  value: string | null | undefined,
  maxTextChars: number,
): void {
  const normalized = normalizeText(value);
  if (!normalized) return;
  lines.push(`${key}=${truncate(normalized, maxTextChars)}`);
}

function extractLastMessagePreview(lastMessage: unknown): string | null {
  if (!lastMessage || typeof lastMessage !== "object") return null;
  const preview = (lastMessage as Record<string, unknown>).preview;
  return typeof preview === "string" ? preview : null;
}

function extractText(
  record: Record<string, unknown>,
  fields: string[],
): string | null {
  for (const field of fields) {
    const value = record[field];
    const text = valueToText(value);
    if (text) return text;
  }
  return null;
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function valueToText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const record = item as Record<string, unknown>;
        return valueToText(record.text ?? record.content) ?? "";
      })
      .filter(Boolean)
      .join(" ");
    return text || null;
  }
  return null;
}

function isErrorPayload(record: Record<string, unknown>): boolean {
  return record.is_error === true || record.isError === true;
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function truncate(value: string | null | undefined, maxTextChars: number): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (normalized.length <= maxTextChars) return normalized;
  if (maxTextChars <= 3) return normalized.slice(0, maxTextChars);
  return `${normalized.slice(0, maxTextChars - 3)}...`;
}
