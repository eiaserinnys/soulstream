import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

import type { LivePostgresSql } from "../../src/runtime/live_db_sql.js";
import type { InventoryOwnerEvidence, InventoryPlanIdentity } from "./inventory_contract.js";
import type { CopyReceipt } from "./copy_originals.js";

const ORIGINALS_STORAGE_PREFIX = "session-attachments/originals";
const DRY_RUN_MARKER = "ATTACHMENT_MIGRATION_PUBLISH_DRY_RUN";
const PUBLISHED_MARKER = "ASSETS_ALIASES_PUBLISHED";

export type PublishReceipt = CopyReceipt;
export type PublishEntry = Pick<InventoryPlanIdentity,
  "identity_key" | "legacy_node_id" | "normalized_path" | "name" | "inferred_mime" | "owner" | "status" | "references" |
  "size_bytes" | "sha256" | "proposed_asset_id" | "existing_alias" | "existing_asset_id"> & {
    readonly storage_endpoint: string;
    readonly storage_bucket: string;
  };

type PublishMetadata = {
  readonly attachmentId: string;
  readonly storageKey: string | null;
  readonly byteSize: number | null;
  readonly checksumSha256: string | null;
  readonly missing?: true;
};
type PublishOptions = {
  readonly manifest: string;
  readonly receipts: string;
  readonly limit?: number;
  readonly only?: string;
  readonly apply: boolean;
  readonly approvedManifestSha256?: string;
};
type Manifest = { readonly manifestHash: string; readonly entries: PublishEntry[] };
type SqlTag = LivePostgresSql;

export async function publishVerifiedAssetTx(
  sql: SqlTag,
  entry: PublishEntry,
  receipt: PublishReceipt,
): Promise<{ attachmentId: string; aliasCount: number }> {
  const metadata = validatePublishReceipt(entry, receipt);
  if (metadata.missing) return publishMissingAlias(sql, entry, metadata.attachmentId);
  if (entry.status === "existing_alias_unverified") {
    return verifyExistingAlias(sql, entry, receipt, metadata);
  }

  const owner = ownerColumns(entry.owner);
  const registrationScope = owner.ownerKind === null || owner.registrationScope === null
    ? null
    : sql.json(owner.registrationScope);
  const sourceSessionId = sourceSessionFor(entry);
  await sql`
    INSERT INTO file_assets (
      id, storage_key, storage_purpose, storage_endpoint, storage_bucket,
      owner_kind, owner_key, registration_scope, source_node_id, source_session_id,
      output_command_id, original_name, mime_type, byte_size, checksum_sha256, upload_status
    ) VALUES (
      ${metadata.attachmentId}, ${metadata.storageKey}, 'attachment', ${entry.storage_endpoint}, ${entry.storage_bucket},
      ${owner.ownerKind}, ${owner.ownerKey}, ${registrationScope}::jsonb, ${entry.legacy_node_id}, ${sourceSessionId},
      NULL, ${entry.name}, ${entry.inferred_mime || "application/octet-stream"}, ${metadata.byteSize},
      ${metadata.checksumSha256}, 'committed'
    )
    ON CONFLICT DO NOTHING
  `;

  const assets = await sql`
    SELECT id, storage_key, storage_purpose, storage_endpoint, storage_bucket, owner_kind, owner_key,
           registration_scope, source_node_id, source_session_id, output_command_id, original_name,
           mime_type, byte_size, checksum_sha256, upload_status, garbage_collected_at
    FROM file_assets WHERE id = ${metadata.attachmentId} FOR UPDATE
  `;
  if (!sameAssetMetadata(assets[0], entry, metadata, owner, sourceSessionId)) {
    throw publishError("ASSET_METADATA_CONFLICT", "the asset ID or storage key already has different metadata");
  }
  await insertResolvedAlias(sql, entry, metadata.attachmentId);
  return { attachmentId: metadata.attachmentId, aliasCount: 1 };
}

