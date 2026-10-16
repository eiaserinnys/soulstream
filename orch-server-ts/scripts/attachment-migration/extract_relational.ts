import { createHash } from "node:crypto";
import { normalizeAttachmentLegacyPath } from "../../src/attachments/attachment_read_service.js";
import {
  INVENTORY_SCHEMA_VERSION,
  inventoryError,
  parseInventoryCutoff,
  type InventoryErrorCode,
  type LegacySource,
  type LegacySourceKind,
  type LegacyTarget,
  type RelationalSourceTable,
} from "./inventory_contract.js";

const STATEMENT_TIMEOUT = "5000ms";
const FILE_ROUTE = "/api/attachments/files";

type SqlRow = Record<string, unknown>;
type InventorySql = {
  <T extends readonly SqlRow[] = SqlRow[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  begin<T>(callback: (transaction: InventorySql) => Promise<T>): Promise<T>;
};

type TablePage = { rows: SqlRow[]; nextCursor: string | null };
type TableReader = (sql: InventorySql, cutoff: Date, after: string | null, pageSize: number) => Promise<SqlRow[]>;

const READERS: ReadonlyArray<{ table: RelationalSourceTable; readPage: TableReader }> = [
  { table: "cards", readPage: readCardsPage },
  { table: "card_reports", readPage: readReportsPage },
  { table: "card_comments", readPage: readCommentsPage },
  { table: "folder_operations", readPage: readOperationsPage },
  { table: "file_assets", readPage: readAssetsPage },
  { table: "board_items", readPage: readBoardItemsPage },
];

export async function* extractRelationalSources(
  sql: InventorySql,
  options: { pageSize: number; cutoff: string },
): AsyncIterable<LegacySource> {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1) throw new TypeError("pageSize must be a positive integer");
  const cutoff = parseInventoryCutoff(options.cutoff);
  const cutoffDate = new Date(cutoff);

  for (const reader of READERS) {
    let after: string | null = null;
    while (true) {
      const page = await readPage(sql, (tx) => reader.readPage(tx, cutoffDate, after, options.pageSize));
      if (page.length === 0) break;
      for (const row of page) {
        const createdAt = readDate(row, "created_at", reader.table);
        if (createdAt > cutoffDate.getTime()) {
          throw inventoryError("INVENTORY_INVALID_SOURCE", `database returned ${reader.table} row after cutoff`);
        }
        for (const source of makeSources(reader.table, row, cutoffDate.getTime())) yield source;
      }
      after = readString(page[page.length - 1]!, "id", reader.table);
      if (page.length < options.pageSize) break;
    }
  }
}

