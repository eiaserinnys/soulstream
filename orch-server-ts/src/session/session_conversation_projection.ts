import type { SqlClient } from "../cards/control_plane/card_types.js";
import { sourceEvent } from "../conversation/conversation_history.js";
import { ConversationProjection, type Item } from "../conversation/conversation_projection.js";
import { serializeCardRow } from "../folders/folder_contracts.js";

const TYPES = ["user_message", "intervention_sent", "notification", "assistant_message", "tool_start", "tool_result", "complete", "error", "assistant_error"];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

type Row = { id: number; event_type: string; payload: Record<string, unknown> | null; created_at: Date };

export type CardSessionMessage = {
  id: string;
  kind: Item["kind"];
  role: "user" | "assistant";
  author: string;
  text: string;
  at: string;
  attachments?: Item["attachments"];
};

export type CardSessionMessages = {
  sessionId: string | null;
  session: Record<string, unknown> | null;
  busy: boolean;
  tool: string | null;
  items: CardSessionMessage[];
};

export async function readSessionConversation(
  sql: SqlClient, targetSessionId: string, sessionRow: Record<string, unknown> | null,
  fallbackAgentId: string | null, limit?: number | string | null,
): Promise<CardSessionMessages> {
  const rows = await sql<Row[]>`SELECT id,event_type,payload,created_at FROM events
    WHERE session_id=${targetSessionId} AND event_type = ANY(${TYPES}) ORDER BY id`;
  const agentLabel = labelOf(sessionRow, fallbackAgentId);
  const projection = new ConversationProjection(false);
  const items: CardSessionMessage[] = [];
  for (const row of rows) {
    const result = projection.apply(sourceEvent(row));
    if (!result.item) continue;
    items.push({
      id: String(row.id),
      kind: result.item.kind,
      role: result.item.kind === "user" ? "user" : "assistant",
      author: authorOf(result.item.kind, agentLabel),
      text: result.item.text,
      at: result.item.at,
      ...(result.item.attachments.length ? { attachments: result.item.attachments } : {}),
    });
  }
  const activity = projection.activity();
  return {
    sessionId: targetSessionId,
    session: sessionRow ? serializeCardRow(sessionRow) : null,
    busy: activity.busy,
    tool: activity.tool,
    items: items.slice(-limitOf(limit)),
  };
}
function labelOf(sessionRow: Record<string, unknown> | null, fallback: string | null): string {
  const displayName = typeof sessionRow?.display_name === "string" ? sessionRow.display_name.trim() : "";
  const agentId = typeof sessionRow?.agent_id === "string" ? sessionRow.agent_id.trim() : "";
  return displayName || agentId || fallback?.trim() || "에이전트";
}

function authorOf(kind: Item["kind"], agentLabel: string): string {
  if (kind === "user") return "사용자";
  if (kind === "error") return "오류";
  if (kind === "notice") return "알림";
  return agentLabel;
}

function limitOf(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(parsed)));
}
