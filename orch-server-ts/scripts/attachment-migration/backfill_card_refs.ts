#!/usr/bin/env node
import path from "node:path";
import postgres from "postgres";
import { pathToFileURL } from "node:url";

import {
  mergeCardSourceAttachmentRefs,
  type CardLegacyAttachmentRef,
} from "../../src/cards/card_attachment_legacy_refs.js";
import { attachmentRefsOf } from "../../src/cards/card_attachment_refs.js";
import { normalizeAttachmentLegacyPath } from "../../src/attachments/attachment_read_service.js";
import {
  INVENTORY_SCHEMA_VERSION,
  type InventoryPlanReference,
  type LegacySource,
  type LegacyTarget,
} from "./inventory_contract.js";
import { collectLegacySourceTargets } from "./extract_relational.js";
import {
  errorCode,
  locationKey,
  parseMessageBackfillArgs,
  readManifest,
  selectIdentities,
  uniqueStrings,
  withReadOnlyTransaction,
  writeJsonlReport,
  type ManifestIdentity,
  type MessageBackfillOptions,
} from "./backfill_message_refs.js";

export type CardSourceKind = "card_request" | "card_item" | "report" | "comment" | "note" | "item_history";
export type CardRefSource = {
  readonly identity_key: string;
  readonly legacy_node_id: string;
  readonly normalized_path: string;
  readonly reference: InventoryPlanReference;
};
export type ResolvedCardAlias = { readonly node_id: string; readonly normalized_path: string; readonly attachment_id: string };
export type CardBackfillResult = { readonly status: "updated" | "unchanged"; readonly sources_verified: number };
export type CardBackfillOptions = MessageBackfillOptions;

type CardSql = postgres.Sql;
type SqlRow = Record<string, unknown>;
type AliasSql = postgres.TransactionSql;
type CardBackfillInput = { readonly cardId: string; readonly expectedVersion: number; readonly sources: readonly CardRefSource[]; readonly resolvedAliases: readonly ResolvedCardAlias[]; readonly allowedOrigins?: readonly string[] };
type CurrentRows = { card: SqlRow; reports: Map<string, SqlRow>; comments: Map<string, SqlRow>; operations: Map<string, SqlRow> };
type ValidatedSource = { source: CardRefSource; attachmentId: string; legacyUrl: string };
type OutputRecord = Record<string, unknown>;

const APPROVAL_REQUIRED = "APPROVAL_REQUIRED";
const ALIAS_UNRESOLVED = "ALIAS_UNRESOLVED";
const CARD_VERSION_CONFLICT = "CARD_VERSION_CONFLICT";
const SOURCE_CHANGED = "SOURCE_CHANGED";
const CARD_REF_UNVERIFIED = "CARD_REF_UNVERIFIED";
const ALLOWED_IDENTITY_STATUSES = new Set(["verified_source", "owner_unverified", "already_migrated"]);
const READ_QUERY_TIMEOUT_MS = 30_000;

export class CardRefBackfillError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CardRefBackfillError";
  }
}

export function parseCardBackfillArgs(args: readonly string[]): CardBackfillOptions {
  try { return parseMessageBackfillArgs(args); }
  catch (error) {
    if (error instanceof TypeError && error.message.startsWith("usage:")) throw new TypeError("usage: backfill_card_refs.ts --manifest <JSONL> --output <JSONL> --allowed-origins <JSON array> [--apply --approved-manifest-sha256 <SHA256>] [--limit N] [--only <identity_key>]");
    throw error;
  }
}

