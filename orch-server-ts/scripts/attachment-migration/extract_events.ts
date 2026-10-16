import { createHash } from "node:crypto";

import {
  INVENTORY_ERROR_CODES,
  INVENTORY_EVENT_TYPES,
  INVENTORY_EVENT_PROGRESS_STATE,
  INVENTORY_SCHEMA_VERSION,
  inventoryError,
  parseInventoryCutoff,
  type EventAttachmentCandidate,
  type EventExtractionCursor,
  type EventExtractionProgress,
  type InventoryErrorCode,
  type LegacySource,
} from "./inventory_contract.js";

const STATEMENT_TIMEOUT = "5000ms";
const MANAGED_NOTE_PREFIX = "[첨부 파일 로컬 경로: ";

type SqlRow = Record<string, unknown>;
type InventorySql = {
  <T extends readonly SqlRow[] = SqlRow[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  begin<T>(callback: (transaction: InventorySql) => Promise<T>): Promise<T>;
};
type EventPageRow = {
  found_session_id: string | null;
  source_node_id: string | null;
  event_id: number | null;
  event_type?: string | null;
  attachment_payload?: unknown;
  created_at?: unknown;
};

export async function* extractSessionAttachmentSources(
  sql: InventorySql,
  sessionIds: readonly string[],
  options: {
    pageSize: number;
    cutoff: string;
    after?: EventExtractionCursor;
    onProgress?: (progress: EventExtractionProgress) => void | Promise<void>;
  },
): AsyncIterable<LegacySource> {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1) throw new TypeError("pageSize must be a positive integer");
  const cutoff = parseInventoryCutoff(options.cutoff);
  const cutoffDate = new Date(cutoff);
  const orderedSessions = [...new Set(sessionIds)];
  if (orderedSessions.some((sessionId) => typeof sessionId !== "string" || sessionId.length === 0)) {
    throw inventoryError("INVENTORY_INVALID_SOURCE", "sessionIds must contain non-empty strings");
  }
  if (options.after && (!Number.isSafeInteger(options.after.eventId) || options.after.eventId < 0 || !orderedSessions.includes(options.after.sessionId))) {
    throw inventoryError("INVENTORY_INVALID_SOURCE", "after cursor must identify a non-negative event in sessionIds");
  }

  const startIndex = options.after ? orderedSessions.indexOf(options.after.sessionId) : 0;
  for (let sessionIndex = startIndex; sessionIndex < orderedSessions.length; sessionIndex += 1) {
    const sessionId = orderedSessions[sessionIndex]!;
    const startedAt = new Date().toISOString();
    let cursor = options.after && sessionIndex === startIndex
      ? { ...options.after }
      : { sessionId, eventId: 0 };

    while (true) {
      const page = await readEventPage(sql, sessionId, cursor.eventId, cutoffDate, options.pageSize);
      if (page.length === 0 || page.some((row) => row.found_session_id === null)) {
        await reportProgress(options.onProgress, {
          session_id: sessionId,
          state: INVENTORY_EVENT_PROGRESS_STATE.source_changed,
          cursor,
          coverage_complete: false,
          started_at: startedAt,
          observed_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
          error_code: INVENTORY_ERROR_CODES.source_changed,
        });
        break;
      }
      if (page.some((row) => row.found_session_id !== sessionId)) {
        throw inventoryError(INVENTORY_ERROR_CODES.source_changed, `event page session changed for ${sessionId}`);
      }

      const events = page.filter((row) => row.event_id !== null);
      for (const row of events) {
        const eventId = readEventId(row.event_id);
        if (eventId <= cursor.eventId) throw eventShapeError(sessionId, eventId, "event id did not advance the cursor");
        const createdAt = readCreatedAt(row.created_at, sessionId, eventId);
        if (createdAt.getTime() > cutoffDate.getTime()) throw eventShapeError(sessionId, eventId, "database returned an event after cutoff");
        const eventType = row.event_type;
        if (typeof eventType !== "string") throw eventShapeError(sessionId, eventId, "event type must be text");
        if (isSupportedEventType(eventType)) {
          const candidates = collectEventAttachmentCandidates(row.attachment_payload, sessionId, eventId);
          if (candidates.length > 0) {
            yield {
              schema_version: INVENTORY_SCHEMA_VERSION,
              source_kind: "message",
              source_table: "events",
              source_pk: String(eventId),
              source_pointer: "/payload",
              row_sha256: sha256(stableJson({ session_id: sessionId, event_id: eventId, event_type: eventType, payload: row.attachment_payload, created_at: createdAt.toISOString() })),
              created_at: createdAt.toISOString(),
              changed_after_cutoff: false,
              session_id: sessionId,
              data: {
                event_id: eventId,
                event_type: eventType,
                source_node_id: row.source_node_id,
                attachment_candidates: candidates,
              },
            };
          }
        }
        cursor = { sessionId, eventId };
      }

      if (events.length > 0) {
        await reportProgress(options.onProgress, {
          session_id: sessionId,
          state: INVENTORY_EVENT_PROGRESS_STATE.page,
          cursor,
          coverage_complete: false,
          started_at: startedAt,
          observed_at: new Date().toISOString(),
        });
      }
      if (events.length < options.pageSize) {
        await reportProgress(options.onProgress, {
          session_id: sessionId,
          state: INVENTORY_EVENT_PROGRESS_STATE.complete,
          cursor,
          coverage_complete: true,
          started_at: startedAt,
          observed_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
        });
        break;
      }
    }
  }
}