export function validatePublishApproval(
  apply: boolean,
  approvedHash: string | undefined,
  actualHash: string,
): "dry_run" | "apply" {
  if (!apply) return "dry_run";
  if (!isSha256(approvedHash) || approvedHash !== actualHash) {
    throw publishError("APPROVAL_REQUIRED", "--apply requires the matching --approved-manifest-sha256");
  }
  return "apply";
}

export function validatePublishReceipt(entry: PublishEntry, receipt: PublishReceipt): PublishMetadata {
  if (receipt.identity_key !== entry.identity_key || !isIsoDate(receipt.verified_at)) {
    throw publishError("RECEIPT_MISMATCH", "copy receipt identity or verification time differs from the manifest");
  }
  const attachmentId = entry.status === "existing_alias_unverified"
    ? entry.existing_alias?.asset_id ?? entry.existing_asset_id
    : entry.proposed_asset_id ?? entry.identity_key;
  if (!attachmentId || receipt.attachment_id !== attachmentId) {
    throw publishError("RECEIPT_MISMATCH", "copy receipt asset ID differs from the manifest");
  }
  if (entry.status === "confirmed_missing") {
    if (receipt.result !== "skipped_unconfirmed" || receipt.storage_key !== "" || receipt.byte_size !== null || receipt.sha256 !== null) {
      throw publishError("RECEIPT_MISMATCH", "confirmed-missing identity has an unexpected copy receipt");
    }
    return { attachmentId, storageKey: null, byteSize: null, checksumSha256: null, missing: true };
  }
  if (receipt.result !== "copied" && receipt.result !== "existing_verified") {
    throw publishError("RECEIPT_MISMATCH", "asset publication requires a verified E-05 receipt");
  }
  if (!receipt.storage_key || !Number.isSafeInteger(receipt.byte_size) || receipt.byte_size! < 0 || !isSha256(receipt.sha256)) {
    throw publishError("RECEIPT_MISMATCH", "copy receipt storage key, size, or checksum is invalid");
  }
  if (receipt.byte_size !== entry.size_bytes && entry.size_bytes !== undefined ||
      receipt.sha256 !== entry.sha256 && entry.sha256 !== undefined) {
    throw publishError("RECEIPT_MISMATCH", "copy receipt size or checksum differs from the approved source");
  }
  if (entry.status === "existing_alias_unverified") {
    if (receipt.result !== "existing_verified" || !entry.existing_alias || entry.existing_alias.availability !== "resolved") {
      throw publishError("RECEIPT_MISMATCH", "existing alias receipt is not tied to a resolved manifest alias");
    }
  } else {
    const expectedKey = `${ORIGINALS_STORAGE_PREFIX}/${attachmentId}`;
    if (receipt.storage_key !== expectedKey || !isCopyCandidateStatus(entry.status) ||
        !Number.isSafeInteger(entry.size_bytes) || entry.size_bytes! < 0 || !isSha256(entry.sha256)) {
      throw publishError("RECEIPT_MISMATCH", "copy receipt key or source metadata differs from the approved identity");
    }
  }
  return {
    attachmentId,
    storageKey: receipt.storage_key,
    byteSize: receipt.byte_size!,
    checksumSha256: receipt.sha256!,
  };
}

async function publishMissingAlias(sql: SqlTag, entry: PublishEntry, attachmentId: string): Promise<{ attachmentId: string; aliasCount: number }> {
  await sql`
    INSERT INTO attachment_legacy_aliases (node_id, normalized_path, asset_id, original_path, availability)
    VALUES (${entry.legacy_node_id}, ${entry.normalized_path}, NULL, ${entry.normalized_path}, 'missing')
    ON CONFLICT (node_id, normalized_path) DO NOTHING
  `;
  const rows = await sql`
    SELECT asset_id, original_path, availability
    FROM attachment_legacy_aliases
    WHERE node_id = ${entry.legacy_node_id} AND normalized_path = ${entry.normalized_path}
    FOR UPDATE
  `;
  if (rows.length !== 1 || rows[0]!.asset_id !== null || rows[0]!.original_path !== entry.normalized_path || rows[0]!.availability !== "missing") {
    throw publishError("ALIAS_CONFLICT", "a different alias already occupies this legacy path");
  }
  return { attachmentId, aliasCount: 1 };
}