export function collectLegacySourceTargets(
  source: LegacySource,
  options: { allowedOrigins?: readonly string[] } = {},
): LegacyTarget[] {
  if (!isRecord(source.data)) throw inventoryError("INVENTORY_INVALID_SOURCE", "source data must be an object");
  const targets: LegacyTarget[] = [];
  const addBody = (body: unknown, format: unknown, pointer: string): void => {
    if (body === undefined || body === null) return;
    if (typeof body !== "string") throw inventoryError("INVENTORY_INVALID_SOURCE", `${pointer} must be text`);
    const actualFormat = format === "html" ? "html" : "markdown";
    const rawTargets = actualFormat === "html" ? htmlTargets(body) : [...markdownTargets(body), ...htmlTargets(body)];
    for (const target of rawTargets) {
      const parsed = classifyTarget(target.raw, options.allowedOrigins ?? []);
      if (parsed === null) continue;
      targets.push(withPointer(parsed, pointer, target.offset));
    }
  };
  const addEvidence = (value: unknown, pointer: string): void => {
    if (value === undefined || value === null) return;
    if (!Array.isArray(value)) throw inventoryError("INVENTORY_INVALID_SOURCE", `${pointer} must be an array`);
    value.forEach((entry, index) => {
      if (!isRecord(entry)) throw inventoryError("INVENTORY_INVALID_SOURCE", `${pointer}/${index} must be an object`);
      if (typeof entry.url === "string") {
        const parsed = classifyTarget(entry.url, options.allowedOrigins ?? []);
        if (parsed !== null) targets.push(withPointer(parsed, `${pointer}/${index}/url`, null));
      }
    });
  };

  if (source.source_kind === "card_request") {
    const attachments = source.data.attachments;
    if (attachments !== undefined) {
      if (!Array.isArray(attachments)) throw inventoryError("INVENTORY_INVALID_SOURCE", "cards.attachments must be an array");
      attachments.forEach((entry, index) => {
        const pointer = `/attachments/${index}`;
        if (!isRecord(entry)) throw inventoryError("INVENTORY_INVALID_SOURCE", `${pointer} must be an object`);
        const nodeId = typeof entry.nodeId === "string" ? entry.nodeId : "";
        const path = typeof entry.path === "string" ? entry.path : "";
        if (nodeId.length === 0 || path.length === 0) {
          targets.push({ pointer, raw_path: path, classification: "ambiguous_url", reason: "invalid_structured_attachment" });
          return;
        }
        targets.push({ pointer: `${pointer}/path`, raw_path: path, legacy_node_id: nodeId,
          normalized_path: normalizeAttachmentLegacyPath(path), classification: "legacy_path" });
      });
    }
    addBody(source.data.request, "markdown", "/request");
  } else if (source.source_kind === "card_item") {
    if (source.data.items !== undefined && !Array.isArray(source.data.items))
      throw inventoryError("INVENTORY_INVALID_SOURCE", "cards.items must be an array");
    for (const [index, item] of (source.data.items as unknown[] | undefined ?? []).entries()) {
      if (!isRecord(item)) throw inventoryError("INVENTORY_INVALID_SOURCE", `/items/${index} must be an object`);
      addEvidence(item.evidence, `/items/${index}/evidence`);
      addBody(item.result, "markdown", `/items/${index}/result`);
      addBody(item.caveat, "markdown", `/items/${index}/caveat`);
    }
  } else if (source.source_kind === "report" || source.source_kind === "comment" || source.source_kind === "note") {
    addBody(source.data.body, source.data.format, "/body");
  } else if (source.source_kind === "item_history") {
    if (!isRecord(source.data.payload_json)) throw inventoryError("INVENTORY_INVALID_SOURCE", "folder_operations.payload_json must be an object");
    const payload = source.data.payload_json;
    addEvidence(payload.evidence, "/payload_json/evidence");
    addBody(payload.result, "markdown", "/payload_json/result");
    addBody(payload.caveat, "markdown", "/payload_json/caveat");
    if (payload.attachments !== undefined) {
      const synthetic = { ...source, source_kind: "card_request" as const, data: { attachments: payload.attachments } };
      targets.push(...collectLegacySourceTargets(synthetic, options).map((target) => ({
        ...target,
        pointer: target.pointer.replace(/^\/attachments/, "/payload_json/attachments"),
      })));
    }
    if (typeof payload.request === "string") addBody(payload.request, "markdown", "/payload_json/request");
    if (Array.isArray(payload.items)) {
      const synthetic = { ...source, source_kind: "card_item" as const, data: { items: payload.items } };
      targets.push(...collectLegacySourceTargets(synthetic, options).map((target) => ({
        ...target,
        pointer: target.pointer.replace(/^\/(?:items|attachments)/, "/payload_json$&"),
      })));
    }
  }
  return targets;
}

