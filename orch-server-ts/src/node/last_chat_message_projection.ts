import type { LastChatMessage, LastChatMessageType } from
  "../session/session_feed_contract.js";
import type { EventIngressEnvelope } from "./event_ingress_types.js";

const PREVIEW_CODEPOINT_LIMIT = 200;

/**
 * Derive the public feed message from the committed raw event, never from an
 * untrusted worker effect. This keeps old workers compatible while preventing
 * thinking/tool/error events from becoming feed messages.
 */
export function lastChatMessageFromEnvelope(
  envelope: EventIngressEnvelope,
  eventId: number,
): LastChatMessage | null {
  const payload = recordValue(envelope.payload);
  if (payload === null) return null;
  const source = lastChatSource(envelope.event_type, payload);
  if (source === null) return null;
  const preview = source.text.trim();
  if (preview.length === 0) return null;
  const timestamp = new Date(envelope.created_at);
  if (!Number.isFinite(timestamp.getTime())) return null;
  return {
    type: source.type,
    eventId,
    preview: Array.from(preview).slice(0, PREVIEW_CODEPOINT_LIMIT).join(""),
    timestamp: timestamp.toISOString(),
  };
}

function lastChatSource(
  eventType: string,
  payload: Record<string, unknown>,
): { type: LastChatMessageType; text: string } | null {
  if (eventType === "user_message") {
    return stringSource("user_message", payload.text);
  }
  if (eventType === "intervention_sent") {
    return stringSource("user_message", payload.text);
  }
  if (eventType === "assistant_message") {
    return stringSource("assistant_message", payload.content);
  }
  if (eventType !== "realtime_transcript" || payload.final !== true) {
    return null;
  }
  if (payload.role === "user") {
    return stringSource("user_message", payload.text);
  }
  if (payload.role === "assistant") {
    return stringSource("assistant_message", payload.text);
  }
  return null;
}

function stringSource(
  type: LastChatMessageType,
  value: unknown,
): { type: LastChatMessageType; text: string } | null {
  return typeof value === "string" ? { type, text: value } : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