async function insertResolvedAlias(sql: SqlTag, entry: PublishEntry, attachmentId: string): Promise<void> {
  await sql`
    INSERT INTO attachment_legacy_aliases (node_id, normalized_path, asset_id, original_path, availability)
    VALUES (${entry.legacy_node_id}, ${entry.normalized_path}, ${attachmentId}, ${entry.normalized_path}, 'resolved')
    ON CONFLICT (node_id, normalized_path) DO NOTHING
  `;
  const rows = await sql`
    SELECT asset_id, original_path, availability
    FROM attachment_legacy_aliases
    WHERE node_id = ${entry.legacy_node_id} AND normalized_path = ${entry.normalized_path}
    FOR UPDATE
  `;
  if (rows.length !== 1 || rows[0]!.asset_id !== attachmentId || rows[0]!.original_path !== entry.normalized_path || rows[0]!.availability !== "resolved") {
    throw publishError("ALIAS_CONFLICT", "a different alias already occupies this legacy path");
  }
}

async function verifyExistingAlias(
  sql: SqlTag,
  entry: PublishEntry,
  receipt: PublishReceipt,
  metadata: PublishMetadata,
): Promise<{ attachmentId: string; aliasCount: number }> {
  const assets = await sql`
    SELECT id, storage_key, storage_purpose, storage_endpoint, storage_bucket,
           byte_size, checksum_sha256, upload_status, garbage_collected_at
    FROM file_assets WHERE id = ${metadata.attachmentId} FOR UPDATE
  `;
  const asset = assets[0];
  if (!asset || asset.storage_purpose !== "attachment" || asset.upload_status !== "committed" ||
      asset.garbage_collected_at !== null || asset.storage_key !== receipt.storage_key ||
      (asset.storage_endpoint !== null && asset.storage_endpoint !== entry.storage_endpoint) ||
      (asset.storage_bucket !== null && asset.storage_bucket !== entry.storage_bucket) ||
      Number(asset.byte_size) !== receipt.byte_size || asset.checksum_sha256 !== receipt.sha256) {
    throw publishError("ASSET_METADATA_CONFLICT", "verified existing object differs from its committed asset row");
  }
  const aliases = await sql`
    SELECT asset_id, original_path, availability
    FROM attachment_legacy_aliases
    WHERE node_id = ${entry.legacy_node_id} AND normalized_path = ${entry.normalized_path}
    FOR UPDATE
  `;
  const aliasAssetId = entry.existing_alias?.asset_id;
  if (aliases.length !== 1 || !aliasAssetId || aliases[0]!.asset_id !== aliasAssetId || aliases[0]!.asset_id !== metadata.attachmentId ||
      aliases[0]!.original_path !== (entry.existing_alias?.original_path ?? entry.normalized_path) || aliases[0]!.availability !== "resolved") {
    throw publishError("ALIAS_CONFLICT", "the verified manifest alias differs from the committed alias row");
  }
  return { attachmentId: metadata.attachmentId, aliasCount: 1 };
}

function sameAssetMetadata(
  row: Record<string, unknown> | undefined,
  entry: PublishEntry,
  metadata: PublishMetadata,
  owner: { ownerKind: string | null; ownerKey: string | null; registrationScope: unknown | null },
  sourceSessionId: string | null,
): boolean {
  return row !== undefined && row.id === metadata.attachmentId && row.storage_key === metadata.storageKey &&
    row.storage_purpose === "attachment" && row.storage_endpoint === entry.storage_endpoint && row.storage_bucket === entry.storage_bucket &&
    row.owner_kind === owner.ownerKind && row.owner_key === owner.ownerKey && jsonEqual(row.registration_scope, owner.registrationScope) &&
    row.source_node_id === entry.legacy_node_id && row.source_session_id === sourceSessionId && row.output_command_id === null &&
    row.original_name === entry.name && row.mime_type === (entry.inferred_mime || "application/octet-stream") &&
    Number(row.byte_size) === metadata.byteSize && row.checksum_sha256 === metadata.checksumSha256 &&
    row.upload_status === "committed" && row.garbage_collected_at === null;
}