function makeSources(table: RelationalSourceTable, row: SqlRow, cutoffMs: number): LegacySource[] {
  const id = readString(row, "id", table);
  const createdAt = readDate(row, "created_at", table);
  const updatedAt = table === "cards" || table === "file_assets" || table === "board_items"
    ? readDate(row, "updated_at", table)
    : null;
  const common = {
    schema_version: INVENTORY_SCHEMA_VERSION,
    source_table: table,
    source_pk: id,
    row_sha256: sha256(stableJson(row)),
    created_at: new Date(createdAt).toISOString(),
    ...(updatedAt === null ? {} : { updated_at: new Date(updatedAt).toISOString() }),
    changed_after_cutoff: updatedAt !== null && updatedAt > cutoffMs,
  } as const;

  if (table === "cards") {
    const attachments = requireArray(row.attachments, "cards.attachments");
    const items = requireArray(row.items, "cards.items");
    const request = readText(row, "request", table);
    const cardId = readString(row, "id", table);
    const ownerData = pick(row, ["folder_id", "node_id", "created_session_id", "updated_session_id", "assignee_session_id", "assignee_user_id"]);
    return [
      { ...common, source_kind: "card_request", source_pointer: "/", card_id: cardId,
        data: { ...ownerData, request, attachments } },
      { ...common, source_kind: "card_item", source_pointer: "/items", card_id: cardId,
        data: { ...ownerData, items } },
    ];
  }
  if (table === "card_reports") {
    return [{ ...common, source_kind: "report", source_pointer: "/body", source_table: table,
      card_id: readNullableString(row, "card_id", table), session_id: readNullableString(row, "session_id", table),
      data: { title: readString(row, "title", table), format: readFormat(row.format), body: readString(row, "body", table) } }];
  }
  if (table === "card_comments") {
    const kind = readString(row, "kind", table);
    if (kind !== "comment" && kind !== "spoken" && kind !== "note")
      throw inventoryError("INVENTORY_INVALID_SOURCE", "card_comments.kind is invalid");
    const sourceKind: LegacySourceKind = kind === "note" ? "note" : "comment";
    return [{ ...common, source_kind: sourceKind, source_pointer: "/body", source_table: table,
      card_id: readNullableString(row, "card_id", table), session_id: readNullableString(row, "session_id", table),
      data: { kind, author_kind: readString(row, "author_kind", table), author_id: readNullableString(row, "author_id", table),
        body: readString(row, "body", table), attachment_refs: requireArray(row.attachment_refs, "card_comments.attachment_refs") } }];
  }
  if (table === "folder_operations") {
    const payload = requireRecord(row.payload_json, "folder_operations.payload_json");
    return [{ ...common, source_kind: "item_history", source_pointer: "/payload_json", source_table: table,
      card_id: row.target_kind === "card" ? readNullableString(row, "target_id", table) : null,
      session_id: readNullableString(row, "actor_session_id", table),
      data: { operation_type: readString(row, "operation_type", table), target_kind: readString(row, "target_kind", table),
        target_id: readString(row, "target_id", table), actor_kind: readString(row, "actor_kind", table),
        actor_user_id: readNullableString(row, "actor_user_id", table), payload_json: payload } }];
  }
  if (table === "file_assets") {
    return [{ ...common, source_kind: "existing_asset", source_pointer: "/", source_table: table,
      session_id: readNullableString(row, "source_session_id", table), data: pick(row, [
        "storage_key", "storage_purpose", "storage_endpoint", "storage_bucket", "owner_kind", "owner_key",
        "registration_scope", "source_node_id", "source_session_id", "output_command_id", "original_name",
        "mime_type", "byte_size", "checksum_sha256", "upload_status", "garbage_collected_at",
      ]) }];
  }
  return [{ ...common, source_kind: "existing_asset", source_pointer: "/", source_table: table,
    card_id: null, data: pick(row, ["folder_id", "membership_kind", "item_type", "item_id", "metadata"]) }];
}

async function readPage(sql: InventorySql, query: (transaction: InventorySql) => Promise<SqlRow[]>): Promise<SqlRow[]> {
  try {
    return await sql.begin(async (transaction) => {
      await transaction`SET TRANSACTION READ ONLY`;
      await transaction`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`;
      return query(transaction);
    });
  } catch (error) {
    if (isInventoryError(error)) throw error;
    throw inventoryError("INVENTORY_DB_READ_FAILED", "relational source page query failed", error);
  }
}

async function readCardsPage(sql: InventorySql, cutoff: Date, after: string | null, pageSize: number): Promise<SqlRow[]> {
  return await sql<SqlRow[]>`SELECT id,folder_id,node_id,created_session_id,updated_session_id,assignee_session_id,assignee_user_id,
    request,attachments,items,created_at,updated_at FROM cards
    WHERE created_at <= ${cutoff} AND (${after}::text IS NULL OR id COLLATE "C" > ${after})
    ORDER BY id COLLATE "C" LIMIT ${pageSize}`;
}

async function readReportsPage(sql: InventorySql, cutoff: Date, after: string | null, pageSize: number): Promise<SqlRow[]> {
  return await sql<SqlRow[]>`SELECT id,card_id,session_id,title,format,body,created_at FROM card_reports
    WHERE created_at <= ${cutoff} AND (${after}::text IS NULL OR id COLLATE "C" > ${after})
    ORDER BY id COLLATE "C" LIMIT ${pageSize}`;
}

