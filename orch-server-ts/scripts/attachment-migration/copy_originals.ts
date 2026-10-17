#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { verifyStoredObject } from "../../src/attachments/attachment_commit_contract.js";
import {
  createR2BoardAssetStorage,
  R2ObjectIntegrityError,
  R2StorageRequestError,
  type R2ObjectStorage,
} from "../../src/runtime/live_board_asset_storage.js";
import { type InventoryAssetSnapshot, type InventoryPlanIdentity } from "./inventory_contract.js";

const MAX_COPY_BYTES = 100 * 1024 * 1024;
const ORIGINALS_STORAGE_PREFIX = "session-attachments/originals";
const LEGACY_ORCH_URL = "http://127.0.0.1:5200";
const DRY_RUN_MARKER = "ATTACHMENT_MIGRATION_COPY_DRY_RUN";

export type CopyPlanEntry = Pick<InventoryPlanIdentity,
  "identity_key" | "legacy_node_id" | "normalized_path" | "name" | "inferred_mime" | "status" | "physical_path" | "size_bytes" | "sha256" | "proposed_asset_id" | "existing_alias">;

export type CopyReceipt = {
  identity_key: string;
  attachment_id: string;
  storage_key: string;
  byte_size: number | null;
  sha256: string | null;
  verified_at: string;
  result: "copied" | "existing_verified" | "skipped_unconfirmed" | `failed(${string})`;
};

type CopyFailureCode = "SOURCE_CHANGED" | "COPY_HASH_MISMATCH" | "COPY_STORAGE_UNAVAILABLE" | "COPY_SIZE_LIMIT";
type CopyFailure = Error & { readonly code: CopyFailureCode };
type CopyStorage = Pick<R2ObjectStorage, "putObject" | "headObject" | "openObject">;
type PurposeStorage = { readonly storage: R2ObjectStorage; readonly endpoint: string; readonly bucket: string };
type Manifest = { readonly manifestHash: string; readonly entries: CopyPlanEntry[]; readonly assets: InventoryAssetSnapshot[] };
type CopyOptions = {
  readonly manifest: string;
  readonly receipts?: string;
  readonly localNodeId?: string;
  readonly limit?: number;
  readonly only?: string;
  readonly apply: boolean;
  readonly approvedManifestSha256?: string;
};