function collectEventAttachmentCandidates(payload: unknown, sessionId: string, eventId: number): EventAttachmentCandidate[] {
  if (payload === null || payload === undefined) return [];
  if (!isRecord(payload)) throw eventShapeError(sessionId, eventId, "supported event payload must be an object");
  const candidates: EventAttachmentCandidate[] = [];
  const pathValues = new Set<string>();
  addAttachmentValues(payload.attachments, "/payload/attachments", candidates, pathValues, sessionId, eventId);
  addStringArray(payload.attachment_paths, "/payload/attachment_paths", "input_path", candidates, pathValues, sessionId, eventId);
  addStringArray(payload.attachment_ids, "/payload/attachment_ids", "attachment_id", candidates, undefined, sessionId, eventId);
  addExplicitDescriptor(payload.attachment_descriptor, "/payload/attachment_descriptor", candidates, sessionId, eventId);
  addExplicitDescriptor(payload.output_descriptor, "/payload/output_descriptor", candidates, sessionId, eventId);
  addExplicitDescriptors(payload.attachment_descriptors, "/payload/attachment_descriptors", candidates, sessionId, eventId);
  addExplicitDescriptors(payload.output_descriptors, "/payload/output_descriptors", candidates, sessionId, eventId);
  for (const [index, path] of trailingManagedPathNotes(payload.text).entries()) {
    candidates.push({
      pointer: `/payload/text/managed_path_notes/${index}`,
      kind: "managed_path_note",
      value: path,
      verified: pathValues.has(path),
    });
  }
  return candidates;
}

function addAttachmentValues(
  value: unknown,
  pointer: string,
  candidates: EventAttachmentCandidate[],
  paths: Set<string>,
  sessionId: string,
  eventId: number,
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) throw eventShapeError(sessionId, eventId, `${pointer} must be an array`);
  value.forEach((item, index) => {
    const itemPointer = `${pointer}/${index}`;
    if (typeof item === "string" && item.length > 0) {
      paths.add(item);
      candidates.push({ pointer: itemPointer, kind: "input_path", value: item });
      return;
    }
    if (isRecord(item) && typeof item.attachment_id === "string" && item.attachment_id.length > 0) {
      candidates.push({ pointer: itemPointer, kind: "output_descriptor", value: item });
      return;
    }
    throw eventShapeError(sessionId, eventId, `${itemPointer} must be a path or attachment descriptor`);
  });
}

function addStringArray(
  value: unknown,
  pointer: string,
  kind: "input_path" | "attachment_id",
  candidates: EventAttachmentCandidate[],
  paths: Set<string> | undefined,
  sessionId: string,
  eventId: number,
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw eventShapeError(sessionId, eventId, `${pointer} must be a non-empty string array`);
  }
  value.forEach((item, index) => {
    if (kind === "input_path") paths?.add(item as string);
    candidates.push({ pointer: `${pointer}/${index}`, kind, value: item as string });
  });
}