export async function backfillCardRefsTx(sql: CardSql, input: CardBackfillInput): Promise<CardBackfillResult> {
  validateInput(input);
  return await sql.begin(async (transaction) => {
    const currentRows = await readCurrentRows(transaction, input.cardId, input.sources, true);
    const version = Number(currentRows.card.version);
    if (!Number.isSafeInteger(version) || version !== input.expectedVersion) {
      throw new CardRefBackfillError(CARD_VERSION_CONFLICT, "card version changed after the backfill snapshot");
    }
    const approvedAliases = aliasMapForSources(input.sources, input.resolvedAliases);
    const aliases = await readResolvedAliases(transaction, input.sources);
    for (const [key, alias] of approvedAliases) {
      if (aliases.get(key)?.attachment_id !== alias.attachment_id) {
        throw new CardRefBackfillError(CARD_REF_UNVERIFIED, "resolved alias no longer points to a committed attachment");
      }
    }
    const validated = validateSources(input.cardId, input.sources, aliases, currentRows, input.allowedOrigins ?? []);
    const cardRefs = attachmentRefsOf(currentRows.card.attachment_refs);
    const incomingCardRefs = validated
      .filter((item) => isCardRowRef(item.source.reference))
      .map((item) => ({ attachment_id: item.attachmentId, legacy_url: item.legacyUrl }));
    const nextCardRefs = mergeCardSourceAttachmentRefs(cardRefs, incomingCardRefs);
    const nextItems = transitionCurrentEvidence(currentRows.card.items, validated);
    const cardChanged = !sameJson(cardRefs, nextCardRefs) || !sameJson(currentRows.card.items, nextItems);

    const reportRefs = new Map<string, CardLegacyAttachmentRef[]>();
    const commentRefs = new Map<string, CardLegacyAttachmentRef[]>();
    for (const item of validated) {
      const ref: CardLegacyAttachmentRef = { attachment_id: item.attachmentId, legacy_url: item.legacyUrl };
      if (item.source.reference.source_kind === "report") appendRef(reportRefs, item.source.reference.source_pk, ref);
      else if (item.source.reference.source_kind === "comment" || item.source.reference.source_kind === "note")
        appendRef(commentRefs, item.source.reference.source_pk, ref);
    }

    let childChanged = false;
    for (const [reportId, refs] of reportRefs) {
      const row = currentRows.reports.get(reportId)!;
      const previous = attachmentRefsOf(row.attachment_refs);
      const next = mergeCardSourceAttachmentRefs(previous, refs);
      if (sameJson(previous, next)) continue;
      const saved = await transaction<SqlRow[]>`
        UPDATE card_reports SET attachment_refs=${transaction.json(next as never)}::jsonb
        WHERE id=${reportId} AND card_id=${input.cardId} RETURNING id
      `;
      if (saved.length !== 1) throw new CardRefBackfillError(SOURCE_CHANGED, "report source changed while locked");
      childChanged = true;
    }
    for (const [commentId, refs] of commentRefs) {
      const row = currentRows.comments.get(commentId)!;
      const previous = attachmentRefsOf(row.attachment_refs);
      const next = mergeCardSourceAttachmentRefs(previous, refs);
      if (sameJson(previous, next)) continue;
      const saved = await transaction<SqlRow[]>`
        UPDATE card_comments SET attachment_refs=${transaction.json(next as never)}::jsonb
        WHERE id=${commentId} AND card_id=${input.cardId} RETURNING id
      `;
      if (saved.length !== 1) throw new CardRefBackfillError(SOURCE_CHANGED, "comment source changed while locked");
      childChanged = true;
    }

    if (cardChanged) {
      const saved = await transaction<SqlRow[]>`
        UPDATE cards SET attachment_refs=${transaction.json(nextCardRefs as never)}::jsonb,
          items=${transaction.json(nextItems as never)}::jsonb, version=version+1
        WHERE id=${input.cardId} AND version=${input.expectedVersion}
        RETURNING version, jsonb_typeof(attachment_refs) AS refs_type, jsonb_typeof(items) AS items_type
      `;
      if (saved.length !== 1 || Number(saved[0]!.version) !== input.expectedVersion + 1 ||
          saved[0]!.refs_type !== "array" || saved[0]!.items_type !== "array") {
        throw new CardRefBackfillError(CARD_VERSION_CONFLICT, "card refs could not be saved at the expected version");
      }
    }

    await verifySavedRows(transaction, input.cardId, reportRefs.keys(), commentRefs.keys());
    return { status: cardChanged || childChanged ? "updated" : "unchanged", sources_verified: validated.length };
  }) as CardBackfillResult;
}