export async function copyVerifiedSource(
  planEntry: CopyPlanEntry,
  source: AsyncIterable<Uint8Array>,
  storage: CopyStorage,
): Promise<CopyReceipt> {
  const attachmentId = planEntry.proposed_asset_id ?? planEntry.identity_key;
  const storageKey = `${ORIGINALS_STORAGE_PREFIX}/${attachmentId}`;
  if (!Number.isSafeInteger(planEntry.size_bytes) || planEntry.size_bytes! < 0 || !isSha256(planEntry.sha256)) {
    throw copyFailure("SOURCE_CHANGED", "manifest source size or checksum is missing");
  }
  if (planEntry.size_bytes! > MAX_COPY_BYTES) throw copyFailure("COPY_SIZE_LIMIT", "source exceeds the 100 MiB copy limit");
  const { directory, filePath, byteSize, checksumSha256 } = await spoolAndVerifySource(source, planEntry.size_bytes!, planEntry.sha256!);
  try {
    const existing = await readStoredObject(storage, storageKey, planEntry.size_bytes!);
    if (existing !== undefined) {
      if (existing.checksumSha256 !== planEntry.sha256) throw copyFailure("COPY_HASH_MISMATCH", "stored object differs from the approved source");
      return receipt(planEntry, attachmentId, storageKey, byteSize, checksumSha256, "existing_verified");
    }

    try {
      await storage.putObject({
        storageKey,
        mimeType: planEntry.inferred_mime || "application/octet-stream",
        byteSize,
        checksumSha256,
        body: fileChunks(filePath),
      });
      await verifyStoredObjectMatches(storage, storageKey, byteSize, checksumSha256);
    } catch (error) {
      if (isCopyFailure(error)) throw error;
      if (error instanceof R2ObjectIntegrityError) throw copyFailure("COPY_HASH_MISMATCH", "stored object integrity check failed", error);
      throw copyFailure("COPY_STORAGE_UNAVAILABLE", "could not copy and verify the R2 object", error);
    }
    return receipt(planEntry, attachmentId, storageKey, byteSize, checksumSha256, "copied");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function* fetchLegacySource(input: {
  readonly baseUrl: string;
  readonly nodeId: string;
  readonly path: string;
  readonly bearerToken: string;
  readonly fetcher?: typeof fetch;
}): AsyncIterable<Uint8Array> {
  if (!input.bearerToken) throw copyFailure("SOURCE_CHANGED", "service bearer is not configured");
  const url = new URL("/api/attachments/files", input.baseUrl);
  url.searchParams.set("nodeId", input.nodeId);
  url.searchParams.set("path", input.path);
  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(url, {
      method: "GET",
      headers: { authorization: `Bearer ${input.bearerToken}`, "accept-encoding": "identity" },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw copyFailure("SOURCE_CHANGED", "legacy source read failed", error);
  }
  if (response.status !== 200 || response.headers.get("content-encoding")?.toLowerCase() === "gzip") {
    await response.body?.cancel();
    throw copyFailure("SOURCE_CHANGED", `legacy source returned HTTP ${response.status} or encoded bytes`);
  }
  if (response.body === null) return;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      yield next.value;
    }
  } catch (error) {
    throw copyFailure("SOURCE_CHANGED", "legacy source stream ended before verification", error);
  } finally {
    reader.releaseLock();
  }
}

export function validateManifestApproval(apply: boolean, approvedHash: string | undefined, actualHash: string): "dry_run" | "apply" {
  if (!apply) return "dry_run";
  if (!isSha256(approvedHash) || approvedHash !== actualHash) {
    throw new Error("INVENTORY_APPROVAL_REQUIRED: --apply requires the matching --approved-manifest-sha256");
  }
  return "apply";
}

export function parseCopyOptions(args: string[]): CopyOptions {
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
        !["--manifest", "--receipts", "--local-node-id", "--limit", "--only", "--approved-manifest-sha256"].includes(flag)) {
      throw new TypeError("usage: copy_originals.ts --manifest <JSONL> [--receipts <JSONL>] [--local-node-id <node>] [--limit <N>] [--only <identity_key>] [--apply --approved-manifest-sha256 <sha256>]");
    }
    values[flag] = value;
    index += 2;
  }
  const manifest = values["--manifest"];
  if (!manifest) throw new TypeError("--manifest is required");
  const limit = values["--limit"] === undefined ? undefined : Number(values["--limit"]);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new TypeError("--limit must be a positive integer");
  const localNodeId = values["--local-node-id"];
  if (apply && !localNodeId) throw new TypeError("--local-node-id is required with --apply");
  if (apply && !values["--receipts"]) throw new TypeError("--receipts is required with --apply");
  return {
    manifest,
    ...(values["--receipts"] === undefined ? {} : { receipts: values["--receipts"] }),
    ...(localNodeId === undefined ? {} : { localNodeId }),
    ...(limit === undefined ? {} : { limit }),
    ...(values["--only"] === undefined ? {} : { only: values["--only"] }),
    apply,
    ...(values["--approved-manifest-sha256"] === undefined ? {} : { approvedManifestSha256: values["--approved-manifest-sha256"] }),
  };
}

async function main(args: string[]): Promise<void> {
  const options = parseCopyOptions(args);
  const manifest = await readManifest(options.manifest);
  const mode = validateManifestApproval(options.apply, options.approvedManifestSha256, manifest.manifestHash);
  const entries = selectEntries(manifest.entries, options.only, options.limit);
  if (mode === "dry_run") {
    process.stdout.write(`${DRY_RUN_MARKER} ${JSON.stringify({ manifest_sha256: manifest.manifestHash, selected: entries.length, writes_enabled: false })}\n`);
    return;
  }
  await copySelectedEntries(entries, manifest.assets, options.receipts!, options.localNodeId!);
}