async function readCommentsPage(sql: InventorySql, cutoff: Date, after: string | null, pageSize: number): Promise<SqlRow[]> {
  return await sql<SqlRow[]>`SELECT id,card_id,author_kind,author_id,session_id,kind,body,attachment_refs,created_at FROM card_comments
    WHERE created_at <= ${cutoff} AND (${after}::text IS NULL OR id COLLATE "C" > ${after})
    ORDER BY id COLLATE "C" LIMIT ${pageSize}`;
}

async function readOperationsPage(sql: InventorySql, cutoff: Date, after: string | null, pageSize: number): Promise<SqlRow[]> {
  return await sql<SqlRow[]>`SELECT id,folder_id,target_kind,target_id,operation_type,actor_kind,actor_session_id,actor_user_id,payload_json,reason,created_at
    FROM folder_operations WHERE created_at <= ${cutoff} AND target_kind = 'card'
      AND operation_type IN ('report_card_item','update_card','set_card_items')
      AND (${after}::text IS NULL OR id COLLATE "C" > ${after})
    ORDER BY id COLLATE "C" LIMIT ${pageSize}`;
}

async function readAssetsPage(sql: InventorySql, cutoff: Date, after: string | null, pageSize: number): Promise<SqlRow[]> {
  return await sql<SqlRow[]>`SELECT id,storage_key,storage_purpose,storage_endpoint,storage_bucket,owner_kind,owner_key,registration_scope,
    source_node_id,source_session_id,output_command_id,original_name,mime_type,byte_size,checksum_sha256,upload_status,
    garbage_collected_at,created_at,updated_at FROM file_assets
    WHERE created_at <= ${cutoff} AND (${after}::text IS NULL OR id COLLATE "C" > ${after})
    ORDER BY id COLLATE "C" LIMIT ${pageSize}`;
}

async function readBoardItemsPage(sql: InventorySql, cutoff: Date, after: string | null, pageSize: number): Promise<SqlRow[]> {
  return await sql<SqlRow[]>`SELECT id,folder_id,membership_kind,item_type,item_id,metadata,created_at,updated_at FROM board_items
    WHERE item_type = 'asset' AND created_at <= ${cutoff} AND (${after}::text IS NULL OR id COLLATE "C" > ${after})
    ORDER BY id COLLATE "C" LIMIT ${pageSize}`;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw inventoryError("INVENTORY_INVALID_SOURCE", `${field} must be a JSON array`);
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw inventoryError("INVENTORY_INVALID_SOURCE", `${field} must be a JSON object`);
  return value;
}

function readString(row: SqlRow, key: string, table: RelationalSourceTable): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw inventoryError("INVENTORY_INVALID_SOURCE", `${table}.${key} must be non-empty text`);
  return value;
}

function readText(row: SqlRow, key: string, table: RelationalSourceTable): string {
  const value = row[key];
  if (typeof value !== "string") throw inventoryError("INVENTORY_INVALID_SOURCE", `${table}.${key} must be text`);
  return value;
}

function readNullableString(row: SqlRow, key: string, table: RelationalSourceTable): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw inventoryError("INVENTORY_INVALID_SOURCE", `${table}.${key} must be text or null`);
  return value;
}

function readDate(row: SqlRow, key: string, table: RelationalSourceTable): number {
  const value = row[key];
  const at = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at)) throw inventoryError("INVENTORY_INVALID_SOURCE", `${table}.${key} must be a timestamp`);
  return at;
}

function readFormat(value: unknown): "markdown" | "html" {
  if (value !== "markdown" && value !== "html") throw inventoryError("INVENTORY_INVALID_SOURCE", "card_reports.format is invalid");
  return value;
}

function pick(row: SqlRow, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]));
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw inventoryError("INVENTORY_INVALID_SOURCE", "source row cannot be fingerprinted");
  return encoded;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function markdownTargets(body: string): Array<{ raw: string; offset: number }> {
  const text = stripFencedBlocks(body);
  const targets: Array<{ raw: string; offset: number }> = [];
  const inlineRanges: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^<>\n]*>|[^()\s]+)/g)) {
    const raw = match[1];
    if (raw !== undefined) {
      const start = match.index ?? 0;
      inlineRanges.push({ start, end: start + match[0].length });
      targets.push({ raw, offset: start + match[0].indexOf(raw) });
    }
  }
  for (const match of text.matchAll(/<([^<>\s]+)>/g)) {
    const raw = match[1];
    const start = match.index ?? 0;
    if (raw !== undefined && !inlineRanges.some((range) => start >= range.start && start < range.end))
      targets.push({ raw, offset: start });
  }
  for (const match of text.matchAll(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(\S+)/gm)) {
    const raw = match[1];
    if (raw !== undefined) targets.push({ raw, offset: (match.index ?? 0) + match[0].indexOf(raw) });
  }
  return targets;
}

