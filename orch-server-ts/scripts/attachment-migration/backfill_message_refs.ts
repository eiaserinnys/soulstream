#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { pathToFileURL } from "node:url";

import { normalizeAttachmentLegacyPath } from "../../src/attachments/attachment_read_service.js";
import {
  INVENTORY_EVENT_TYPES,
  INVENTORY_SCHEMA_VERSION,
  type InventoryPlanIdentity,
  type InventoryPlanReference,
} from "./inventory_contract.js";

export type MessageRefSource = {
  readonly session_id: string;
  readonly event_id: number;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly created_at: Date | string;
};

export type MessageBackfillResult = {
  readonly status: "updated" | "unchanged";
  readonly attachment_ids: number;
  readonly attachment_count: number;
};

export type MessageBackfillOptions = {
  readonly manifest: string;
  readonly output: string;
  readonly apply: boolean;
  readonly approvedManifestSha256?: string;
  readonly limit?: number;
  readonly only?: string;
};

type MessageSql = postgres.Sql;
type SqlRow = Record<string, unknown>;
export type ManifestIdentity = InventoryPlanIdentity & { references: InventoryPlanReference[] };
type MessageReference = InventoryPlanReference & {
  readonly source_kind: "message";
  readonly source_table: "events";
  readonly session_id: string;
  readonly event_id: number;
};
export type ManifestInput = { readonly manifestSha256: string; readonly identities: ManifestIdentity[] };
type EventCandidate = { readonly session_id: string; readonly event_id: number; readonly references: Array<{
  readonly identity: ManifestIdentity;
  readonly reference: MessageReference;
  readonly attachmentId: string;
}> };
type OutputRecord = Record<string, unknown>;

const APPROVAL_REQUIRED = "APPROVAL_REQUIRED";
const ALIAS_UNRESOLVED = "ALIAS_UNRESOLVED";
const SOURCE_CHANGED = "SOURCE_CHANGED";
const MESSAGE_REF_CONFLICT = "MESSAGE_REF_CONFLICT";
const ALLOWED_IDENTITY_STATUSES = new Set(["verified_source", "owner_unverified", "already_migrated"]);
const MANAGED_NOTE_PREFIX = "[첨부 파일 로컬 경로: ";
const READ_QUERY_TIMEOUT_MS = 30_000;

export class MessageRefBackfillError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MessageRefBackfillError";
  }
}

