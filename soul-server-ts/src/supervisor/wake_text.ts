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
  updatedAt?: Date | string | null;
  eventCount?: number | null;
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
  now?: Date | string;
  maxSessions?: number;
  maxEventsPerSession?: number;
  maxTextChars?: number;
}

const DEFAULT_MAX_SESSIONS = 5;
const DEFAULT_MAX_TEXT_CHARS = 500;
const SHORT_SESSION_ID_CHARS = 8;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const NOISE_EVENT_TYPES = new Set([
  "text_start",
  "text_delta",
  "text_end",
  "thinking",
  "progress",
  "debug",
  "realtime_status",
  "realtime_transcript",
  "claude_runtime_session_state",
  "claude_runtime_task_updated",
  "claude_runtime_task_progress",
  "claude_runtime_hook_event",
  "context_usage",
]);
const TOOL_NOISE_EVENT_TYPES = new Set(["tool_start", "tool_use"]);
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
    | "updated_at"
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
    updatedAt: row?.updated_at ?? null,
    callerDisplayName:
      typeof callerInfo?.display_name === "string" ? callerInfo.display_name : null,
    callerSource: typeof callerInfo?.source === "string" ? callerInfo.source : null,
    lastMessagePreview: extractLastMessagePreview(row?.last_message),
    awaySummary: row?.away_summary ?? null,
    terminationReason: row?.termination_reason ?? null,
    terminationDetail: row?.termination_detail ?? null,
  };
}

export function buildSupervisorSnapshotWakeText(params: {
  supervisorId: string;
  sessions: SupervisorWakeSessionSummary[];
  now?: Date | string;
  maxSessions?: number;
  maxTextChars?: number;
}): string {
  const now = parseDate(params.now);
  const maxSessions = params.maxSessions ?? params.sessions.length;
  const maxTextChars = params.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const lines = [
    formatWakeHeader("snapshot", params.sessions.length, now),
    "",
  ];

  for (const summary of params.sessions.slice(0, maxSessions)) {
    lines.push(...formatSnapshotSession(summary, now, maxTextChars), "");
  }

  if (params.sessions.length > maxSessions) {
    lines.push(`외 ${params.sessions.length - maxSessions}개 세션 생략`, "");
  }
  lines.push("→ 개입이 필요한지 판단하세요.");
  return lines.join("\n");
}

