import type { SessionNotice, SoulSSEEvent } from "./types";
import { formatRetryingErrorHistory } from "./sse-events";
import { formatRateLimitNotice } from "./rate-limit-notice";

const MAX_PENDING_BROWSER_NOTICES = 100;

function truncate(value: string, length = 100): string {
  return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}

function rateLimitNoticeBody(
  message: string,
  rateLimitType?: string,
  resetsAt?: string,
): string {
  const formatted = formatRateLimitNotice(message, rateLimitType, resetsAt);
  if (formatted === message) return truncate(message);
  const details = formatted.slice(message.length);
  return `${truncate(message)}${details}`;
}

export function detailEventToSessionNotice(
  event: SoulSSEEvent,
  eventId: number,
  sessionId: string | null,
): SessionNotice | null {
  if (!sessionId || !Number.isFinite(eventId) || eventId <= 0) return null;
  const common = {
    id: `${sessionId}:${eventId}`,
    sourceEventId: eventId,
    sessionId,
    createdAt: new Date().toISOString(),
  } as const;
  switch (event.type) {
    case "complete":
      return { ...common, kind: "terminal", title: "✅ Session Complete", body: truncate(event.result || "Session completed successfully") };
    case "error": {
      if (event.will_retry === true) {
        return {
          ...common,
          kind: "error",
          title: "⚠️ 자동 재연결 발생",
          body: truncate(formatRetryingErrorHistory(event.message)),
        };
      }
      const message = event.message || "An error occurred";
      const isRateLimitStop = event.error_code === "claude_rate_limit_stop_failure";
      return {
        ...common,
        kind: "error",
        title: "❌ Session Error",
        body: rateLimitNoticeBody(
          message,
          isRateLimitStop ? event.rate_limit_type : undefined,
          isRateLimitStop ? event.resets_at : undefined,
        ),
      };
    }
    case "intervention_sent":
      return { ...common, kind: "intervention", title: `✋ Intervention (${event.user})`, body: truncate(event.text) };
    case "session_notification":
      return {
        ...common,
        kind: "response_wait",
        title: "Soul Dashboard",
        body: rateLimitNoticeBody(event.text, event.rate_limit_type, event.resets_at),
      };
    case "claude_runtime_notification":
      return {
        ...common,
        kind: "runtime_notification",
        title: event.title ?? event.notification_type ?? "Runtime Notification",
        body: truncate(event.message),
      };
    default:
      return null;
  }
}

export function appendBrowserNotices(
  current: readonly SessionNotice[],
  incoming: readonly SessionNotice[],
): SessionNotice[] {
  if (incoming.length === 0) return current as SessionNotice[];
  const seen = new Set(current.map((notice) => notice.id));
  const additions = incoming.filter((notice) => {
    if (seen.has(notice.id)) return false;
    seen.add(notice.id);
    return true;
  });
  if (additions.length === 0) return current as SessionNotice[];
  return [...current, ...additions].slice(-MAX_PENDING_BROWSER_NOTICES);
}