function htmlTargets(body: string): Array<{ raw: string; offset: number }> {
  const targets: Array<{ raw: string; offset: number }> = [];
  for (const match of stripFencedBlocks(body).matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = match[1] ?? match[2];
    if (value !== undefined) targets.push({ raw: value.replace(/&amp;/g, "&"), offset: match.index ?? 0 });
  }
  return targets;
}

function classifyTarget(rawValue: string, allowedOrigins: readonly string[]): Omit<LegacyTarget, "pointer"> | null {
  const raw = rawValue.trim().replace(/^<|>$/g, "").replace(/&amp;/g, "&");
  if (raw.length === 0) return null;
  const absolute = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(raw);
  const hasAuthority = absolute || raw.startsWith("//");
  let url: URL;
  try { url = new URL(raw, "https://inventory-relative.invalid"); }
  catch { return hasLegacyMarkers(raw) ? { raw_url: raw, classification: "ambiguous_url", reason: "unexpected_route" } : null; }
  const hasMarkers = hasLegacyMarkers(raw) || url.pathname === FILE_ROUTE;
  if (!hasMarkers) return null;
  if (url.pathname !== FILE_ROUTE) return { raw_url: raw, classification: "ambiguous_url", reason: "unexpected_route" };
  if (hasAuthority && !isAllowedOrigin(url.origin, allowedOrigins))
    return { raw_url: raw, classification: "ambiguous_url", reason: "unknown_origin" };

  const nodeIds = url.searchParams.getAll("nodeId");
  const paths = url.searchParams.getAll("path");
  if (nodeIds.length > 1 || paths.length > 1)
    return { raw_url: raw, classification: "ambiguous_url", reason: "duplicate_query_parameter" };
  if (nodeIds.length !== 1 || paths.length !== 1)
    return { raw_url: raw, classification: "ambiguous_url", reason: "missing_query_parameter" };
  const nodeId = nodeIds[0]!;
  const path = paths[0]!;
  if (nodeId.length === 0 || path.length === 0)
    return { raw_url: raw, classification: "ambiguous_url", reason: "empty_query_parameter" };
  return { raw_url: raw, legacy_node_id: nodeId, raw_path: path,
    normalized_path: normalizeAttachmentLegacyPath(path), classification: "legacy_path" };
}

function hasLegacyMarkers(value: string): boolean {
  return /(?:^|[?&])(?:nodeId|path)=/i.test(value) || /(?:^|\/)files(?:[/?#]|$)/i.test(value);
}

function isAllowedOrigin(origin: string, allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.some((allowed) => {
    try { return new URL(allowed).origin === origin; }
    catch { return false; }
  });
}

function withPointer(
  target: Omit<LegacyTarget, "pointer">,
  pointer: string,
  offset: number | null,
): LegacyTarget {
  return { ...target, pointer, ...(offset === null ? {} : { body_offset: offset }) };
}

function stripFencedBlocks(body: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (marker?.[1]) { fence = marker[1][0]!; kept.push(" ".repeat(line.length)); continue; }
      kept.push(line);
      continue;
    }
    kept.push(" ".repeat(line.length));
    if (marker?.[1] && marker[1][0] === fence) fence = null;
  }
  return kept.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInventoryError(value: unknown): value is Error & { code: string } {
  const code = value instanceof Error ? (value as { code?: unknown }).code : undefined;
  return typeof code === "string" && INVENTORY_ERROR_CODES.has(code as InventoryErrorCode);
}

const INVENTORY_ERROR_CODES = new Set<InventoryErrorCode>([
  "INVENTORY_INVALID_SOURCE",
  "INVENTORY_AMBIGUOUS_URL",
  "INVENTORY_DB_READ_FAILED",
]);