export function buildSupervisorWakeText(params: BuildSupervisorWakeTextParams): string {
  const maxSessions = params.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxTextChars = params.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const now = parseDate(params.now);
  const groups = groupEventsBySession(params.events);
  const lines = [
    formatWakeHeader(params.wakeClass, groups.length, now),
    "",
  ];

  for (const group of groups.slice(0, maxSessions)) {
    const summary = params.sessions?.[group.sessionId] ?? { sessionId: group.sessionId };
    lines.push(...formatSessionGroup(group, summary, now, maxTextChars), "");
  }

  if (groups.length > maxSessions) {
    lines.push(`외 ${groups.length - maxSessions}개 세션 생략`, "");
  }
  lines.push("→ 개입이 필요한지 판단하세요.");
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

function groupPriority(events: SupervisorWakeEvent[]): number {
  let priority = Number.POSITIVE_INFINITY;
  for (const event of events) {
    const wakeClass = classifyWakeEvent(event.eventType);
    if (!wakeClass) continue;
    priority = Math.min(priority, WAKE_CLASS_PRIORITY[wakeClass]);
  }
  return Number.isFinite(priority) ? priority : 4;
}

function formatSessionGroup(
  group: { sessionId: string; events: SupervisorWakeEvent[] },
  summary: SupervisorWakeSessionSummary,
  now: Date | null,
  maxTextChars: number,
): string[] {
  const facts = summarizeGroupEvents(group.events, maxTextChars);
  const timeFact = summarizeGroupTime(group.events, summary.status);
  const title = truncate(summary.title ?? group.sessionId, maxTextChars) ?? shortSessionId(group.sessionId);
  const lines = [`▸ ${title}`];
  const metadata = [shortSessionId(group.sessionId)];
  if (summary.agentId) metadata.push(summary.agentId);
  if (summary.callerDisplayName || summary.callerSource) {
    const source = summary.callerSource ? ` (${summary.callerSource})` : "";
    metadata.push(`호출: ${summary.callerDisplayName ?? "unknown"}${source}`);
  }
  lines.push(`   ${metadata.join(" · ")}`);

  const statusParts: string[] = [];
  if (summary.status) statusParts.push(`상태: ${summary.status}`);
  const timeText = formatSessionTime(timeFact, now);
  if (timeText) statusParts.push(timeText);
  if (statusParts.length > 0) lines.push(`   ${statusParts.join(" · ")}`);

  pushValue(lines, "사용자", facts.lastUser, maxTextChars);
  const recent = facts.lastAssistant ?? summary.awaySummary ?? summary.lastMessagePreview;
  pushValue(lines, "최근", recent, maxTextChars);
  for (const errorLine of facts.errors) {
    pushValue(lines, "⚠ 오류", errorLine, maxTextChars);
  }
  lines.push(`   활동: ${formatActivity(group.events, facts.meaningfulCount, facts.errorCount)}`);
  return lines;
}

function formatSnapshotSession(
  summary: SupervisorWakeSessionSummary,
  now: Date | null,
  maxTextChars: number,
): string[] {
  const title = truncate(summary.title ?? summary.sessionId, maxTextChars) ??
    shortSessionId(summary.sessionId);
  const lines = [`▸ ${title}`];
  const metadata = [shortSessionId(summary.sessionId)];
  if (summary.agentId) metadata.push(summary.agentId);
  if (summary.callerDisplayName || summary.callerSource) {
    const source = summary.callerSource ? ` (${summary.callerSource})` : "";
    metadata.push(`호출: ${summary.callerDisplayName ?? "unknown"}${source}`);
  }
  lines.push(`   ${metadata.join(" · ")}`);

  const statusParts: string[] = [];
  if (summary.status) statusParts.push(`상태: ${summary.status}`);
  const timeFact = summarizeSnapshotTime(summary);
  const timeText = formatSessionTime(timeFact, now);
  if (timeText) statusParts.push(timeText);
  if (statusParts.length > 0) lines.push(`   ${statusParts.join(" · ")}`);

  const recent = summary.awaySummary ?? summary.lastMessagePreview;
  pushValue(lines, "최근", recent, maxTextChars);
  const error = snapshotError(summary);
  if (error) pushValue(lines, "⚠ 오류", error, maxTextChars);
  lines.push(`   활동: ${formatSnapshotActivity(summary)}`);
  return lines;
}

function formatWakeHeader(
  wakeClass: string,
  sessionCount: number,
  now: Date | null,
): string {
  const parts = [
    `[supervisor wake] ${wakeClass}`,
    `세션 ${sessionCount}개`,
  ];
  if (now) parts.push(`현재 ${formatDateTime(now)} (KST)`);
  return parts.join(" · ");
}

function summarizeGroupEvents(
  events: SupervisorWakeEvent[],
  maxTextChars: number,
): {
  lastUser: string | null;
  lastAssistant: string | null;
  errors: string[];
  meaningfulCount: number;
  errorCount: number;
} {
  let lastUser: string | null = null;
  let lastAssistant: string | null = null;
  const errors: string[] = [];
  let meaningfulCount = 0;
  let errorCount = 0;
  for (const event of events) {
    const payload = event.payload ?? {};
    if (isSubstantiveMessageEvent(event)) meaningfulCount += 1;
    if (event.eventType === "user_message") {
      lastUser = truncate(extractText(payload, ["text", "content", "message"]), maxTextChars);
    }
    if (event.eventType === "assistant_message") {
      lastAssistant = truncate(extractText(payload, ["content", "text", "message"]), maxTextChars);
    }
    if (event.eventType === "tool_result" && isErrorPayload(payload)) {
      const toolName = stringField(payload, "tool_name") ?? stringField(payload, "toolName") ?? "tool";
      const result = extractText(payload, ["result", "message", "content"]) ?? "error";
      errorCount += 1;
      const text = truncate(`${toolName}: ${normalizeText(result)}`, maxTextChars);
      if (text) errors.push(text);
    }
    if (event.eventType === "error") {
      errorCount += 1;
      const text = truncate(extractText(payload, ["message", "detail", "error"]), maxTextChars);
      if (text) errors.push(text);
    }
  }
  return { lastUser, lastAssistant, errors, meaningfulCount, errorCount };
}

function summarizeGroupTime(
  events: SupervisorWakeEvent[],
  status: string | null | undefined,
): { label: "완료" | "최근활동"; at: Date } | null {
  const completedEvent = [...events].reverse().find((event) =>
    event.eventType === "session_ended" && parseDate(event.createdAt)
  );
  if (status === "completed" && completedEvent) {
    return { label: "완료", at: parseDate(completedEvent.createdAt)! };
  }

  const latestAt = events.reduce<Date | null>((latest, event) => {
    const createdAt = parseDate(event.createdAt);
    if (!createdAt) return latest;
    if (!latest || createdAt.getTime() > latest.getTime()) return createdAt;
    return latest;
  }, null);
  return latestAt ? { label: "최근활동", at: latestAt } : null;
}

function summarizeSnapshotTime(
  summary: SupervisorWakeSessionSummary,
): { label: "완료" | "최근활동"; at: Date } | null {
  const updatedAt = parseDate(summary.updatedAt ?? undefined);
  if (!updatedAt) return null;
  return {
    label: summary.status === "completed" ? "완료" : "최근활동",
    at: updatedAt,
  };
}

function formatSessionTime(
  timeFact: { label: "완료" | "최근활동"; at: Date } | null,
  now: Date | null,
): string | null {
  if (!timeFact) return null;
  const relative = now ? ` (${formatRelativeTime(timeFact.at, now)})` : "";
  return `${timeFact.label} ${formatSessionDateTime(timeFact.at, now)}${relative}`;
}

function isMeaningfulEvent(event: SupervisorWakeEvent): boolean {
  if (NOISE_EVENT_TYPES.has(event.eventType)) return false;
  if (TOOL_NOISE_EVENT_TYPES.has(event.eventType)) return false;
  if (event.eventType === "tool_result") return isErrorPayload(event.payload ?? {});
  return true;
}

function isSubstantiveMessageEvent(event: SupervisorWakeEvent): boolean {
  return event.eventType === "user_message" || event.eventType === "assistant_message";
}

function formatActivity(
  events: SupervisorWakeEvent[],
  meaningfulCount: number,
  errorCount: number,
): string {
  let noiseCount = 0;
  for (const event of events) {
    if (isMeaningfulEvent(event)) continue;
    noiseCount += 1;
  }
  const dominant = noiseCount > meaningfulCount ? "진행·도구 위주" : "의미 신호 포함";
  const errorSummary = errorCount > 0 ? `오류 ${errorCount}건` : "오류 없음";
  return `이벤트 ${events.length}개 (${dominant}, 의미 메시지 ${meaningfulCount}) · ${errorSummary}`;
}

function formatSnapshotActivity(summary: SupervisorWakeSessionSummary): string {
  const eventCount = typeof summary.eventCount === "number"
    ? `이벤트 ${summary.eventCount}개`
    : "현재 상태 스냅샷";
  const hasError = Boolean(snapshotError(summary));
  return `${eventCount} · ${hasError ? "오류 있음" : "오류 없음"}`;
}

function snapshotError(summary: SupervisorWakeSessionSummary): string | null {
  if (summary.status !== "error") return null;
  return summary.terminationDetail ?? summary.terminationReason ?? "error";
}

function pushValue(
  lines: string[],
  key: string,
  value: string | null | undefined,
  maxTextChars: number,
): void {
  const normalized = normalizeText(value);
  if (!normalized) return;
  lines.push(`   ${key}: ${truncate(normalized, maxTextChars)}`);
}

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 16) return sessionId;
  return sessionId.slice(0, SHORT_SESSION_ID_CHARS);
}