function addExplicitDescriptor(value: unknown, pointer: string, candidates: EventAttachmentCandidate[], sessionId: string, eventId: number): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value) || typeof value.attachment_id !== "string" || value.attachment_id.length === 0) {
    throw eventShapeError(sessionId, eventId, `${pointer} must be an attachment descriptor`);
  }
  candidates.push({ pointer, kind: "output_descriptor", value });
}

function addExplicitDescriptors(value: unknown, pointer: string, candidates: EventAttachmentCandidate[], sessionId: string, eventId: number): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) throw eventShapeError(sessionId, eventId, `${pointer} must be an array`);
  value.forEach((entry, index) => addExplicitDescriptor(entry, `${pointer}/${index}`, candidates, sessionId, eventId));
}

function trailingManagedPathNotes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const lines = value.split(/\r?\n/);
  const notes: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith(MANAGED_NOTE_PREFIX) || !line.endsWith("]")) break;
    const path = line.slice(MANAGED_NOTE_PREFIX.length, -1);
    if (path.length === 0) break;
    notes.unshift(path);
  }
  return notes;
}

async function readEventPage(sql: InventorySql, sessionId: string, afterEventId: number, cutoff: Date, pageSize: number): Promise<EventPageRow[]> {
  try {
    return await sql.begin(async (transaction) => {
      await transaction`SET TRANSACTION READ ONLY`;
      await transaction`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`;
      return await transaction<EventPageRow[]>`
        SELECT requested.session_id AS requested_session_id,
          source_session.session_id AS found_session_id,
          source_session.node_id AS source_node_id,
          event_page.id AS event_id,
          event_page.event_type,
          event_page.attachment_payload,
          event_page.created_at
        FROM (VALUES (${sessionId}::text)) AS requested(session_id)
        LEFT JOIN sessions AS source_session ON source_session.session_id = requested.session_id
        LEFT JOIN LATERAL (
          SELECT id, event_type,
            CASE WHEN event_type = ANY(${[...INVENTORY_EVENT_TYPES]}::text[]) THEN payload END AS attachment_payload,
            created_at
          FROM events
          WHERE session_id = requested.session_id AND id > ${afterEventId} AND created_at <= ${cutoff}
          ORDER BY id LIMIT ${pageSize}
        ) AS event_page ON TRUE
      `;
    });
  } catch (error) {
    if (isInventoryError(error)) throw error;
    if (isQueryTimeout(error)) throw inventoryError(INVENTORY_ERROR_CODES.query_timeout, `event page query timed out for ${sessionId}`, error);
    throw inventoryError("INVENTORY_DB_READ_FAILED", `event page query failed for ${sessionId}`, error);
  }
}

async function reportProgress(
  callback: ((progress: EventExtractionProgress) => void | Promise<void>) | undefined,
  progress: EventExtractionProgress,
): Promise<void> {
  await callback?.(progress);
}

function readEventId(value: unknown): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id) || id < 0) throw eventShapeError("unknown", -1, "event id must be a non-negative integer");
  return id;
}

function readCreatedAt(value: unknown, sessionId: string, eventId: number): Date {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) throw eventShapeError(sessionId, eventId, "created_at must be a valid timestamp");
  return date;
}

function eventShapeError(sessionId: string, eventId: number, detail: string): Error & { code: InventoryErrorCode } {
  return inventoryError(INVENTORY_ERROR_CODES.event_shape_invalid, `invalid event ${sessionId}/${eventId}: ${detail}`);
}

function isSupportedEventType(eventType: string): boolean {
  return (INVENTORY_EVENT_TYPES as readonly string[]).includes(eventType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQueryTimeout(error: unknown): boolean {
  return isRecord(error) && error.code === "57014";
}

function isInventoryError(error: unknown): error is Error & { code: InventoryErrorCode } {
  return isRecord(error) && typeof error.code === "string" && [
    "INVENTORY_INVALID_SOURCE",
    "INVENTORY_AMBIGUOUS_URL",
    "INVENTORY_DB_READ_FAILED",
    ...Object.values(INVENTORY_ERROR_CODES),
  ].includes(error.code);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