export function parseMessageBackfillArgs(args: readonly string[]): MessageBackfillOptions {
  const values: Record<string, string> = {};
  let apply = false;
  for (let index = 0; index < args.length;) {
    const flag = args[index]!;
    if (flag === "--apply") {
      if (apply) throw usageError();
      apply = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (!flag.startsWith("--") || value === undefined || value.startsWith("--") || values[flag] !== undefined) throw usageError();
    values[flag] = value;
    index += 2;
  }
  const allowed = new Set(["--manifest", "--output", "--approved-manifest-sha256", "--limit", "--only"]);
  if (Object.keys(values).some((flag) => !allowed.has(flag))) throw usageError();
  const manifest = values["--manifest"];
  const output = values["--output"];
  const approvedManifestSha256 = values["--approved-manifest-sha256"];
  if (!manifest || !output) throw usageError();
  if (apply && (!approvedManifestSha256 || !/^[a-f\d]{64}$/i.test(approvedManifestSha256))) {
    throw new MessageRefBackfillError(APPROVAL_REQUIRED, "--apply requires --approved-manifest-sha256");
  }
  if (approvedManifestSha256 && !/^[a-f\d]{64}$/i.test(approvedManifestSha256)) throw usageError();
  const limit = values["--limit"] === undefined ? undefined : positiveInteger(values["--limit"]!, "--limit");
  return {
    manifest,
    output,
    apply,
    ...(approvedManifestSha256 === undefined ? {} : { approvedManifestSha256: approvedManifestSha256.toLowerCase() }),
    ...(limit === undefined ? {} : { limit }),
    ...(values["--only"] === undefined ? {} : { only: nonempty(values["--only"]!, "--only") }),
  };
}

export function messageSourceFingerprint(source: MessageRefSource): string {
  const payload = asRecord(source.payload);
  const createdAt = asIsoTimestamp(source.created_at);
  return sha256(stableJson({
    session_id: source.session_id,
    event_id: source.event_id,
    event_type: source.event_type,
    payload,
    created_at: createdAt,
  }));
}

export function mergeMessageAttachmentPayload(
  payloadValue: Record<string, unknown>,
  resolvedIds: readonly string[],
): Record<string, unknown> {
  const payload = asRecord(payloadValue);
  const ids = uniqueStrings([...stringEntries(payload.attachment_ids), ...resolvedIds]);
  const idSet = new Set(ids);
  const paths = new Set([...stringEntries(payload.attachments), ...stringEntries(payload.attachment_paths)]);
  const covered = new Set<string>();
  for (const value of arrayEntries(payload.attachment_bindings)) {
    if (!isRecord(value)) continue;
    if (typeof value.attachment_id !== "string" || !idSet.has(value.attachment_id)) continue;
    if (typeof value.path === "string" && paths.has(value.path)) covered.add(value.path);
  }
  return {
    ...payload,
    attachment_ids: ids,
    attachment_count: ids.length + paths.size - covered.size,
  };
}

export async function backfillMessageRefsTx(
  sql: MessageSql,
  source: MessageRefSource,
  expectedFingerprint: string,
  resolvedIds: readonly string[],
): Promise<MessageBackfillResult> {
  const attachmentIds = uniqueStrings(resolvedIds);
  if (attachmentIds.length === 0) throw new MessageRefBackfillError(ALIAS_UNRESOLVED, "source has no resolved alias IDs");
  if (!isMessageEventType(source.event_type)) throw new MessageRefBackfillError(SOURCE_CHANGED, "source event type is not eligible");

  return await sql.begin(async (transaction) => {
    const rows = await transaction<SqlRow[]>`
      SELECT session_id, id AS event_id, event_type, payload, created_at
      FROM events WHERE session_id=${source.session_id} AND id=${source.event_id}
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row || row.session_id !== source.session_id || Number(row.event_id) !== source.event_id ||
        row.event_type !== source.event_type || !isRecord(row.payload)) {
      throw new MessageRefBackfillError(SOURCE_CHANGED, "message source no longer matches the inventory");
    }
    const lockedSource: MessageRefSource = {
      session_id: String(row.session_id), event_id: Number(row.event_id), event_type: String(row.event_type),
      payload: row.payload, created_at: row.created_at as Date | string,
    };
    if (messageSourceFingerprint(lockedSource) !== expectedFingerprint) {
      throw new MessageRefBackfillError(SOURCE_CHANGED, "message source changed after it was read");
    }

    const nextPayload = mergeMessageAttachmentPayload(lockedSource.payload, attachmentIds);
    if (stableJson(nextPayload) === stableJson(lockedSource.payload)) {
      return messageBackfillResult("unchanged", nextPayload);
    }
    await transaction`
      UPDATE events SET payload=${transaction.json(nextPayload)}::jsonb
      WHERE session_id=${source.session_id} AND id=${source.event_id}
    `;
    const saved = await transaction<SqlRow[]>`
      SELECT payload, jsonb_typeof(payload) AS payload_type,
        jsonb_typeof(payload->'attachment_ids') AS attachment_ids_type
      FROM events WHERE session_id=${source.session_id} AND id=${source.event_id}
    `;
    if (!saved[0] || saved[0].payload_type !== "object" || saved[0].attachment_ids_type !== "array" ||
        !isRecord(saved[0].payload) || stableJson(saved[0].payload) !== stableJson(nextPayload)) {
      throw new MessageRefBackfillError(MESSAGE_REF_CONFLICT, "stored message refs did not match the requested JSON object");
    }
    return messageBackfillResult("updated", nextPayload);
  }) as MessageBackfillResult;
}

async function main(args: readonly string[]): Promise<void> {
  const options = parseMessageBackfillArgs(args);
  const input = await readManifest(options.manifest);
  if (options.approvedManifestSha256 && options.approvedManifestSha256 !== input.manifestSha256) {
    throw new MessageRefBackfillError(APPROVAL_REQUIRED, "approved manifest sha256 does not match the input file");
  }
  const identities = selectIdentities(input.identities, options);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new TypeError("DATABASE_URL must be set in the environment");
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const report = await executeBackfill(sql, identities, options, input.manifestSha256);
    await writeJsonlReport(options.output, report);
    const summary = report[0]!;
    console.log(`${summary.marker} ${JSON.stringify(summary)}`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function executeBackfill(
  sql: MessageSql,
  identities: readonly ManifestIdentity[],
  options: MessageBackfillOptions,
  manifestSha256: string,
): Promise<OutputRecord[]> {
  const report: OutputRecord[] = [];
  const eligible = identities.filter((identity) => ALLOWED_IDENTITY_STATUSES.has(identity.status) && identity.coverage_complete);
  const ineligible = identities.filter((identity) => !ALLOWED_IDENTITY_STATUSES.has(identity.status) || !identity.coverage_complete);
  for (const identity of ineligible) {
    if (identity.references.some(isMessageReference)) report.push({
      record_type: "source", code: "SOURCE_UNVERIFIED", identity_key: identity.identity_key,
    });
  }
  const aliases = await readResolvedAliases(sql, eligible, READ_QUERY_TIMEOUT_MS);
  const candidates = new Map<string, EventCandidate>();
  for (const identity of eligible) {
    const attachmentId = aliases.get(locationKey(identity.legacy_node_id, identity.normalized_path));
    for (const rawReference of identity.references) {
      if (!isMessageReference(rawReference)) continue;
      const reference = rawReference;
      if (!attachmentId) {
        report.push(sourceRecord(ALIAS_UNRESOLVED, identity, reference));
        continue;
      }
      const key = eventKey(reference.session_id, reference.event_id);
      const candidate = candidates.get(key) ?? {
        session_id: reference.session_id,
        event_id: reference.event_id,
        references: [],
      };
      candidate.references.push({ identity, reference, attachmentId });
      candidates.set(key, candidate);
    }
  }

  const snapshots = await readEventSnapshots(sql, [...candidates.values()], READ_QUERY_TIMEOUT_MS);
  let updated = 0;
  let unchanged = 0;
  for (const candidate of candidates.values()) {
    const key = eventKey(candidate.session_id, candidate.event_id);
    const snapshot = snapshots.get(key);
    if (!snapshot || !isMessageEventType(snapshot.event_type)) {
      for (const item of candidate.references) report.push(sourceRecord(SOURCE_CHANGED, item.identity, item.reference));
      continue;
    }
    const valid = candidate.references.filter(({ identity, reference }) =>
      messageReferenceIsCurrent(snapshot.payload, reference.pointer, identity.normalized_path));
    const stale = candidate.references.filter((item) => !valid.includes(item));
    for (const item of stale) report.push(sourceRecord(SOURCE_CHANGED, item.identity, item.reference));
    const ids = uniqueStrings(valid.map((item) => item.attachmentId));
    if (ids.length === 0) continue;
    if (options.apply) {
      try {
        const result = await backfillMessageRefsTx(sql, snapshot, messageSourceFingerprint(snapshot), ids);
        if (result.status === "updated") updated += 1;
        else unchanged += 1;
        report.push({ record_type: "source", status: result.status, session_id: candidate.session_id, event_id: candidate.event_id });
      } catch (error) {
        report.push({
          record_type: "source", code: errorCode(error, SOURCE_CHANGED), session_id: candidate.session_id, event_id: candidate.event_id,
        });
      }
    } else {
      report.push({ record_type: "source", status: "planned", session_id: candidate.session_id, event_id: candidate.event_id });
    }
  }
  report.unshift({
    record_type: "summary",
    marker: "MESSAGE_REFS_BACKFILLED",
    apply: options.apply,
    identities_selected: identities.length,
    source_events_selected: candidates.size,
    source_events_updated: updated,
    source_events_unchanged: unchanged,
    unresolved_aliases: report.filter((item) => item.code === ALIAS_UNRESOLVED).length,
    manifest_sha256: manifestSha256,
  });
  return report;
}

async function readResolvedAliases(
  sql: MessageSql,
  identities: readonly ManifestIdentity[],
  statementTimeoutMs: number,
): Promise<Map<string, string>> {
  if (identities.length === 0) return new Map();
  const nodeIds = [...new Set(identities.map((identity) => identity.legacy_node_id))];
  const paths = [...new Set(identities.map((identity) => identity.normalized_path))];
  const rows = await withReadOnlyTransaction(sql, statementTimeoutMs, async (transaction) => await transaction<SqlRow[]>`
    SELECT alias.node_id, alias.normalized_path, alias.asset_id
    FROM attachment_legacy_aliases AS alias
    JOIN file_assets AS asset ON asset.id=alias.asset_id
    WHERE alias.node_id = ANY(${transaction.array(nodeIds)}::text[])
      AND alias.normalized_path = ANY(${transaction.array(paths)}::text[])
      AND alias.availability='resolved'
      AND asset.storage_purpose='attachment'
      AND asset.upload_status='committed'
      AND asset.garbage_collected_at IS NULL
  `);
  return new Map(rows.flatMap((row) =>
    typeof row.node_id === "string" && typeof row.normalized_path === "string" && typeof row.asset_id === "string"
      ? [[locationKey(row.node_id, row.normalized_path), row.asset_id] as const]
      : []));
}

async function readEventSnapshots(
  sql: MessageSql,
  candidates: readonly EventCandidate[],
  statementTimeoutMs: number,
): Promise<Map<string, MessageRefSource>> {
  if (candidates.length === 0) return new Map();
  const sessionIds = candidates.map((candidate) => candidate.session_id);
  const eventIds = candidates.map((candidate) => candidate.event_id);
  const rows = await withReadOnlyTransaction(sql, statementTimeoutMs, async (transaction) => await transaction<SqlRow[]>`
    SELECT event.session_id, event.id AS event_id, event.event_type, event.payload, event.created_at
    FROM events AS event
    JOIN unnest(${transaction.array(sessionIds)}::text[], ${transaction.array(eventIds)}::integer[])
      AS requested(session_id, event_id)
      ON requested.session_id=event.session_id AND requested.event_id=event.id
  `);
  const snapshots = new Map<string, MessageRefSource>();
  for (const row of rows) {
    if (typeof row.session_id !== "string" || typeof row.event_type !== "string" || !isRecord(row.payload)) continue;
    const source: MessageRefSource = {
      session_id: row.session_id,
      event_id: Number(row.event_id),
      event_type: row.event_type,
      payload: row.payload,
      created_at: row.created_at as Date | string,
    };
    snapshots.set(eventKey(source.session_id, source.event_id), source);
  }
  return snapshots;
}

export async function withReadOnlyTransaction<T>(
  sql: MessageSql,
  statementTimeoutMs: number,
  callback: (transaction: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return await sql.begin(async (transaction) => {
    await transaction`SET TRANSACTION READ ONLY`;
    await transaction`SELECT set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`;
    return callback(transaction);
  }) as T;
}

export async function readManifest(filePath: string): Promise<ManifestInput> {
  const bytes = await readFile(filePath);
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  const rows: unknown[] = [];
  for (const [index, line] of bytes.toString("utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as unknown); }
    catch { throw new MessageRefBackfillError("INVENTORY_MANIFEST_MISMATCH", `invalid JSONL record ${index + 1}`); }
  }
  const header = rows.shift();
  if (!isRecord(header) || header.record_type !== "manifest_metadata" || header.schema_version !== INVENTORY_SCHEMA_VERSION ||
      header.dry_run !== true || header.writes_enabled !== false || header.coverage_complete !== true) {
    throw new MessageRefBackfillError("INVENTORY_MANIFEST_MISMATCH", "manifest header is invalid or incomplete");
  }
  const identities: ManifestIdentity[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.identity_key !== "string") continue;
    if (typeof row.legacy_node_id !== "string" || typeof row.normalized_path !== "string" || !Array.isArray(row.references) ||
        typeof row.status !== "string" || typeof row.coverage_complete !== "boolean") {
      throw new MessageRefBackfillError("INVENTORY_MANIFEST_MISMATCH", "manifest identity is invalid");
    }
    identities.push(row as unknown as ManifestIdentity);
  }
  return { manifestSha256, identities };
}

export function selectIdentities(identities: readonly ManifestIdentity[], options: MessageBackfillOptions): ManifestIdentity[] {
  const selected = identities.filter((identity) => options.only === undefined || identity.identity_key === options.only);
  if (options.only !== undefined && selected.length === 0) throw new MessageRefBackfillError("INVENTORY_MANIFEST_MISMATCH", "--only identity_key was not found");
  return options.limit === undefined ? selected : selected.slice(0, options.limit);
}

function messageReferenceIsCurrent(payload: Record<string, unknown>, pointer: string, normalizedPath: string): boolean {
  const parts = pointer.split("/").slice(1).map(unescapePointer);
  if (parts[0] !== "payload") return false;
  if ((parts[1] === "attachments" || parts[1] === "attachment_paths") && Number.isInteger(Number(parts[2]))) {
    const value = arrayEntries(payload[parts[1]])[Number(parts[2])];
    return typeof value === "string" && normalizePath(value) === normalizedPath;
  }
  if (parts[1] === "text" && parts[2] === "managed_path_notes" && Number.isInteger(Number(parts[3]))) {
    const value = managedPathNotes(payload.text)[Number(parts[3])];
    return value !== undefined && normalizePath(value) === normalizedPath;
  }
  return false;
}

function managedPathNotes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const lines = value.split(/\r?\n/);
  const notes: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith(MANAGED_NOTE_PREFIX) || !line.endsWith("]")) break;
    const value = line.slice(MANAGED_NOTE_PREFIX.length, -1);
    if (value.length === 0) break;
    notes.unshift(value);
  }
  return notes;
}

function normalizePath(value: string): string {
  try { return normalizeAttachmentLegacyPath(value); }
  catch { return ""; }
}

function isMessageReference(reference: InventoryPlanReference): reference is MessageReference {
  return reference.source_kind === "message" && reference.source_table === "events" &&
    typeof reference.session_id === "string" && typeof reference.event_id === "number" && Number.isSafeInteger(reference.event_id) &&
    typeof reference.pointer === "string";
}

function sourceRecord(code: string, identity: ManifestIdentity, reference: MessageReference): OutputRecord {
  return { record_type: "source", code, identity_key: identity.identity_key, session_id: reference.session_id,
    event_id: reference.event_id, pointer: reference.pointer };
}

export async function writeJsonlReport(filePath: string, records: readonly OutputRecord[]): Promise<void> {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true, mode: 0o700 });
  const content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await writeFile(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function isMessageEventType(value: string): boolean {
  return (INVENTORY_EVENT_TYPES as readonly string[]).includes(value);
}
function eventKey(sessionId: string, eventId: number): string { return `${sessionId}\u0000${eventId}`; }
export function locationKey(nodeId: string, normalizedPath: string): string { return `${nodeId}\u0000${normalizedPath}`; }
export function uniqueStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) if (typeof value === "string" && value.length > 0 && !seen.has(value)) { seen.add(value); output.push(value); }
  return output;
}
function messageBackfillResult(status: MessageBackfillResult["status"], payload: Record<string, unknown>): MessageBackfillResult {
  return { status, attachment_ids: stringEntries(payload.attachment_ids).length, attachment_count: Number(payload.attachment_count) };
}
function stringEntries(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : []; }
function arrayEntries(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new MessageRefBackfillError(MESSAGE_REF_CONFLICT, "message payload must be a JSON object");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function asIsoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new MessageRefBackfillError(SOURCE_CHANGED, "source timestamp is invalid");
  return date.toISOString();
}
function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function positiveInteger(value: string, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw usageError(`${name} must be a positive integer`);
  return result;
}
function nonempty(value: string, name: string): string {
  if (value.length === 0) throw usageError(`${name} must be non-empty`);
  return value;
}
function unescapePointer(value: string): string { return value.replace(/~1/g, "/").replace(/~0/g, "~"); }
export function errorCode(error: unknown, fallback: string): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : fallback;
}
function usageError(detail?: string): TypeError {
  return new TypeError(detail ?? "usage: backfill_message_refs.ts --manifest <JSONL> --output <JSONL> [--apply --approved-manifest-sha256 <SHA256>] [--limit N] [--only <identity_key>]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code = errorCode(error, "MESSAGE_REF_CONFLICT");
    console.error(`${code}: ${error instanceof Error ? error.message : "message ref backfill failed"}`);
    process.exitCode = 1;
  });
}