function parseDate(value: Date | string | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDateTime(date: Date): string {
  return formatKstParts(date, true);
}

function formatSessionDateTime(date: Date, now: Date | null): string {
  if (now && formatKstDate(date) === formatKstDate(now)) {
    return formatKstParts(date, false);
  }
  return `${formatKstParts(date, true)} (KST)`;
}

function formatKstDate(date: Date): string {
  return formatKstParts(date, true).slice(0, 10);
}

function formatKstParts(date: Date, includeDate: boolean): string {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  const year = String(kst.getUTCFullYear()).padStart(4, "0");
  const month = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(kst.getUTCDate()).padStart(2, "0");
  const hour = String(kst.getUTCHours()).padStart(2, "0");
  const minute = String(kst.getUTCMinutes()).padStart(2, "0");
  const second = String(kst.getUTCSeconds()).padStart(2, "0");
  const time = `${hour}:${minute}:${second}`;
  if (!includeDate) return time;
  return `${year}-${month}-${day} ${time}`;
}

function formatRelativeTime(at: Date, now: Date): string {
  const diffMs = now.getTime() - at.getTime();
  const suffix = diffMs < 0 ? "후" : "전";
  const absMs = Math.abs(diffMs);
  if (absMs < 60_000) return "방금";
  const minutes = Math.round(absMs / 60_000);
  if (minutes < 60) return `${minutes}분 ${suffix}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 ${suffix}`;
  return `${Math.floor(hours / 24)}일 ${suffix}`;
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