function ownerColumns(owner: InventoryOwnerEvidence): { ownerKind: string | null; ownerKey: string | null; registrationScope: unknown | null } {
  if (owner.status !== "verified" || (owner.kind !== "user_email" && owner.kind !== "agent_session") || !owner.key.trim()) {
    return { ownerKind: null, ownerKey: null, registrationScope: null };
  }
  return { ownerKind: owner.kind, ownerKey: owner.key, registrationScope: owner.scope ?? null };
}

function sourceSessionFor(entry: PublishEntry): string | null {
  if (entry.owner.status === "verified" && entry.owner.kind === "agent_session") return entry.owner.key;
  const sessionIds = [...new Set(entry.references.flatMap((reference) =>
    typeof reference.session_id === "string" && reference.session_id.length > 0 ? [reference.session_id] : []))];
  if (sessionIds.length === 1) return sessionIds[0]!;
  return null;
}

function jsonEqual(value: unknown, expected: unknown): boolean {
  if (expected === null) return value === null;
  try { return stableJson(value) === stableJson(expected); }
  catch { return false; }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function isCopyCandidateStatus(status: string): boolean {
  return status === "verified_source" || status === "owner_unverified" || status === "unreferenced_preservation_candidate";
}

function publishError(code: "APPROVAL_REQUIRED" | "ALIAS_CONFLICT" | "RECEIPT_MISMATCH" | "ASSET_METADATA_CONFLICT", message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

export function parsePublishOptions(args: string[]): PublishOptions {
  const values: Record<string, string> = {};
  let apply = false;
  for (let index = 0; index < args.length;) {
    const flag = args[index]!;
    if (flag === "--apply") {
      if (apply) throw new TypeError("--apply must not be repeated");
      apply = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (!flag.startsWith("--") || !value || value.startsWith("--") || values[flag] !== undefined ||
        !["--manifest", "--receipts", "--limit", "--only", "--approved-manifest-sha256"].includes(flag)) {
      throw new TypeError("usage: publish_assets.ts --manifest <JSONL> --receipts <JSONL> [--limit <N>] [--only <identity_key>] [--apply --approved-manifest-sha256 <sha256>]");
    }
    values[flag] = value;
    index += 2;
  }
  const manifest = values["--manifest"];
  const receipts = values["--receipts"];
  if (!manifest || !receipts) throw new TypeError("--manifest and --receipts are required");
  const limit = values["--limit"] === undefined ? undefined : Number(values["--limit"]);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new TypeError("--limit must be a positive integer");
  return {
    manifest,
    receipts,
    ...(limit === undefined ? {} : { limit }),
    ...(values["--only"] === undefined ? {} : { only: values["--only"] }),
    apply,
    ...(values["--approved-manifest-sha256"] === undefined ? {} : { approvedManifestSha256: values["--approved-manifest-sha256"] }),
  };
}

async function main(args: string[]): Promise<void> {
  const options = parsePublishOptions(args);
  const manifest = await readManifest(options.manifest);
  const mode = validatePublishApproval(options.apply, options.approvedManifestSha256, manifest.manifestHash);
  const entries = selectEntries(manifest.entries, options.only, options.limit);
  const receipts = await readReceipts(options.receipts);
  const eligible = entries.filter((entry) => {
    const receipt = receipts.get(entry.identity_key);
    return receipt !== undefined && (receipt.result === "copied" || receipt.result === "existing_verified" ||
      (entry.status === "confirmed_missing" && receipt.result === "skipped_unconfirmed"));
  });
  if (mode === "dry_run") {
    process.stdout.write(`${DRY_RUN_MARKER} ${JSON.stringify({
      manifest_sha256: manifest.manifestHash,
      selected: entries.length,
      eligible: eligible.length,
      missing_receipt: entries.length - entries.filter((entry) => receipts.has(entry.identity_key)).length,
      writes_enabled: false,
    })}\n`);
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  const endpoint = process.env.ATTACHMENT_MIGRATION_R2_ATTACHMENT_ENDPOINT;
  const bucket = process.env.ATTACHMENT_MIGRATION_R2_ATTACHMENT_BUCKET;
  if (!databaseUrl || !endpoint || !bucket) throw publishError("APPROVAL_REQUIRED", "approved apply requires DATABASE_URL and attachment R2 location settings");
  const db = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  let publishedAssets = 0;
  let publishedAliases = 0;
  let ineligible = 0;
  try {
    for (const entry of entries) {
      const receipt = receipts.get(entry.identity_key);
      if (!receipt) continue;
      const publishable = receipt.result === "copied" || receipt.result === "existing_verified" ||
        (entry.status === "confirmed_missing" && receipt.result === "skipped_unconfirmed");
      if (!publishable) { ineligible += 1; continue; }
      const result = await db.begin((tx) => publishVerifiedAssetTx(tx as unknown as SqlTag,
        { ...entry, storage_endpoint: endpoint, storage_bucket: bucket }, receipt));
      if (result.aliasCount > 0) publishedAliases += result.aliasCount;
      if (!isMissingIdentity(entry)) publishedAssets += 1;
    }
  } finally {
    await db.end({ timeout: 2 });
  }
  const missingReceipt = entries.length - entries.filter((entry) => receipts.has(entry.identity_key)).length;
  process.stdout.write(`${PUBLISHED_MARKER} assets=${publishedAssets} aliases=${publishedAliases} missing_receipt=${missingReceipt} ineligible_receipt=${ineligible}\n`);
}

async function readManifest(filePath: string): Promise<Manifest> {
  const bytes = await readFile(filePath);
  const manifestHash = createHash("sha256").update(bytes).digest("hex");
  const records = bytes.toString("utf8").split(/\r?\n/).filter((line) => line.length > 0).map(parseJsonLine);
  if (!isRecord(records[0]) || records[0].record_type !== "manifest_metadata" || records[0].dry_run !== true || records[0].writes_enabled !== false) {
    throw new Error("INVENTORY_MANIFEST_MISMATCH: manifest header is invalid");
  }
  const entries = records.slice(1).filter((row): row is PublishEntry => isRecord(row) && row.record_type === undefined && typeof row.identity_key === "string");
  return { manifestHash, entries };
}

async function readReceipts(filePath: string): Promise<Map<string, PublishReceipt>> {
  let body: string;
  try { body = await readFile(filePath, "utf8"); }
  catch (error) { if (isNodeError(error) && error.code === "ENOENT") return new Map(); throw error; }
  const receipts = new Map<string, PublishReceipt>();
  for (const line of body.split(/\r?\n/)) {
    if (!line) continue;
    const row = parseJsonLine(line);
    if (!isRecord(row) || typeof row.identity_key !== "string" || typeof row.attachment_id !== "string" ||
        typeof row.storage_key !== "string" || typeof row.verified_at !== "string" || typeof row.result !== "string") {
      throw new Error("INVENTORY_MANIFEST_MISMATCH: receipt JSONL row is invalid");
    }
    receipts.set(row.identity_key, row as unknown as PublishReceipt);
  }
  return receipts;
}

function parseJsonLine(line: string): unknown {
  try { return JSON.parse(line) as unknown; }
  catch { throw new Error("INVENTORY_MANIFEST_MISMATCH: JSONL contains invalid JSON"); }
}

function selectEntries(entries: readonly PublishEntry[], only: string | undefined, limit: number | undefined): PublishEntry[] {
  const filtered = only === undefined ? [...entries] : entries.filter((entry) => entry.identity_key === only);
  if (only !== undefined && filtered.length !== 1) throw new Error("INVENTORY_MANIFEST_MISMATCH: --only identity was not found exactly once");
  return limit === undefined ? filtered : filtered.slice(0, limit);
}

function isMissingIdentity(entry: PublishEntry): boolean {
  return entry.status === "confirmed_missing";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "INVENTORY_MANIFEST_MISMATCH";
    process.stderr.write(`${code}: ${error instanceof Error ? error.message : "asset publication failed"}\n`);
    process.exitCode = 1;
  });
}
