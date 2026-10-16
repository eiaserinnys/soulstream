#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { exportBundle } from "./export_bundle.js";
import { extractSessionAttachmentSources } from "./extract_events.js";
import { extractRelationalSources } from "./extract_relational.js";
import {
  INVENTORY_ERROR_CODES as ERROR,
  INVENTORY_EVENT_PROGRESS_STATE,
  INVENTORY_EXPORT_PART_KIND,
  INVENTORY_SCHEMA_VERSION,
  inventoryError,
  parseInventoryCutoff,
  type EventExtractionProgress,
  type InventoryAliasSnapshot,
  type InventoryAssetSnapshot,
  type InventoryExportPart,
  type InventorySessionCoverage,
  type InventorySessionList,
  type LegacySource,
} from "./inventory_contract.js";

type SqlRow = Record<string, unknown>;
type ExtractorSql = {
  <T extends readonly SqlRow[] = SqlRow[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  begin<T>(callback: (transaction: ExtractorSql) => Promise<T>): Promise<T>;
};
type Options = Record<string, string>;
type Progress = EventExtractionProgress;

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

export async function withReadOnlyTransaction<T>(
  sql: postgres.Sql,
  statementTimeoutMs: number,
  callback: (transaction: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  requirePositiveInteger(statementTimeoutMs, "statement timeout");
  return await sql.begin(async (transaction) => {
    await transaction`SET TRANSACTION READ ONLY`;
    await transaction`SELECT set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`;
    return callback(transaction);
  }) as unknown as T;
}

async function main(args: string[]): Promise<void> {
  const [command, ...values] = args;
  if (command === "bundle") {
    await exportBundle(parseOptions(values));
    return;
  }
  if (command !== "relational" && command !== "sessions" && command !== "events") {
    throw new TypeError("usage: export_sources.ts <relational|sessions|events|bundle> ...");
  }
  const options = parseOptions(values);
  assertAllowedOptions(options, command === "events"
    ? ["--cutoff", "--output", "--statement-timeout-ms", "--page-size", "--sessions", "--start", "--limit"]
    : ["--cutoff", "--output", "--statement-timeout-ms", "--page-size"]);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new TypeError("DATABASE_URL must be set in the environment");
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const cutoff = requiredCutoff(options);
    const timeout = integerOption(options, "--statement-timeout-ms", DEFAULT_STATEMENT_TIMEOUT_MS);
    const pageSize = integerOption(options, "--page-size", DEFAULT_PAGE_SIZE);
    const output = requiredOption(options, "--output");
    if (command === "relational") await exportRelational(sql, { cutoff, timeout, pageSize, output });
    else if (command === "sessions") await exportSessions(sql, { cutoff, timeout, pageSize, output });
    else await exportEvents(sql, { cutoff, timeout, pageSize, output, options });
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function exportRelational(sql: postgres.Sql, input: { cutoff: string; timeout: number; pageSize: number; output: string }): Promise<void> {
  const startedAt = now();
  const writer = await openNewOutput(input.output);
  try {
    for await (const source of extractRelationalSources(sql as unknown as ExtractorSql, {
      pageSize: input.pageSize, cutoff: input.cutoff, statementTimeoutMs: input.timeout,
    })) {
      if (source.source_kind === "existing_asset" && source.source_table === "file_assets") await writer.jsonl(assetSnapshot(source));
      await writer.jsonl(source);
    }
    for await (const alias of readAliasSnapshots(sql, input.cutoff, input.pageSize, input.timeout)) await writer.jsonl(alias);
    const endedAt = now();
    const part: InventoryExportPart = {
      record_type: "export_part", schema_version: INVENTORY_SCHEMA_VERSION,
      part_kind: INVENTORY_EXPORT_PART_KIND.relational, cutoff: input.cutoff,
      started_at: startedAt, ended_at: endedAt, coverage_complete: true,
      alias_snapshot_complete: true,
    };
    await writer.jsonl(part);
  } finally {
    await writer.close();
  }
  await reportReadback(input.output, "RELATIONAL_SOURCE_PART_EXPORTED");
}

async function exportSessions(sql: postgres.Sql, input: { cutoff: string; timeout: number; pageSize: number; output: string }): Promise<void> {
  const startedAt = now();
  const sessionIds: string[] = [];
  let after: string | null = null;
  while (true) {
    const page = await withReadOnlyTransaction(sql, input.timeout, async (tx) => await tx<SqlRow[]>`
      SELECT session_id FROM sessions
      WHERE created_at <= ${new Date(input.cutoff)}
        AND (${after}::text IS NULL OR session_id COLLATE "C" > ${after})
      ORDER BY session_id COLLATE "C" LIMIT ${input.pageSize}`);
    for (const row of page) {
      if (typeof row.session_id !== "string" || row.session_id.length === 0) throw inventoryError(ERROR.invalid_source, "session_id must be non-empty text");
      sessionIds.push(row.session_id);
    }
    if (page.length < input.pageSize) break;
    after = sessionIds[sessionIds.length - 1]!;
  }
  const list: InventorySessionList = {
    record_type: "session_list", schema_version: INVENTORY_SCHEMA_VERSION,
    cutoff: input.cutoff, started_at: startedAt, ended_at: now(), session_ids: sessionIds,
  };
  await writeNewJson(input.output, list);
  await reportJsonReadback(input.output, "INVENTORY_SESSION_LIST_EXPORTED", sessionIds.length);
}

async function exportEvents(sql: postgres.Sql, input: { cutoff: string; timeout: number; pageSize: number; output: string; options: Options }): Promise<void> {
  const sessionsPath = requiredOption(input.options, "--sessions");
  const start = nonnegativeIntegerOption(input.options, "--start");
  const limit = integerOption(input.options, "--limit");
  const selectedList = await readSessionList(sessionsPath);
  const end = Math.min(start + limit, selectedList.session_ids.length);
  if (start > selectedList.session_ids.length) throw new TypeError("--start is outside the session list");
  const selected = selectedList.session_ids.slice(start, end);
  const startedAt = now();
  const writer = await openNewOutput(input.output);
  const progressBySession = new Map<string, Progress>();
  let completed = 0;
  try {
    for await (const source of extractSessionAttachmentSources(sql as unknown as ExtractorSql, selected, {
      pageSize: input.pageSize, cutoff: input.cutoff, statementTimeoutMs: input.timeout,
      onProgress: (progress) => {
        progressBySession.set(progress.session_id, progress);
        if (progress.state === INVENTORY_EVENT_PROGRESS_STATE.complete || progress.state === INVENTORY_EVENT_PROGRESS_STATE.source_changed) completed += 1;
        process.stderr.write(`[events] sessions_completed=${completed}/${selected.length} cursor=${progress.cursor.sessionId}:${progress.cursor.eventId} state=${progress.state}\n`);
      },
    })) await writer.jsonl(source);
    const sessionCoverage: InventorySessionCoverage[] = selected.map((sessionId) => coverageFromProgress(sessionId, progressBySession.get(sessionId), startedAt));
    for (const coverage of sessionCoverage) await writer.jsonl(coverage);
    const endedAt = now();
    const part: InventoryExportPart = {
      record_type: "export_part", schema_version: INVENTORY_SCHEMA_VERSION,
      part_kind: INVENTORY_EXPORT_PART_KIND.events, cutoff: input.cutoff,
      started_at: startedAt, ended_at: endedAt,
      coverage_complete: sessionCoverage.every((row) => row.coverage_complete), session_ids: selected,
    };
    await writer.jsonl(part);
  } finally {
    await writer.close();
  }
  await reportReadback(input.output, "INVENTORY_EVENT_PART_EXPORTED");
}

async function* readAliasSnapshots(sql: postgres.Sql, cutoff: string, pageSize: number, timeout: number): AsyncIterable<InventoryAliasSnapshot> {
  let afterNode: string | null = null;
  let afterPath: string | null = null;
  while (true) {
    const page = await withReadOnlyTransaction(sql, timeout, async (tx) => await tx<SqlRow[]>`
      SELECT node_id,normalized_path,asset_id,original_path,availability,checked_at
      FROM attachment_legacy_aliases
      WHERE (${afterNode}::text IS NULL OR node_id COLLATE "C" > ${afterNode}
        OR (node_id COLLATE "C" = ${afterNode} AND normalized_path COLLATE "C" > ${afterPath}))
      ORDER BY node_id COLLATE "C", normalized_path COLLATE "C" LIMIT ${pageSize}`);
    for (const row of page) {
      if (typeof row.node_id !== "string" || typeof row.normalized_path !== "string" || typeof row.original_path !== "string" ||
          (row.availability !== "resolved" && row.availability !== "missing")) {
        throw inventoryError(ERROR.invalid_source, "attachment_legacy_aliases contains an invalid snapshot row");
      }
      yield {
        record_type: "alias", node_id: row.node_id, normalized_path: row.normalized_path,
        asset_id: typeof row.asset_id === "string" ? row.asset_id : null,
        original_path: row.original_path, availability: row.availability,
        checked_at: asIso(row.checked_at, "attachment alias checked_at"),
      };
    }
    if (page.length < pageSize) break;
    const last = page[page.length - 1]!;
    afterNode = String(last.node_id);
    afterPath = String(last.normalized_path);
  }
}

function assetSnapshot(source: LegacySource): InventoryAssetSnapshot {
  const data = source.data;
  return {
    record_type: "asset", id: source.source_pk,
    storage_purpose: text(data.storage_purpose), storage_key: nullableText(data.storage_key),
    storage_endpoint: nullableText(data.storage_endpoint), storage_bucket: nullableText(data.storage_bucket),
    upload_status: text(data.upload_status), original_name: nullableText(data.original_name),
    mime_type: nullableText(data.mime_type), byte_size: numberOrNull(data.byte_size),
    checksum_sha256: nullableText(data.checksum_sha256), garbage_collected_at: nullableText(data.garbage_collected_at),
    owner_kind: nullableText(data.owner_kind), owner_key: nullableText(data.owner_key),
    registration_scope: data.registration_scope, changed_after_cutoff: source.changed_after_cutoff,
  };
}

function coverageFromProgress(sessionId: string, progress: Progress | undefined, startedAt: string): InventorySessionCoverage {
  if (!progress) return {
    record_type: "session_coverage", schema_version: INVENTORY_SCHEMA_VERSION, session_id: sessionId,
    state: INVENTORY_EVENT_PROGRESS_STATE.incomplete, cursor: { sessionId, eventId: 0 }, coverage_complete: false,
    started_at: startedAt, observed_at: now(), ended_at: now(), error_code: ERROR.coverage_incomplete,
    coverage_issue: "no_final_progress_record",
  };
  return {
    record_type: "session_coverage", schema_version: INVENTORY_SCHEMA_VERSION, session_id: sessionId,
    state: progress.state, cursor: progress.cursor, coverage_complete: progress.coverage_complete,
    started_at: progress.started_at, observed_at: progress.observed_at,
    ...(progress.ended_at === undefined ? {} : { ended_at: progress.ended_at }),
    ...(progress.error_code === undefined ? {} : { error_code: progress.error_code }),
  };
}

async function readSessionList(filePath: string): Promise<InventorySessionList> {
  const value = JSON.parse(await readFile(filePath, "utf8")) as Partial<InventorySessionList>;
  if (value.record_type !== "session_list" || value.schema_version !== INVENTORY_SCHEMA_VERSION || !Array.isArray(value.session_ids) ||
      value.session_ids.some((item) => typeof item !== "string" || item.length === 0)) {
    throw inventoryError(ERROR.manifest_mismatch, "--sessions must be an exported session list JSON file");
  }
  const cutoff = parseInventoryCutoff(value.cutoff ?? "");
  if (new Set(value.session_ids).size !== value.session_ids.length) throw inventoryError(ERROR.manifest_mismatch, "session list contains duplicate session IDs");
  return { ...value, cutoff } as InventorySessionList;
}

async function writeNewJson(filePath: string, value: unknown): Promise<void> {
  const output = await open(path.resolve(filePath), "wx", 0o600);
  try { await output.writeFile(`${JSON.stringify(value)}\n`, "utf8"); }
  finally { await output.close(); }
}

async function openNewOutput(filePath: string): Promise<{ jsonl(value: unknown): Promise<void>; close(): Promise<void> }> {
  const handle = await open(path.resolve(filePath), "wx", 0o600);
  return {
    async jsonl(value) { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); },
    close: () => handle.close(),
  };
}

async function reportReadback(filePath: string, marker: string): Promise<void> {
  const count = await countJsonlLines(filePath);
  process.stdout.write(`${marker} rows=${count} sha256=${await sha256File(filePath)}\n`);
}

async function reportJsonReadback(filePath: string, marker: string, expectedCount: number): Promise<void> {
  const textValue = await readFile(filePath, "utf8");
  const parsed = JSON.parse(textValue) as InventorySessionList;
  const count = parsed.session_ids.length;
  if (count !== expectedCount) throw inventoryError(ERROR.output_failed, "session list readback count did not match");
  process.stdout.write(`${marker} rows=${count} sha256=${await sha256File(filePath)}\n`);
}

async function countJsonlLines(filePath: string): Promise<number> {
  let count = 0;
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) throw inventoryError(ERROR.output_failed, "output JSONL contains an empty line");
    try { JSON.parse(line); }
    catch (error) { throw inventoryError(ERROR.output_failed, "output JSONL readback is invalid", error); }
    count += 1;
  }
  return count;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function parseOptions(args: string[]): Options {
  if (args.length % 2 !== 0) throw new TypeError("options require a value");
  const output: Options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1]!;
    if (!name.startsWith("--") || value.startsWith("--") || output[name] !== undefined) throw new TypeError("invalid or repeated option");
    output[name] = value;
  }
  return output;
}
function assertAllowedOptions(options: Options, allowed: readonly string[]): void {
  if (Object.keys(options).some((name) => !allowed.includes(name))) throw new TypeError("unknown option for inventory subcommand");
}

