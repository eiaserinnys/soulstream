import type { SqlClient } from "../cards/control_plane/card_types.js";
import { sourceEvent } from "../conversation/conversation_history.js";
import { ConversationProjection, type Item } from "../conversation/conversation_projection.js";
import { serializeCardRow } from "../folders/folder_contracts.js";

const TYPES = ["user_message", "intervention_sent", "notification", "assistant_message", "tool_start", "tool_result", "complete", "error", "assistant_error"];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

type Row = { id: number; event_type: string; payload: Record<string, unknown> | null; created_at: Date };

type AssetRow = { id: string; original_name: string; mime_type: string };
type ReceiptUpload = { path: string; name: string; mime: string; assetId?: string };
type PathMetadata = { name: string; mime: string; assetId?: string };

type AttachmentContext = {
  nodeId: string;
  assetsById: Map<string, AssetRow>;
  pathMetadata: Map<string, PathMetadata>;
};

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", txt: "text/plain", md: "text/markdown", pdf: "application/pdf",
};

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
  const context = await loadAttachmentContext(sql, targetSessionId, sessionRow, rows);
  for (const row of rows) {
    const payload = row.payload ?? {};
    const result = projection.apply(sourceEvent({ ...row, payload: enrichPayload(payload, context) }));
    if (!result.item) continue;
    const attachments = resolveAttachmentIds(result.item.attachments, payload, context);
    items.push({
      id: String(row.id),
      kind: result.item.kind,
      role: result.item.kind === "user" ? "user" : "assistant",
      author: authorOf(result.item.kind, agentLabel),
      text: result.item.text,
      at: result.item.at,
      ...(attachments.length ? { attachments } : {}),
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
async function loadAttachmentContext(
  sql: SqlClient,
  targetSessionId: string,
  sessionRow: Record<string, unknown> | null,
  rows: Row[],
): Promise<AttachmentContext | null> {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const row of rows) {
    const payload = row.payload ?? {};
    if (Array.isArray(payload.attachment_ids)) {
      for (const value of payload.attachment_ids) {
        if (typeof value === "string" && value.length > 0) ids.add(value);
      }
    }
    for (const value of rawPathsOf(payload)) {
      if (typeof value === "string" && value.length > 0) paths.add(value);
    }
  }
  if (ids.size === 0 && paths.size === 0) return null;

  const assetIds = [...ids];
  const rawPaths = [...paths];
  const assets = assetIds.length === 0 ? [] : await sql<AssetRow[]>`SELECT id,original_name,mime_type FROM file_assets
    WHERE id = ANY(${assetIds}) AND storage_purpose = 'attachment' AND upload_status = 'committed' AND garbage_collected_at IS NULL`;
  const receipts = rawPaths.length === 0 ? []
    : await sql<Array<{ upload: ReceiptUpload }>>`SELECT upload FROM conversation_message_receipts, jsonb_array_elements(uploads) AS upload
      WHERE upload->>'path' = ANY(${rawPaths})`;

  const pathMetadata = new Map<string, PathMetadata>(
    rawPaths.map(path => [path, fileDescriptorOf(path)]),
  );
  for (const row of receipts) {
    pathMetadata.set(row.upload.path, {
      name: row.upload.name,
      mime: row.upload.mime,
      ...(row.upload.assetId ? { assetId: row.upload.assetId } : {}),
    });
  }
  let nodeId = typeof sessionRow?.node_id === "string" ? sessionRow.node_id.trim() : "";
  if (!nodeId && rawPaths.length > 0) {
    const nodeRows = await sql<Array<{ node_id: string }>>`SELECT node_id FROM sessions
      WHERE session_id=${targetSessionId} LIMIT 1`;
    nodeId = typeof nodeRows[0]?.node_id === "string" ? nodeRows[0].node_id : "";
  }
  return { nodeId, assetsById: new Map(assets.map(asset => [asset.id, asset])), pathMetadata };
}

function enrichPayload(
  payload: Record<string, unknown>,
  context: AttachmentContext | null,
): Record<string, unknown> {
  if (context === null) return payload;
  const enriched: Record<string, unknown> = { ...payload };
  if (Array.isArray(payload.attachment_ids)) {
    enriched._conversation_attachments = payload.attachment_ids.flatMap(value => {
      if (typeof value !== "string") return [];
      const asset = context.assetsById.get(value);
      return asset ? [{ id: value, name: asset.original_name, mime: asset.mime_type }] : [];
    });
  }
  const paths = rawPathsOf(payload);
  if (paths.length > 0) {
    const metadata: Record<string, PathMetadata> = {};
    for (const value of paths) {
      if (typeof value !== "string") continue;
      const saved = context.pathMetadata.get(value);
      if (saved !== undefined) metadata[value] = saved;
    }
    enriched._conversation_path_metadata = metadata;
  }
  return enriched;
}

/** Turns the projection's positional `path:<index>` ids into readable content ids. */
function resolveAttachmentIds(
  attachments: Item["attachments"],
  payload: Record<string, unknown>,
  context: AttachmentContext | null,
): Item["attachments"] {
  if (context === null) return attachments;
  const paths = rawPathsOf(payload);
  return attachments.map(attachment => {
    const match = /^path:(\d+)$/.exec(attachment.id);
    if (match === null) return attachment;
    const rawPath = paths[Number(match[1])];
    if (typeof rawPath !== "string") return attachment;
    const saved = context.pathMetadata.get(rawPath);
    return { ...attachment, id: saved?.assetId ?? `path:${context.nodeId}:${rawPath}` };
  });
}

function rawPathsOf(payload: Record<string, unknown>): unknown[] {
  return Array.isArray(payload.attachments)
    ? payload.attachments
    : Array.isArray(payload.attachment_paths)
      ? payload.attachment_paths
      : [];
}

function fileDescriptorOf(path: string): { name: string; mime: string } {
  const base = path.split(/[\\/]/).pop() ?? path;
  const name = base
    .replace(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-/, "")
    .replace(/^(.+)-[0-9a-f]{32}(\.[^.]+)?$/, "$1$2");
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return { name, mime: MIME_BY_EXTENSION[ext] ?? "application/octet-stream" };
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
