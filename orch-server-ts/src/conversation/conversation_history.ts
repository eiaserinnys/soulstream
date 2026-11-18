import type { SqlClient } from "../control_plane/control_plane_types.js";
import { ConversationError } from "./conversation_types.js";
import { ConversationProjection, type Item, type SourceEvent } from "./conversation_projection.js";
import { formatPosition } from "./conversation_position.js";

/**
 * Only the fields this projection reads. Callers that hold a full conversation
 * `Binding` still pass it; read-only views (the external access link history)
 * need not fabricate the rest.
 */
export type ConversationHistorySource = {
  session_id: string;
  first_input_is_initial_instruction: boolean;
  creation_request?: { initial_instruction?: string | null } | null;
  notices?: ReadonlyArray<{ id: string; text: string; at: string }>;
};

type Row = { id: number; event_type: string; payload: Record<string, unknown> | null; created_at: Date };
type Execution = { session_id: string; ordinal: number; first_input_is_initial_instruction: boolean };
type CachedItem = { eventId: number; item: Item };
type CachedExecution = { projection: ConversationProjection; lastEventId: number; items: CachedItem[]; createdAt: number; lastUsedAt: number };
const TYPES = ["user_message", "intervention_sent", "notification", "assistant_message", "tool_start", "tool_result", "complete", "error", "assistant_error"];
const CACHE_EXECUTIONS = 64;
const CACHE_IDLE_MS = 10 * 60_000;
const CACHE_MAX_AGE_MS = 60 * 60_000;

// complete는 항목 없이 턴을 끝내고, tool_result는 본문 없이 활동 상태만 바꾼다.
// tool_result의 키를 읽지 않아야 큰 TOAST payload를 불러오지 않는다.
const HISTORY_PAYLOAD = `CASE
  WHEN event_type IN ('complete', 'tool_result') THEN '{}'::jsonb
  WHEN event_type = 'tool_start' THEN jsonb_strip_nulls(jsonb_build_object(
    'tool_name', payload->'tool_name', 'input_id', payload->'input_id', 'inputId', payload->'inputId',
    'prepared_input_id', payload->'prepared_input_id', 'preparedInputId', payload->'preparedInputId'))
  ELSE payload END AS payload`;

// 손으로 돌리는 이관 스크립트(attachment-migration/backfill_message_refs.ts, omit-inline-image-data.ts)는
// 이미 들어간 이벤트의 payload를 바꾸지만 예외로 둔다. 그 결과는 캐시 만료(최대 60분) 뒤 반영된다.
export class ConversationHistory {
  private readonly cache = new Map<string, CachedExecution>();
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly sql: SqlClient) {}
  async load(binding: ConversationHistorySource) {
    const executions = await this.sql<Execution[]>`
      SELECT session_id,ordinal,first_input_is_initial_instruction FROM conversation_executions
      WHERE thread_id=${binding.session_id} AND phase='complete' ORDER BY ordinal`;
    if (!executions.length) executions.push({session_id:binding.session_id, ordinal:0,
      first_input_is_initial_instruction:binding.first_input_is_initial_instruction || Boolean(binding.creation_request?.initial_instruction?.length)});
    const loaded: Array<{ execution: Execution; entry: CachedExecution }> = [];
    for (const execution of executions) loaded.push({ execution, entry: await this.loadExecution(execution) });
    const items: Array<{ position: string; item: Item; session: string }> = (binding.notices ?? []).map(n => ({
      position: "0", session: binding.session_id, item: { id:n.id, kind:"notice", text:n.text, at:n.at, attachments:[] },
    }));
    for (const { execution, entry } of loaded) {
      for (const cached of entry.items) {
        const position = formatPosition(execution.ordinal, cached.eventId);
        items.push({ position, session: execution.session_id, item: { ...cached.item, id: position } });
      }
    }
    const last = loaded.at(-1)!;
    return { cursor: formatPosition(last.execution.ordinal, last.entry.lastEventId),
      projection: last.entry.projection.clone(), items, active: executions.at(-1)! };
  }
  private async loadExecution(execution: Execution): Promise<CachedExecution> {
    const key = cacheKey(execution);
    return await this.locked(key, async () => {
      const [watermark] = await this.sql<Array<{ id: number }>>`SELECT COALESCE(MAX(id), 0)::int AS id FROM events WHERE session_id=${execution.session_id}`;
      const max = watermark?.id ?? 0;
      const now = Date.now();
      let entry = this.cache.get(key);
      if (entry && (expired(entry, now) || entry.lastEventId > max)) { this.cache.delete(key); entry = undefined; }
      if (!entry) {
        entry = { projection: new ConversationProjection(execution.first_input_is_initial_instruction),
          lastEventId: 0, items: [], createdAt: now, lastUsedAt: now };
      }
      if (entry.lastEventId < max) {
        try {
          const rows = entry.lastEventId === 0
            ? await this.sql<Row[]>`SELECT id,event_type,${this.sql.unsafe(HISTORY_PAYLOAD)},created_at FROM events
              WHERE session_id=${execution.session_id} AND id <= ${max} AND event_type = ANY(${TYPES}) ORDER BY id`
            : await this.sql<Row[]>`SELECT id,event_type,${this.sql.unsafe(HISTORY_PAYLOAD)},created_at FROM events
              WHERE session_id=${execution.session_id} AND id > ${entry.lastEventId} AND id <= ${max} AND event_type = ANY(${TYPES}) ORDER BY id`;
          for (const row of rows) {
            row.payload = await this.enrichPayload(row.payload ?? {});
            const result = entry.projection.apply(sourceEvent(row));
            if (result.item) entry.items.push({ eventId: row.id, item: result.item });
          }
        } catch (error) {
          this.cache.delete(key);
          throw error;
        }
      }
      entry.lastEventId = max;
      this.remember(key, entry);
      return entry;
    });
  }
  private remember(key: string, entry: CachedExecution): void {
    const now = Date.now();
    entry.lastUsedAt = now;
    this.cache.delete(key);
    this.cache.set(key, entry);
    for (const [candidate, value] of this.cache) if (expired(value, now)) this.cache.delete(candidate);
    while (this.cache.size > CACHE_EXECUTIONS) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
  private async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    try { return await action(); }
    finally { release(); if (this.locks.get(key) === tail) this.locks.delete(key); }
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
  async items(binding: ConversationHistorySource, before: string | undefined, limit: number) {
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
function expired(entry: CachedExecution, now: number): boolean {
  return now - entry.lastUsedAt >= CACHE_IDLE_MS || now - entry.createdAt >= CACHE_MAX_AGE_MS;
}
function cacheKey(execution: Execution): string {
  return `${execution.session_id}\u0000${execution.first_input_is_initial_instruction ? 1 : 0}`;
}
export function sourceEvent(row: Row): SourceEvent {
  const payload = row.payload ?? {};
  const raw = payload.timestamp;
  const date = typeof raw === "number" ? new Date(raw < 10_000_000_000 ? raw * 1000 : raw)
    : typeof raw === "string" ? new Date(raw) : new Date(row.created_at);
  return { id: row.id, type: row.event_type, at: Number.isFinite(date.getTime()) ? date.toISOString() : new Date(row.created_at).toISOString(), payload };
}
