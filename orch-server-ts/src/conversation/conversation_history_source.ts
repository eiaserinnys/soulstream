import type { SqlClient } from "../control_plane/control_plane_types.js";
import type { SourceEvent } from "./conversation_projection.js";

export const CONVERSATION_HISTORY_PROJECTION_VERSION = 2;
export const CONVERSATION_HISTORY_PROJECTION_FINGERPRINT = "70534f9e1f487c868a2391a0cca5b1cd327714300b543a123f441f4c319ed97a";

export type Row = { id: number; event_type: string; payload: Record<string, unknown> | null; created_at: Date };
export const TYPES = ["user_message", "intervention_sent", "notification", "assistant_message", "tool_start", "tool_result", "complete", "error", "assistant_error"];

// complete는 항목 없이 턴을 끝내고, tool_result는 본문 없이 활동 상태만 바꾼다.
// tool_result의 키를 읽지 않아야 큰 TOAST payload를 불러오지 않는다.
export const HISTORY_PAYLOAD = `CASE
  WHEN event_type IN ('complete', 'tool_result') THEN '{}'::jsonb
  WHEN event_type = 'tool_start' THEN jsonb_strip_nulls(jsonb_build_object(
    'tool_name', payload->'tool_name', 'input_id', payload->'input_id', 'inputId', payload->'inputId',
    'prepared_input_id', payload->'prepared_input_id', 'preparedInputId', payload->'preparedInputId'))
  ELSE payload END AS payload`;

export function sourceEvent(row: Row): SourceEvent {
  const payload = row.payload ?? {};
  const raw = payload.timestamp;
  const date = typeof raw === "number" ? new Date(raw < 10_000_000_000 ? raw * 1000 : raw)
    : typeof raw === "string" ? new Date(raw) : new Date(row.created_at);
  return { id: row.id, type: row.event_type, at: Number.isFinite(date.getTime()) ? date.toISOString() : new Date(row.created_at).toISOString(), payload };
}

export async function enrichPayloads(sql: SqlClient, payloads: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const inputs = payloads.map(payload => {
    const ids = Array.isArray(payload.attachment_ids) ? payload.attachment_ids.filter((x): x is string => typeof x === "string") : [];
    const rawPaths = Array.isArray(payload.attachments) ? payload.attachments : Array.isArray(payload.attachment_paths) ? payload.attachment_paths : [];
    return { payload, ids, paths: rawPaths.filter((x): x is string => typeof x === "string") };
  });
  const paths = [...new Set(inputs.flatMap(input => input.paths))];
  const ids = [...new Set(inputs.flatMap(input => input.ids))];
  const saved = paths.length ? await sql<Array<{ upload: {path:string; name:string; mime:string; assetId?:string} }>>`
    SELECT upload FROM conversation_message_receipts, jsonb_array_elements(uploads) AS upload
    WHERE upload->>'path' = ANY(${paths})` : [];
  const assets = ids.length ? await sql<Array<{ id: string; original_name: string; mime_type: string }>>`
    SELECT id,original_name,mime_type FROM file_assets
    WHERE id = ANY(${ids}) AND storage_purpose = 'attachment' AND upload_status = 'committed' AND garbage_collected_at IS NULL` : [];
  const byPath = new Map(saved.map(row => [row.upload.path, row.upload]));
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return inputs.map(input => {
    const metadata = Object.fromEntries(input.paths.flatMap(path => {
      const upload = byPath.get(path);
      return upload ? [[path, upload]] : [];
    }));
    if (!input.ids.length) return { ...input.payload, _conversation_path_metadata: metadata };
    const attachments = [...new Set(input.ids)].flatMap(id => {
      const asset = byId.get(id);
      return asset ? [{ id, name: asset.original_name, mime: asset.mime_type }] : [];
    });
    return { ...input.payload, _conversation_path_metadata: metadata, _conversation_attachments: attachments };
  });
}
