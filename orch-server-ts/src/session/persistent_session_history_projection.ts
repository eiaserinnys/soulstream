import type {
  PersistentSessionHistoryEntry,
  PersistentSessionHistoryInputKind,
  PersistentSessionHistoryModelInfo,
  PersistentSessionHistorySender,
} from "@soulstream/mcp-contract";
import type { PersistentSessionHistoryRow } from "../control_plane/repositories/persistent_session_history_query.js";
import { projectInputAttachments } from "./attachment_history_projection.js";

const SYSTEM_SOURCES = new Set(["api", "channel_observer", "execute-proxy", "llm", "system"]);

export function projectPersistentSessionHistoryEntry(
  row: PersistentSessionHistoryRow,
  maxTextChars: number,
): PersistentSessionHistoryEntry {
  const payload = row.payload;
  const callerInfo = record(payload.caller_info) ?? {};
  const common = {
    event_id: row.id,
    created_at: row.created_at.toISOString(),
    created_at_kst: toKstIso(row.created_at),
    generation: row.generation,
  };

  switch (row.event_type) {
    case "user_message":
    case "intervention_sent": {
      const source = preferString(callerInfo, payload, "source");
      const attachments = projectInputAttachments(payload);
      const nodeId = stringValue(payload.node_id);
      return {
        ...common,
        event_type: row.event_type,
        kind: inputKind(source),
        ...projectText(payload.text, maxTextChars),
        input_id: stringValue(payload.input_id),
        source,
        sender: projectSender(callerInfo, payload),
        purpose: stringValue(payload.purpose),
        ...attachments,
        ...(nodeId === null ? {} : { node_id: nodeId }),
      };
    }
    case "assistant_message": {
      const parentEventId = row.parent_event_id ?? parentEventIdValue(payload.parent_event_id);
      return {
        ...common,
        event_type: "assistant_message",
        kind: "assistant",
        ...projectText(payload.content, maxTextChars),
        ...(parentEventId === null ? {} : { parent_event_id: parentEventId }),
      };
    }
    case "session_notification":
      return {
        ...common,
        event_type: "session_notification",
        kind: "system",
        ...projectText(payload.text, maxTextChars),
        source: stringValue(payload.source),
        delivery_id: stringValue(payload.delivery_id),
        delivery_intent: stringValue(payload.delivery_intent),
      };
    case "generation_started":
      return {
        ...common,
        event_type: "generation_started",
        kind: "generation",
        ...projectText(row.generation === null ? "세대 시작" : `세대 ${row.generation} 시작`, maxTextChars),
        reason: stringValue(payload.reason),
        previous: projectModelInfo(payload.previous),
        current: projectModelInfo(payload.current),
        context_reset: typeof payload.context_reset === "boolean" ? payload.context_reset : null,
      };
    default:
      throw new Error(`Unsupported persistent session history event type: ${row.event_type}`);
  }
}

function inputKind(source: string | null): PersistentSessionHistoryInputKind {
  if (source === "slack" || source === "browser" || source === "soul-app") return "human";
  if (source === "agent") return "agent";
  if (source !== null && SYSTEM_SOURCES.has(source)) return "system";
  return "unknown";
}

function projectText(value: unknown, maxTextChars: number): { text: string; text_chars: number; truncated: boolean } {
  const text = stringValue(value) ?? "";
  const codePoints = [...text];
  const truncated = codePoints.length > maxTextChars;
  return {
    text: truncated ? codePoints.slice(0, maxTextChars).join("") : text,
    text_chars: codePoints.length,
    truncated,
  };
}

function projectSender(
  callerInfo: Record<string, unknown>,
  payload: Record<string, unknown>,
): PersistentSessionHistorySender {
  return {
    display_name: preferString(callerInfo, payload, "display_name"),
    user_id: preferString(callerInfo, payload, "user_id"),
    agent_id: preferString(callerInfo, payload, "agent_id"),
    agent_name: preferString(callerInfo, payload, "agent_name"),
    agent_node: preferString(callerInfo, payload, "agent_node"),
  };
}

function parentEventIdValue(value: unknown): string | number | null {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toKstIso(value: Date): string {
  return new Date(value.getTime() + 9 * 60 * 60 * 1000).toISOString().replace(/Z$/, "+09:00");
}

function projectModelInfo(value: unknown): PersistentSessionHistoryModelInfo | null {
  const model = record(value);
  if (!model) return null;
  return {
    model_preset: stringValue(model.model_preset),
    backend: stringValue(model.backend),
    model: stringValue(model.model),
  };
}

function preferString(preferred: Record<string, unknown>, fallback: Record<string, unknown>, key: string): string | null {
  return stringValue(preferred[key]) ?? stringValue(fallback[key]);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
