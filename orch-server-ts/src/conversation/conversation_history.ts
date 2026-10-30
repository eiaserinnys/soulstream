import type { SqlClient } from "../control_plane/control_plane_types.js";
import { ConversationError, type Binding } from "./conversation_types.js";
import { ConversationProjection, type Item, type SourceEvent } from "./conversation_projection.js";
import { formatPosition } from "./conversation_position.js";

type Row = { id: number; event_type: string; payload: Record<string, unknown> | null; created_at: Date };
const TYPES = ["user_message", "intervention_sent", "notification", "assistant_message", "tool_start", "tool_result", "complete", "error", "assistant_error"];
export class ConversationHistory {
  constructor(private readonly sql: SqlClient) {}
  async load(binding: Binding) {
    const executions = await this.sql<Array<{ session_id: string; ordinal: number; first_input_is_initial_instruction: boolean }>>`
      SELECT session_id,ordinal,first_input_is_initial_instruction FROM conversation_executions
      WHERE thread_id=${binding.session_id} AND phase='complete' ORDER BY ordinal`;
    if (!executions.length) executions.push({session_id:binding.session_id, ordinal:0,
      first_input_is_initial_instruction:binding.first_input_is_initial_instruction || Boolean(binding.creation_request?.initial_instruction?.length)});
    const items: Array<{ position: string; item: Item; session: string }> = binding.notices.map(n => ({
      position: "0", session: binding.session_id, item: { id:n.id, kind:"notice", text:n.text, at:n.at, attachments:[] },
    }));
    let cursor = "0";
    let projection = new ConversationProjection(false);
    for (const execution of executions) {
      const [watermark] = await this.sql<Array<{ id: number }>>`SELECT COALESCE(MAX(id), 0)::int AS id FROM events WHERE session_id=${execution.session_id}`;
      const max = watermark?.id ?? 0;
      cursor = formatPosition(execution.ordinal, max);
      const rows = await this.sql<Row[]>`SELECT id,event_type,payload,created_at FROM events
        WHERE session_id=${execution.session_id} AND id <= ${max} AND event_type = ANY(${TYPES}) ORDER BY id`;
      projection = new ConversationProjection(execution.first_input_is_initial_instruction);
      for (const row of rows) {
        row.payload = await this.enrichPayload(row.payload ?? {});
        const result = projection.apply(sourceEvent(row));
        if (result.item) {
          const position = formatPosition(execution.ordinal, row.id);
          items.push({ position, session:execution.session_id, item:{...result.item, id:position} });
        }
      }
    }
    return { cursor, projection, items, active:executions.at(-1)! };
  }

  async enrichPayload(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ids = Array.isArray(payload.attachment_ids) ? payload.attachment_ids.filter((x): x is string => typeof x === "string") : [];
    const rawPaths = Array.isArray(payload.attachments) ? payload.attachments : Array.isArray(payload.attachment_paths) ? payload.attachment_paths : [];
    const paths = rawPaths.filter((x): x is string => typeof x === "string");
    const saved = paths.length ? await this.sql<Array<{ upload: {path:string; name:string; mime:string; assetId?:string} }>>`
      SELECT upload FROM conversation_message_receipts, jsonb_array_elements(uploads) AS upload
      WHERE upload->>'path' = ANY(${paths})` : [];
    const pathMetadata = Object.fromEntries(saved.map(row => [row.upload.path, row.upload]));
    if (!ids.length) return { ...payload, _conversation_path_metadata: pathMetadata };
    const assets = await this.sql<Array<{ id: string; original_name: string; mime_type: string }>>`
      SELECT id,original_name,mime_type FROM file_assets
      WHERE id = ANY(${ids}) AND storage_purpose = 'attachment' AND upload_status = 'committed' AND garbage_collected_at IS NULL`;
    const byId = new Map(assets.map(asset => [asset.id, asset]));
    return { ...payload, _conversation_path_metadata: pathMetadata, _conversation_attachments: ids.flatMap(id => {
      const asset = byId.get(id);
      return asset ? [{ id, name: asset.original_name, mime: asset.mime_type }] : [];
    }) };
  }
  async items(binding: Binding, before: string | undefined, limit: number) {
    const history = await this.load(binding);
    let end = history.items.length;
    if (before !== undefined) {
      end = history.items.findIndex(x => x.item.id === before);
      if (end < 0) throw new ConversationError(400, "invalid_request", "Invalid before cursor");
    }
    const start = Math.max(0, end - limit);
    const slice = history.items.slice(start, end);
    return { items: slice.map(x => x.item), ...(start > 0 ? { next_before: slice[0]!.item.id } : {}), cursor: history.cursor };
  }
}
export function sourceEvent(row: Row): SourceEvent {
  const payload = row.payload ?? {};
  const raw = payload.timestamp;
  const date = typeof raw === "number" ? new Date(raw < 10_000_000_000 ? raw * 1000 : raw)
    : typeof raw === "string" ? new Date(raw) : new Date(row.created_at);
  return { id: row.id, type: row.event_type, at: Number.isFinite(date.getTime()) ? date.toISOString() : new Date(row.created_at).toISOString(), payload };
}