async function copySelectedEntries(entries: readonly CopyPlanEntry[], assets: readonly InventoryAssetSnapshot[], receiptPath: string, localNodeId: string): Promise<void> {
  const receiptMap = await readReceipts(receiptPath);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const storages = new Map<string, PurposeStorage>();
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  await mkdir(path.dirname(path.resolve(receiptPath)), { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    let result: CopyReceipt;
    try {
      const aliasAssetId = entry.existing_alias?.asset_id;
      if (entry.status === "existing_alias_unverified" && aliasAssetId) {
        const asset = assetById.get(aliasAssetId);
        if (!asset) result = skippedReceipt(entry);
        else {
          const binding = storageForPurpose(asset.storage_purpose, storages);
          if ((asset.storage_endpoint && asset.storage_endpoint !== binding.endpoint) ||
              (asset.storage_bucket && asset.storage_bucket !== binding.bucket)) {
            throw copyFailure("COPY_STORAGE_UNAVAILABLE", "existing asset location does not match configured R2 settings");
          }
          result = await verifyExistingAsset(entry, asset, binding.storage);
        }
      } else if (!isCopyCandidate(entry)) {
        result = skippedReceipt(entry);
      } else {
        const targetAssetId = entry.proposed_asset_id ?? entry.identity_key;
        const storageKey = `${ORIGINALS_STORAGE_PREFIX}/${targetAssetId}`;
        const previous = receiptMap.get(entry.identity_key);
        const storage = storageForPurpose("attachment", storages).storage;
        if (previous && ["copied", "existing_verified"].includes(previous.result)) {
          result = await verifyPriorReceipt(entry, previous, storage);
          if (result.result === "existing_verified") {
            await appendReceipt(receiptPath, result);
            receiptMap.set(entry.identity_key, result);
            copied += 1;
            continue;
          }
        }
        const source = entry.legacy_node_id === localNodeId
          ? localFileSource(entry.physical_path)
          : fetchLegacySource({ baseUrl: LEGACY_ORCH_URL, nodeId: entry.legacy_node_id, path: entry.normalized_path, bearerToken: process.env.AUTH_BEARER_TOKEN ?? "" });
        result = await copyVerifiedSource(entry, source, storage);
        if (result.storage_key !== storageKey) throw copyFailure("COPY_HASH_MISMATCH", "copy receipt key does not match the approved identity");
      }
    } catch (error) {
      const code = isCopyFailure(error) ? error.code : "COPY_STORAGE_UNAVAILABLE";
      result = failedReceipt(entry, code);
    }
    await appendReceipt(receiptPath, result);
    receiptMap.set(entry.identity_key, result);
    if (result.result.startsWith("failed(")) {
      failed += 1;
      process.exitCode = 2;
      process.stdout.write(`COPY_FAILED identity_key=${entry.identity_key} result=${result.result}\n`);
      return;
    }
    if (result.result === "skipped_unconfirmed") skipped += 1;
    else copied += 1;
  }
  process.stdout.write(`COPY_VERIFIED copied=${copied} skipped_unconfirmed=${skipped} failed=${failed}\n`);
}

async function verifyPriorReceipt(entry: CopyPlanEntry, prior: CopyReceipt, storage: CopyStorage): Promise<CopyReceipt> {
  const attachmentId = entry.proposed_asset_id ?? entry.identity_key;
  const storageKey = `${ORIGINALS_STORAGE_PREFIX}/${attachmentId}`;
  if (prior.attachment_id !== attachmentId || prior.storage_key !== storageKey || prior.byte_size !== entry.size_bytes || prior.sha256 !== entry.sha256) {
    throw copyFailure("COPY_HASH_MISMATCH", "prior receipt does not match the approved manifest");
  }
  const existing = await readStoredObject(storage, storageKey, entry.size_bytes ?? 0);
  if (existing === undefined) return failedReceipt(entry, "SOURCE_CHANGED");
  if (existing.checksumSha256 !== prior.sha256) throw copyFailure("COPY_HASH_MISMATCH", "stored object differs from its prior receipt");
  return receipt(entry, attachmentId, storageKey, existing.byteSize, existing.checksumSha256, "existing_verified");
}

async function verifyExistingAsset(entry: CopyPlanEntry, asset: InventoryAssetSnapshot, storage: CopyStorage): Promise<CopyReceipt> {
  if (asset.upload_status !== "committed" || !asset.storage_key || typeof asset.byte_size !== "number" || !isSha256(asset.checksum_sha256)) {
    return skippedReceipt(entry);
  }
  const actual = await readStoredObject(storage, asset.storage_key, asset.byte_size);
  if (actual === undefined || actual.byteSize !== asset.byte_size || actual.checksumSha256 !== asset.checksum_sha256 ||
      (entry.sha256 !== undefined && entry.sha256 !== actual.checksumSha256)) {
    throw copyFailure("COPY_HASH_MISMATCH", "existing committed asset failed storage verification");
  }
  return receipt(entry, asset.id, asset.storage_key, actual.byteSize, actual.checksumSha256, "existing_verified");
}

function storageForPurpose(purpose: string, storages: Map<string, PurposeStorage>): PurposeStorage {
  const existing = storages.get(purpose);
  if (existing) return existing;
  if (purpose !== "attachment" && purpose !== "board") throw copyFailure("COPY_STORAGE_UNAVAILABLE", "unsupported R2 storage purpose");
  const prefix = `ATTACHMENT_MIGRATION_R2_${purpose.toUpperCase()}_`;
  const endpoint = process.env[`${prefix}ENDPOINT`];
  const bucket = process.env[`${prefix}BUCKET`];
  const accessKeyId = process.env[`${prefix}ACCESS_KEY_ID`];
  const secretAccessKey = process.env[`${prefix}SECRET_ACCESS_KEY`];
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw copyFailure("COPY_STORAGE_UNAVAILABLE", "R2 settings are not configured for this purpose");
  const binding = { storage: createR2BoardAssetStorage({ endpoint, bucket, accessKeyId, secretAccessKey }), endpoint, bucket };
  storages.set(purpose, binding);
  return binding;
}

async function readManifest(filePath: string): Promise<Manifest> {
  const bytes = await readFile(filePath);
  const manifestHash = createHash("sha256").update(bytes).digest("hex");
  const lines = bytes.toString("utf8").split(/\r?\n/).filter((line) => line.length > 0);
  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  if (!isRecord(records[0]) || records[0].record_type !== "manifest_metadata" || records[0].dry_run !== true || records[0].writes_enabled !== false) {
    throw new Error("INVENTORY_MANIFEST_MISMATCH: manifest header is invalid");
  }
  const entries = records.slice(1).filter((row) => row.record_type === undefined && typeof row.identity_key === "string") as unknown as CopyPlanEntry[];
  const assets = records.filter((row) => row.record_type === "existing_asset").map((row) => {
    const { record_type: _recordType, ...asset } = row;
    return asset as unknown as InventoryAssetSnapshot;
  });
  return { manifestHash, entries, assets };
}

function selectEntries(entries: readonly CopyPlanEntry[], only: string | undefined, limit: number | undefined): CopyPlanEntry[] {
  const filtered = only === undefined ? [...entries] : entries.filter((entry) => entry.identity_key === only);
  if (only !== undefined && filtered.length !== 1) throw new Error("INVENTORY_MANIFEST_MISMATCH: --only identity was not found exactly once");
  return limit === undefined ? filtered : filtered.slice(0, limit);
}

async function readReceipts(filePath: string): Promise<Map<string, CopyReceipt>> {
  let body: string;
  try { body = await readFile(filePath, "utf8"); }
  catch (error) { if (isNodeError(error) && error.code === "ENOENT") return new Map(); throw error; }
  const receipts = new Map<string, CopyReceipt>();
  for (const line of body.split(/\r?\n/)) {
    if (!line) continue;
    const row = JSON.parse(line) as CopyReceipt;
    if (!row.identity_key || !row.attachment_id || !row.storage_key || typeof row.verified_at !== "string" || typeof row.result !== "string") {
      throw new Error("INVENTORY_MANIFEST_MISMATCH: receipt JSONL row is invalid");
    }
    receipts.set(row.identity_key, row);
  }
  return receipts;
}

async function appendReceipt(filePath: string, value: CopyReceipt): Promise<void> {
  const handle = await open(filePath, "a", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

export async function* localFileSource(filePath: string | undefined): AsyncIterable<Uint8Array> {
  if (!filePath || !path.isAbsolute(filePath)) throw copyFailure("SOURCE_CHANGED", "local manifest source path is missing or relative");
  try {
    for await (const chunk of createReadStream(filePath)) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  } catch (error) {
    throw copyFailure("SOURCE_CHANGED", "local source file could not be read", error);
  }
}

async function spoolAndVerifySource(source: AsyncIterable<Uint8Array>, expectedSize: number, expectedHash: string): Promise<{ directory: string; filePath: string; byteSize: number; checksumSha256: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "attachment-copy-"));
  const filePath = path.join(directory, "source.bin");
  const handle = await open(filePath, "wx", 0o600);
  const hash = createHash("sha256");
  let byteSize = 0;
  let handleClosed = false;
  try {
    for await (const value of source) {
      const chunk = Buffer.from(value);
      byteSize += chunk.byteLength;
      if (byteSize > expectedSize || byteSize > MAX_COPY_BYTES) throw copyFailure("SOURCE_CHANGED", "source size changed while reading");
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    const checksumSha256 = hash.digest("hex");
    if (byteSize !== expectedSize || checksumSha256 !== expectedHash) throw copyFailure("SOURCE_CHANGED", "source bytes differ from the approved manifest");
    return { directory, filePath, byteSize, checksumSha256 };
  } catch (error) {
    await handle.close();
    handleClosed = true;
    await rm(directory, { recursive: true, force: true });
    if (isCopyFailure(error)) throw error;
    throw copyFailure("SOURCE_CHANGED", "source stream could not be verified", error);
  } finally {
    if (!handleClosed) await handle.close();
  }
}

async function* fileChunks(filePath: string): AsyncIterable<Uint8Array> {
  for await (const chunk of createReadStream(filePath)) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

async function readStoredObject(storage: CopyStorage, storageKey: string, expectedByteSize: number): Promise<{ byteSize: number; checksumSha256: string } | undefined> {
  try {
    const head = await storage.headObject({ storageKey });
    if (head.byteSize !== expectedByteSize) throw copyFailure("COPY_HASH_MISMATCH", "stored object size differs from the approved source");
  } catch (error) {
    if (error instanceof R2StorageRequestError && error.status === 404) return undefined;
    if (isCopyFailure(error)) throw error;
    throw copyFailure("COPY_STORAGE_UNAVAILABLE", "could not inspect the stored object", error);
  }
  try {
    return await verifyStoredObject({ storage, storageKey, expectedByteSize });
  } catch (error) {
    if (error instanceof R2StorageRequestError && error.status === 404) return undefined;
    if (error instanceof R2ObjectIntegrityError) throw copyFailure("COPY_HASH_MISMATCH", "stored object failed integrity verification", error);
    throw copyFailure("COPY_STORAGE_UNAVAILABLE", "could not read the stored object", error);
  }
}

async function verifyStoredObjectMatches(storage: CopyStorage, storageKey: string, expectedSize: number, expectedHash: string): Promise<void> {
  const head = await storage.headObject({ storageKey });
  if (head.byteSize !== expectedSize) throw copyFailure("COPY_HASH_MISMATCH", "stored object size differs from the source");
  const stored = await verifyStoredObject({ storage, storageKey, expectedByteSize: expectedSize });
  if (stored.checksumSha256 !== expectedHash) throw copyFailure("COPY_HASH_MISMATCH", "stored object checksum differs from the source");
}

function isCopyCandidate(entry: CopyPlanEntry): boolean {
  return entry.status === "verified_source" || entry.status === "owner_unverified" || entry.status === "unreferenced_preservation_candidate";
}

function receipt(entry: CopyPlanEntry, attachmentId: string, storageKey: string, byteSize: number, checksumSha256: string, result: CopyReceipt["result"]): CopyReceipt {
  return { identity_key: entry.identity_key, attachment_id: attachmentId, storage_key: storageKey, byte_size: byteSize,
    sha256: checksumSha256, verified_at: new Date().toISOString(), result };
}

function skippedReceipt(entry: CopyPlanEntry): CopyReceipt {
  return { identity_key: entry.identity_key, attachment_id: entry.proposed_asset_id ?? entry.existing_alias?.asset_id ?? entry.identity_key,
    storage_key: "", byte_size: null, sha256: null, verified_at: new Date().toISOString(), result: "skipped_unconfirmed" };
}

function failedReceipt(entry: CopyPlanEntry, code: CopyFailureCode): CopyReceipt {
  return { identity_key: entry.identity_key, attachment_id: entry.proposed_asset_id ?? entry.existing_alias?.asset_id ?? entry.identity_key,
    storage_key: "", byte_size: entry.size_bytes ?? null, sha256: entry.sha256 ?? null, verified_at: new Date().toISOString(), result: `failed(${code})` };
}

function copyFailure(code: CopyFailureCode, message: string, cause?: unknown): CopyFailure {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as CopyFailure;
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
}

function isCopyFailure(value: unknown): value is CopyFailure {
  return value instanceof Error && ["SOURCE_CHANGED", "COPY_HASH_MISMATCH", "COPY_STORAGE_UNAVAILABLE", "COPY_SIZE_LIMIT"].includes((value as CopyFailure).code);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException { return value instanceof Error && "code" in value; }
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "INVENTORY_MANIFEST_MISMATCH";
    process.stderr.write(`${code}: ${error instanceof Error ? error.message : "copy failed"}\n`);
    process.exitCode = 1;
  });
}