async function main(args: readonly string[]): Promise<void> {
  parseCardBackfillArgs(args);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new TypeError("DATABASE_URL must be set in the environment");
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const report = await runCardBackfillCli(args, sql);
    console.log(`${String(report[0]!.marker)} ${JSON.stringify(report[0])}`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export async function runCardBackfillCli(args: readonly string[], sql: CardSql): Promise<OutputRecord[]> {
  const options = parseCardBackfillArgs(args);
  const input = await readManifest(options.manifest);
  if (options.approvedManifestSha256 && options.approvedManifestSha256 !== input.manifestSha256) {
    throw new CardRefBackfillError(APPROVAL_REQUIRED, "approved manifest sha256 does not match the input file");
  }
  const identities = selectIdentities(input.identities, options);
  const cardSources: CardRefSource[] = [];
  for (const identity of identities) {
    if (!ALLOWED_IDENTITY_STATUSES.has(identity.status) || !identity.coverage_complete) continue;
    for (const reference of identity.references) {
      if (!isCardReference(reference) || reference.changed_after_cutoff || reference.card_id == null) continue;
      const source = { identity_key: identity.identity_key, legacy_node_id: identity.legacy_node_id,
        normalized_path: identity.normalized_path, reference };
      cardSources.push(source);
    }
  }
  const aliases = await withReadOnlyTransaction(sql, READ_QUERY_TIMEOUT_MS,
    (transaction) => readResolvedAliases(transaction, cardSources));
  const byCard = new Map<string, CardRefSource[]>();
  const report: OutputRecord[] = [];
  for (const source of cardSources) {
    const alias = aliases.get(locationKey(source.legacy_node_id, source.normalized_path));
    if (!alias) {
      report.push(sourceRecord(ALIAS_UNRESOLVED, source));
      continue;
    }
    appendSource(byCard, source.reference.card_id!, source);
  }
  let updated = 0;
  let unchanged = 0;
  for (const [cardId, candidates] of byCard) {
    try {
      const snapshot = await withReadOnlyTransaction(sql, READ_QUERY_TIMEOUT_MS,
        (transaction) => readCurrentRows(transaction, cardId, candidates, false));
      const cardAliases = distinctAliases(candidates, aliases);
      const cardAliasMap = new Map(cardAliases.map((alias) => [locationKey(alias.node_id, alias.normalized_path), alias] as const));
      const valid: ValidatedSource[] = [];
      for (const candidate of candidates) {
        try {
          valid.push(...validateSources(cardId, [candidate], cardAliasMap, snapshot, options.allowedOrigins));
          report.push(sourceRecord(options.apply ? "pending_apply" : "planned", candidate));
        } catch (error) {
          report.push(sourceRecord(errorCode(error, SOURCE_CHANGED), candidate));
        }
      }
      if (!options.apply || valid.length === 0) continue;
      const result = await backfillCardRefsTx(sql, {
        cardId, expectedVersion: Number(snapshot.card.version),
        sources: valid.map((item) => item.source), resolvedAliases: cardAliases, allowedOrigins: options.allowedOrigins,
      });
      if (result.status === "updated") updated += 1;
      else unchanged += 1;
      report.push({ record_type: "card", card_id: cardId, status: result.status, sources_verified: result.sources_verified });
    } catch (error) {
      report.push({ record_type: "card", card_id: cardId, code: errorCode(error, SOURCE_CHANGED) });
    }
  }
  report.unshift({
    record_type: "summary", marker: "CARD_REFS_BACKFILLED", apply: options.apply,
    identities_selected: identities.length, source_refs_selected: cardSources.length,
    cards_selected: byCard.size, cards_updated: updated, cards_unchanged: unchanged,
    unresolved_aliases: report.filter((record) => record.code === ALIAS_UNRESOLVED).length,
    manifest_sha256: input.manifestSha256,
  });
  await writeJsonlReport(options.output, report);
  return report;
}

async function readCurrentRows(
  sql: postgres.TransactionSql,
  cardId: string,
  sources: readonly CardRefSource[],
  lock: boolean,
): Promise<CurrentRows> {
  const card = (await sql<SqlRow[]>`
    SELECT id, request, attachments, items, attachment_refs, version
    FROM cards WHERE id=${cardId} ${lock ? sql`FOR UPDATE` : sql``}
  `)[0];
  if (!card) throw new CardRefBackfillError(SOURCE_CHANGED, "card source no longer exists");
  const reportIds = uniqueStrings(sources.filter((source) => source.reference.source_kind === "report").map((source) => source.reference.source_pk));
  const commentIds = uniqueStrings(sources.filter((source) => source.reference.source_kind === "comment" || source.reference.source_kind === "note")
    .map((source) => source.reference.source_pk));
  const operationIds = uniqueStrings(sources.filter((source) => source.reference.source_kind === "item_history").map((source) => source.reference.source_pk));
  const reports = reportIds.length === 0 ? [] : await sql<SqlRow[]>`
    SELECT id, card_id, body, format, attachment_refs FROM card_reports
    WHERE card_id=${cardId} AND id=ANY(${sql.array(reportIds)}::text[]) ${lock ? sql`FOR UPDATE` : sql``}
  `;
  const comments = commentIds.length === 0 ? [] : await sql<SqlRow[]>`
    SELECT id, card_id, kind, body, attachment_refs FROM card_comments
    WHERE card_id=${cardId} AND id=ANY(${sql.array(commentIds)}::text[]) ${lock ? sql`FOR UPDATE` : sql``}
  `;
  const operations = operationIds.length === 0 ? [] : await sql<SqlRow[]>`
    SELECT id, target_kind, target_id, payload_json FROM folder_operations
    WHERE target_kind='card' AND target_id=${cardId} AND id=ANY(${sql.array(operationIds)}::text[])
    ${lock ? sql`FOR UPDATE` : sql``}
  `;
  return {
    card,
    reports: new Map(reports.map((row) => [String(row.id), row])),
    comments: new Map(comments.map((row) => [String(row.id), row])),
    operations: new Map(operations.map((row) => [String(row.id), row])),
  };
}

async function readResolvedAliases(sql: AliasSql, sources: readonly CardRefSource[]): Promise<Map<string, ResolvedCardAlias>> {
  const locations = [...new Map(sources.map((source) => {
    const alias = { node_id: source.legacy_node_id, normalized_path: source.normalized_path, attachment_id: "" };
    return [locationKey(alias.node_id, alias.normalized_path), alias] as const;
  })).values()];
  if (locations.length === 0) return new Map();
  const rows = await sql<SqlRow[]>`
    SELECT alias.node_id, alias.normalized_path, alias.asset_id
    FROM attachment_legacy_aliases AS alias
    JOIN unnest(${sql.array(locations.map((item) => item.node_id))}::text[],
                ${sql.array(locations.map((item) => item.normalized_path))}::text[])
      AS requested(node_id, normalized_path)
      ON requested.node_id=alias.node_id AND requested.normalized_path=alias.normalized_path
    JOIN file_assets AS asset ON asset.id=alias.asset_id
    WHERE alias.availability='resolved' AND asset.storage_purpose='attachment'
      AND asset.upload_status='committed' AND asset.garbage_collected_at IS NULL
  `;
  return new Map(rows.flatMap((row) => typeof row.node_id === "string" && typeof row.normalized_path === "string" && typeof row.asset_id === "string"
    ? [[locationKey(row.node_id, row.normalized_path), { node_id: row.node_id, normalized_path: row.normalized_path, attachment_id: row.asset_id }] as const]
    : []));
}

function validateSources(
  cardId: string,
  sources: readonly CardRefSource[],
  aliases: ReadonlyMap<string, ResolvedCardAlias>,
  currentRows: CurrentRows,
  allowedOrigins: readonly string[],
): ValidatedSource[] {
  const result: ValidatedSource[] = [];
  for (const source of sources) {
    const reference = source.reference;
    const attachmentId = aliases.get(locationKey(source.legacy_node_id, source.normalized_path))?.attachment_id;
    if (!attachmentId || !isCardReference(reference) || reference.card_id !== cardId) {
      throw new CardRefBackfillError(CARD_REF_UNVERIFIED, "source is missing a committed alias or card provenance");
    }
    const sourceData = sourceDataFor(reference, currentRows);
    if (!sourceData) throw new CardRefBackfillError(SOURCE_CHANGED, "card source row no longer exists");
    const legacySource = {
      schema_version: INVENTORY_SCHEMA_VERSION, source_kind: reference.source_kind,
      source_table: reference.source_table, source_pk: reference.source_pk,
      source_pointer: reference.pointer, row_sha256: "current", created_at: new Date(0).toISOString(),
      changed_after_cutoff: false, card_id: reference.card_id, data: sourceData,
    } as LegacySource;
    const targets = collectLegacySourceTargets(legacySource, { allowedOrigins });
    const target = targets.find((item) => targetMatches(item, source));
    if (!target && !isAlreadyTransitionedEvidence(reference, sourceData, attachmentId)) {
      throw new CardRefBackfillError(SOURCE_CHANGED, "source pointer no longer matches its original legacy reference");
    }
    const legacyUrl = legacyRelativeUrl(source.legacy_node_id, source.normalized_path);
    result.push({ source, attachmentId, legacyUrl });
  }
  return result;
}

function targetMatches(target: LegacyTarget, source: CardRefSource): boolean {
  const reference = source.reference;
  return target.classification === "legacy_path" && target.pointer === reference.pointer && target.legacy_node_id === source.legacy_node_id &&
    target.normalized_path === source.normalized_path &&
    target.raw_url === reference.raw_url && target.raw_path === reference.raw_path &&
    (reference.body_offset === undefined || target.body_offset === reference.body_offset);
}

function sourceDataFor(reference: InventoryPlanReference, rows: CurrentRows): SqlRow | undefined {
  if (reference.source_kind === "card_request" || reference.source_kind === "card_item")
    return rows.card.id === reference.source_pk ? rows.card : undefined;
  if (reference.source_kind === "report") return rows.reports.get(reference.source_pk);
  if (reference.source_kind === "comment" || reference.source_kind === "note") {
    const row = rows.comments.get(reference.source_pk);
    return row && (row.kind === reference.source_kind || (reference.source_kind === "comment" && row.kind === "spoken")) ? row : undefined;
  }
  if (reference.source_kind === "item_history") return rows.operations.get(reference.source_pk);
  return undefined;
}

function transitionCurrentEvidence(itemsValue: unknown, validated: readonly ValidatedSource[]): unknown {
  if (!Array.isArray(itemsValue)) throw new CardRefBackfillError(SOURCE_CHANGED, "card items are not a JSON array");
  let changed = false;
  const items = itemsValue.map((item, itemIndex) => {
    if (!isRecord(item) || !Array.isArray(item.evidence)) return item;
    let itemChanged = false;
    const evidence = item.evidence.map((entry, evidenceIndex) => {
      if (!isRecord(entry)) return entry;
      const match = validated.find((candidate) => {
        const pointer = evidencePointer(candidate.source.reference.pointer);
        return pointer?.itemIndex === itemIndex && pointer.evidenceIndex === evidenceIndex;
      });
      if (!match || typeof entry.url !== "string") return entry;
      const next: Record<string, unknown> = { ...entry, attachment_id: match.attachmentId };
      delete next.url;
      itemChanged = true;
      return next;
    });
    if (!itemChanged) return item;
    changed = true;
    return { ...item, evidence };
  });
  return changed ? items : itemsValue;
}

function isAlreadyTransitionedEvidence(reference: InventoryPlanReference, row: SqlRow, attachmentId: string): boolean {
  const pointer = evidencePointer(reference.pointer);
  if (!pointer || !Array.isArray(row.items)) return false;
  const item = row.items[pointer.itemIndex];
  if (!isRecord(item) || !Array.isArray(item.evidence)) return false;
  const evidence = item.evidence[pointer.evidenceIndex];
  return isRecord(evidence) && evidence.attachment_id === attachmentId && evidence.url === undefined;
}

function evidencePointer(pointer: string): { itemIndex: number; evidenceIndex: number } | null {
  const match = /^\/items\/(\d+)\/evidence\/(\d+)\/url$/.exec(pointer);
  if (!match) return null;
  return { itemIndex: Number(match[1]), evidenceIndex: Number(match[2]) };
}

async function verifySavedRows(
  sql: postgres.TransactionSql,
  cardId: string,
  reportIds: Iterable<string>,
  commentIds: Iterable<string>,
): Promise<void> {
  const reports = [...reportIds];
  const comments = [...commentIds];
  const rows = await sql<SqlRow[]>`
    SELECT jsonb_typeof(attachment_refs) AS refs_type FROM cards WHERE id=${cardId}
    UNION ALL SELECT jsonb_typeof(attachment_refs) FROM card_reports
      WHERE card_id=${cardId} AND id=ANY(${sql.array(reports)}::text[])
    UNION ALL SELECT jsonb_typeof(attachment_refs) FROM card_comments
      WHERE card_id=${cardId} AND id=ANY(${sql.array(comments)}::text[])
  `;
  if (rows.length !== 1 + reports.length + comments.length || rows.some((row) => row.refs_type !== "array")) {
    throw new CardRefBackfillError(CARD_REF_UNVERIFIED, "stored refs failed JSON array readback verification");
  }
}

function validateInput(input: CardBackfillInput): void {
  if (!input.cardId || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || input.sources.length === 0) {
    throw new CardRefBackfillError(CARD_REF_UNVERIFIED, "card ID, version, and source refs are required");
  }
  for (const source of input.sources) {
    if (!source.identity_key || !source.legacy_node_id || !source.normalized_path || !isCardReference(source.reference) ||
        source.reference.card_id !== input.cardId || source.reference.changed_after_cutoff ||
        ((source.reference.source_kind === "card_request" || source.reference.source_kind === "card_item") &&
          source.reference.source_pk !== input.cardId)) {
      throw new CardRefBackfillError(CARD_REF_UNVERIFIED, "source does not have approved card provenance");
    }
  }
}

function isCardReference(reference: InventoryPlanReference): reference is InventoryPlanReference & { source_kind: CardSourceKind; card_id: string } {
  const tableByKind: Record<CardSourceKind, string> = {
    card_request: "cards", card_item: "cards", report: "card_reports", comment: "card_comments",
    note: "card_comments", item_history: "folder_operations",
  };
  return Object.hasOwn(tableByKind, reference.source_kind) && reference.source_table === tableByKind[reference.source_kind as CardSourceKind] &&
    typeof reference.card_id === "string" && reference.card_id.length > 0;
}

function isCardRowRef(reference: InventoryPlanReference): boolean {
  return reference.source_kind === "card_request" || reference.source_kind === "card_item" || reference.source_kind === "item_history";
}

function aliasMapForSources(sources: readonly CardRefSource[], aliases: readonly ResolvedCardAlias[]): Map<string, ResolvedCardAlias> {
  const supplied = new Map<string, ResolvedCardAlias>();
  for (const alias of aliases) {
    const key = locationKey(alias.node_id, alias.normalized_path);
    if (!alias.attachment_id || (supplied.has(key) && supplied.get(key)!.attachment_id !== alias.attachment_id)) {
      throw new CardRefBackfillError(CARD_REF_UNVERIFIED, "resolved aliases contain a conflict");
    }
    supplied.set(key, alias);
  }
  const expected = new Set(sources.map((source) => locationKey(source.legacy_node_id, source.normalized_path)));
  if ([...expected].some((key) => !supplied.has(key))) throw new CardRefBackfillError(CARD_REF_UNVERIFIED, "a source alias is unresolved");
  return new Map([...expected].map((key) => [key, supplied.get(key)!]));
}

function distinctAliases(sources: readonly CardRefSource[], aliases: ReadonlyMap<string, ResolvedCardAlias>): ResolvedCardAlias[] {
  const distinct = new Map<string, ResolvedCardAlias>();
  for (const source of sources) {
    const key = locationKey(source.legacy_node_id, source.normalized_path);
    const alias = aliases.get(key);
    if (alias) distinct.set(key, alias);
  }
  return [...distinct.values()];
}

function appendRef(map: Map<string, CardLegacyAttachmentRef[]>, key: string, value: CardLegacyAttachmentRef): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function appendSource(map: Map<string, CardRefSource[]>, key: string, value: CardRefSource): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function sourceRecord(statusOrCode: string, source: CardRefSource): OutputRecord {
  const isCode = /^[A-Z_]+$/.test(statusOrCode);
  return {
    record_type: "source", ...(isCode ? { code: statusOrCode } : { status: statusOrCode }),
    identity_key: source.identity_key, card_id: source.reference.card_id,
    source_kind: source.reference.source_kind, source_pk: source.reference.source_pk, pointer: source.reference.pointer,
  };
}

function legacyRelativeUrl(nodeId: string, normalizedPath: string): string {
  const params = new URLSearchParams();
  params.set("nodeId", nodeId);
  params.set("path", normalizeAttachmentLegacyPath(normalizedPath));
  return `/api/attachments/files?${params.toString()}`;
}
function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left).filter((key) => left[key] !== undefined);
    return keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length &&
      keys.every((key) => sameJson(left[key], right[key]));
  }
  return Object.is(left, right);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code = errorCode(error, "CARD_REF_UNVERIFIED");
    console.error(`${code}: ${error instanceof Error ? error.message : "card ref backfill failed"}`);
    process.exitCode = 1;
  });
}