function requiredCutoff(options: Options): string { return parseInventoryCutoff(requiredOption(options, "--cutoff")); }
function requiredOption(options: Options, name: string): string {
  const value = options[name];
  if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}
function integerOption(options: Options, name: string, fallback?: number): number {
  const raw = options[name];
  if (raw === undefined && fallback !== undefined) return fallback;
  if (raw === undefined || !/^\d+$/.test(raw)) throw new TypeError(`${name} must be a positive integer`);
  const value = Number(raw);
  requirePositiveInteger(value, name);
  return value;
}
function nonnegativeIntegerOption(options: Options, name: string): number {
  const raw = options[name];
  if (raw === undefined || !/^\d+$/.test(raw)) throw new TypeError(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}
function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
}
function asIso(value: unknown, label: string): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw inventoryError(ERROR.invalid_source, `${label} must be a timestamp`);
  return date.toISOString();
}
function now(): string { return new Date().toISOString(); }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function nullableText(value: unknown): string | null { return typeof value === "string" ? value : null; }
function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorCode(value: unknown): string { return isRecord(value) && typeof value.code === "string" ? value.code : "INVENTORY_EXPORT_FAILED"; }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code = errorCode(error);
    console.error(`${code}: inventory export failed`);
    process.exitCode = 1;
  });
}
