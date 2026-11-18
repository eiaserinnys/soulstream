import type { SqlClient } from "../control_plane/control_plane_types.js";
import { ConversationError } from "./conversation_types.js";
import { ConversationProjection, type Item } from "./conversation_projection.js";
import { formatPosition } from "./conversation_position.js";
import { enrichPayloads, HISTORY_PAYLOAD, sourceEvent, TYPES, type Row } from "./conversation_history_source.js";
import { ConversationHistorySnapshotStore, type CachedItem } from "./conversation_history_snapshot.js";
import type { FastifyRequest } from "fastify";

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

type Execution = { session_id: string; ordinal: number; first_input_is_initial_instruction: boolean };
type CachedExecution = { projection: ConversationProjection; lastEventId: number; persistedEventId: number; items: CachedItem[]; createdAt: number; lastUsedAt: number };
const CACHE_EXECUTIONS = 64;
const CACHE_IDLE_MS = 10 * 60_000;
const CACHE_MAX_AGE_MS = 60 * 60_000;

// payload를 고치는 이관 스크립트를 돌린 뒤에는 해당 세션의 conversation_history_snapshots 행을 지운다.
export class ConversationHistory {
  private readonly cache = new Map<string, CachedExecution>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly snapshots: ConversationHistorySnapshotStore;
  constructor(private readonly sql: SqlClient, logger: Pick<FastifyRequest["log"], "warn"> = console) {
    this.snapshots = new ConversationHistorySnapshotStore(sql, logger);
  }
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
        const saved = await this.snapshots.read(execution.session_id, execution.first_input_is_initial_instruction, max);
        entry = saved ? { ...saved, persistedEventId: saved.lastEventId, createdAt: now, lastUsedAt: now }
          : { projection: new ConversationProjection(execution.first_input_is_initial_instruction),
              lastEventId: 0, persistedEventId: 0, items: [], createdAt: now, lastUsedAt: now };
      }
      if (entry.lastEventId < max) {
        try {
          const rows = entry.lastEventId === 0
            ? await this.sql<Row[]>`SELECT id,event_type,${this.sql.unsafe(HISTORY_PAYLOAD)},created_at FROM events
              WHERE session_id=${execution.session_id} AND id <= ${max} AND event_type = ANY(${TYPES}) ORDER BY id`
            : await this.sql<Row[]>`SELECT id,event_type,${this.sql.unsafe(HISTORY_PAYLOAD)},created_at FROM events
              WHERE session_id=${execution.session_id} AND id > ${entry.lastEventId} AND id <= ${max} AND event_type = ANY(${TYPES}) ORDER BY id`;
          const payloads = await enrichPayloads(this.sql, rows.map(row => row.payload ?? {}));
          for (const [index, row] of rows.entries()) {
            const result = entry.projection.apply(sourceEvent({ ...row, payload: payloads[index]! }));
            if (result.item) entry.items.push({ eventId: row.id, item: result.item });
          }
        } catch (error) {
          this.cache.delete(key);
          throw error;
        }
      }
      entry.lastEventId = max;
      if (entry.lastEventId - entry.persistedEventId >= 1000) {
        const saved = { lastEventId: entry.lastEventId, state: entry.projection.snapshot(), items: entry.items.map(item => ({ ...item })) };
        if (await this.snapshots.write(execution.session_id, execution.first_input_is_initial_instruction, saved)) entry.persistedEventId = entry.lastEventId;
      }
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
    return (await enrichPayloads(this.sql, [payload]))[0]!;
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
