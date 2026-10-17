import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  copyVerifiedSource,
  fetchLegacySource,
  localFileSource,
  parseReceiptRow,
  remoteSourcePath,
  validateManifestApproval,
  type CopyPlanEntry,
} from "../../scripts/attachment-migration/copy_originals.js";
import { R2StorageRequestError, type R2ObjectStorage } from "../../src/runtime/live_board_asset_storage.js";

const bytes = new TextEncoder().encode("legacy attachment");
const hash = sha256(bytes);
const storageLocation = { endpoint: "https://r2.example.test", bucket: "private-attachments" };
const cliPath = fileURLToPath(new URL("../../scripts/attachment-migration/copy_originals.ts", import.meta.url));

describe("attachment migration original copy", () => {
  it("reads remote originals by the legacy evidence path, or by the scanned absolute path for unreferenced files", () => {
    expect(remoteSourcePath({ normalized_path: "D:/root/incoming/s/a.png", physical_path: "D:\\root\\incoming\\s\\a.png" }))
      .toBe("D:/root/incoming/s/a.png");
    expect(remoteSourcePath({ normalized_path: "/home/n/incoming/s/a.png", physical_path: undefined }))
      .toBe("/home/n/incoming/s/a.png");
    // Unreferenced incoming files are keyed relative to the incoming root; the orch legacy route needs an absolute path.
    expect(remoteSourcePath({ normalized_path: "s/assets/x/note.txt", physical_path: "/home/n/incoming/s/assets/x/note.txt" }))
      .toBe("/home/n/incoming/s/assets/x/note.txt");
    expect(remoteSourcePath({ normalized_path: "s/a.png", physical_path: "D:\\root\\incoming\\s\\a.png" }))
      .toBe("D:/root/incoming/s/a.png");
    expect(() => remoteSourcePath({ normalized_path: "s/a.png", physical_path: "s/a.png" }))
      .toThrow(expect.objectContaining({ code: "SOURCE_CHANGED" }));
  });

  it("reads back its own skipped and failed receipts but still requires a storage key for verified copies", () => {
    const base = { identity_key: "i", attachment_id: "a", storage_endpoint: null, storage_bucket: null, byte_size: null, sha256: null,
      verified_at: "2026-10-17T00:00:00.000Z" };
    expect(parseReceiptRow({ ...base, storage_key: "", result: "skipped_unconfirmed" }).result).toBe("skipped_unconfirmed");
    expect(parseReceiptRow({ ...base, storage_key: "", result: "failed(SOURCE_CHANGED)" }).result).toBe("failed(SOURCE_CHANGED)");
    expect(() => parseReceiptRow({ ...base, storage_key: "", result: "copied" })).toThrow("receipt JSONL row is invalid");
    expect(() => parseReceiptRow({ ...base, storage_key: "", result: "existing_verified" })).toThrow("receipt JSONL row is invalid");
    expect(parseReceiptRow({ ...base, storage_key: "session-attachments/originals/a", result: "copied" }).storage_key)
      .toBe("session-attachments/originals/a");
  });

  it("streams and verifies a source before storing it under the attachment original key", async () => {
    const storage = memoryStorage();
    const receipt = await copyVerifiedSource(entry(), chunks(bytes), storageBinding(storage));

    expect(receipt).toMatchObject({
      identity_key: "identity-a",
      attachment_id: "legacy-identity-a",
      storage_key: "session-attachments/originals/legacy-identity-a",
      storage_endpoint: storageLocation.endpoint,
      storage_bucket: storageLocation.bucket,
      byte_size: bytes.byteLength,
      sha256: hash,
      result: "copied",
    });
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    expect(storage.objects.get(receipt.storage_key)).toEqual(bytes);
  });

  it("accepts a zero-byte source and streams large input in chunks", async () => {
    const emptyStorage = memoryStorage();
    const empty = new Uint8Array();
    await expect(copyVerifiedSource(entry(empty), chunks(empty), storageBinding(emptyStorage))).resolves.toMatchObject({
      byte_size: 0,
      sha256: sha256(empty),
      result: "copied",
    });

    const largeStorage = memoryStorage();
    const large = new Uint8Array(2 * 1024 * 1024).fill(7);
    const receipt = await copyVerifiedSource(entry(large), chunks(large, 32 * 1024), storageBinding(largeStorage));
    expect(receipt).toMatchObject({ byte_size: large.byteLength, sha256: sha256(large), result: "copied" });
    expect(largeStorage.putObject).toHaveBeenCalledTimes(1);
  });

  it("rechecks the stored object on repeat and does not PUT again", async () => {
    const storage = memoryStorage();
    const first = await copyVerifiedSource(entry(), chunks(bytes), storageBinding(storage));
    const second = await copyVerifiedSource(entry(), chunks(bytes), storageBinding(storage));

    expect(first.result).toBe("copied");
    expect(second.result).toBe("existing_verified");
    expect(second).toMatchObject({ storage_endpoint: storageLocation.endpoint, storage_bucket: storageLocation.bucket });
    expect(storage.putObject).toHaveBeenCalledTimes(1);
  });

  it("rejects changed source bytes before any storage write", async () => {
    const storage = memoryStorage();
    await expect(copyVerifiedSource(entry(), chunks(new TextEncoder().encode("changed")), storageBinding(storage)))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it("copies and verifies an approved source above 100 MiB using bounded chunks", async () => {
    const chunk = new Uint8Array(32 * 1024).fill(7);
    const byteSize = 100 * 1024 * 1024 + 1;
    const checksumSha256 = sha256Repeated(chunk, byteSize);
    const storage = streamedPatternStorage(chunk, byteSize);
    const approvedEntry = { ...entry(), size_bytes: byteSize, sha256: checksumSha256 };

    const receipt = await copyVerifiedSource(approvedEntry, repeatedChunks(chunk, byteSize), storageBinding(storage));

    expect(receipt).toMatchObject({ byte_size: byteSize, sha256: checksumSha256, result: "copied" });
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    expect(storage.maxChunkSize()).toBeLessThanOrEqual(64 * 1024);
    expect(storage.headObject).toHaveBeenCalledTimes(2);
    expect(storage.openObject).toHaveBeenCalledTimes(1);
  });

  it("rejects a conflicting object already stored at the target key", async () => {
    const storage = memoryStorage();
    storage.objects.set("session-attachments/originals/legacy-identity-a", new TextEncoder().encode("other"));

    await expect(copyVerifiedSource(entry(), chunks(bytes), storageBinding(storage))).rejects.toMatchObject({ code: "COPY_HASH_MISMATCH" });
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it("reports storage write failures without accepting an unverified copy", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "attachment-copy-source-preserved-"));
    const sourcePath = path.join(temp, "original.bin");
    await writeFile(sourcePath, bytes);
    const storage = memoryStorage();
    storage.putObject.mockRejectedValueOnce(new Error("storage unavailable"));
    try {
      await expect(copyVerifiedSource(entry(), localFileSource(sourcePath), storageBinding(storage))).rejects.toMatchObject({ code: "COPY_STORAGE_UNAVAILABLE" });
      expect(await readFile(sourcePath)).toEqual(Buffer.from(bytes));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("fetches remote originals through the legacy GET with identity encoding and service bearer", async () => {
    const server = createServer((request, response) => {
      expect(request.method).toBe("GET");
      expect(request.url).toBe("/api/attachments/files?nodeId=node-a&path=%2Fincoming%2Fa.png");
      expect(request.headers.authorization).toBe("Bearer test-service-token");
      expect(request.headers["accept-encoding"]).toBe("identity");
      response.writeHead(200, { "content-length": String(bytes.byteLength), "content-type": "image/png" });
      response.end(bytes);
    });
    const baseUrl = await listen(server);
    try {
      const result = await collect(fetchLegacySource({
        baseUrl,
        nodeId: "node-a",
        path: "/incoming/a.png",
        bearerToken: "test-service-token",
      }));
      expect(result).toEqual(bytes);
    } finally {
      await close(server);
    }
  });

  it.each([403, 404, 502])("reports a legacy source HTTP %i response as a source change", async (status) => {
    const server = createServer((_request, response) => {
      response.writeHead(status);
      response.end();
    });
    const baseUrl = await listen(server);
    try {
      await expect(collect(fetchLegacySource({
        baseUrl,
        nodeId: "node-a",
        path: "/incoming/a.png",
        bearerToken: "test-service-token",
      }))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    } finally {
      await close(server);
    }
  });

  it("keeps dry-run as the default and requires the approved manifest hash for apply", () => {
    const digest = "a".repeat(64);
    expect(validateManifestApproval(false, undefined, digest)).toBe("dry_run");
    expect(() => validateManifestApproval(true, undefined, digest)).toThrow("INVENTORY_APPROVAL_REQUIRED");
    expect(() => validateManifestApproval(true, "b".repeat(64), digest)).toThrow("INVENTORY_APPROVAL_REQUIRED");
    expect(validateManifestApproval(true, digest, digest)).toBe("apply");
  });

  it("runs the CLI as dry-run by default and rejects apply without manifest approval", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "attachment-copy-cli-"));
    const manifestPath = path.join(temp, "manifest.jsonl");
    const receiptsPath = path.join(temp, "receipts.jsonl");
    const manifest = [
      { record_type: "manifest_metadata", dry_run: true, writes_enabled: false },
      { identity_key: "identity-a", status: "verified_source" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(manifestPath, manifest);
    try {
      const dryRun = spawnSync("pnpm", ["exec", "tsx", cliPath, "--manifest", manifestPath, "--limit", "1", "--only", "identity-a"], {
        cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      });
      expect(dryRun.status, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
      expect(dryRun.stdout).toContain('"writes_enabled":false');

      const apply = spawnSync("pnpm", ["exec", "tsx", cliPath, "--manifest", manifestPath, "--receipts", receiptsPath,
        "--local-node-id", "node-a", "--apply"], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
      expect(apply.status).toBe(1);
      expect(apply.stderr).toContain("INVENTORY_APPROVAL_REQUIRED");
      await expect(readFile(receiptsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

function entry(value = bytes): CopyPlanEntry {
  return {
    identity_key: "identity-a",
    proposed_asset_id: "legacy-identity-a",
    legacy_node_id: "eiaserinnys",
    normalized_path: "/incoming/a.png",
    name: "a.png",
    inferred_mime: "image/png",
    status: "verified_source",
    physical_path: "/srv/incoming/a.png",
    size_bytes: value.byteLength,
    sha256: sha256(value),
  };
}

function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const putObject = vi.fn(async ({ storageKey, body }: Parameters<R2ObjectStorage["putObject"]>[0]) => {
    objects.set(storageKey, body instanceof Uint8Array ? body : await collect(body));
  });
  const storage = {
    putObject,
    headObject: vi.fn(async ({ storageKey }: { storageKey: string }) => {
      const object = objects.get(storageKey);
      if (object === undefined) throw new R2StorageRequestError("head object", 404);
      return { byteSize: object.byteLength, mimeType: "image/png" };
    }),
    openObject: vi.fn(async ({ storageKey }: { storageKey: string }) => {
      const object = objects.get(storageKey);
      return object === undefined
        ? new Response(null, { status: 404 })
        : new Response(object, { status: 200, headers: { "content-length": String(object.byteLength) } });
    }),
  } as unknown as R2ObjectStorage;
  return { ...storage, objects, putObject };
}

function storageBinding(storage: R2ObjectStorage) {
  return { storage, ...storageLocation };
}

function streamedPatternStorage(pattern: Uint8Array, expectedSize: number) {
  let stored: { storageKey: string; byteSize: number; checksumSha256: string } | undefined;
  let maxChunk = 0;
  const putObject = vi.fn(async ({ storageKey, body, byteSize, checksumSha256 }: Parameters<R2ObjectStorage["putObject"]>[0]) => {
    const hash = createHash("sha256");
    let actualSize = 0;
    for await (const value of body as AsyncIterable<Uint8Array>) {
      maxChunk = Math.max(maxChunk, value.byteLength);
      actualSize += value.byteLength;
      hash.update(value);
    }
    const actualHash = hash.digest("hex");
    if (actualSize !== byteSize || actualHash !== checksumSha256) throw new Error("fake storage received unexpected bytes");
    stored = { storageKey, byteSize: actualSize, checksumSha256: actualHash };
  });
  const storage = {
    putObject,
    headObject: vi.fn(async ({ storageKey }: { storageKey: string }) => {
      if (!stored || stored.storageKey !== storageKey) throw new R2StorageRequestError("head object", 404);
      return { byteSize: stored.byteSize, mimeType: "image/png" };
    }),
    openObject: vi.fn(async ({ storageKey }: { storageKey: string }) => {
      if (!stored || stored.storageKey !== storageKey) return new Response(null, { status: 404 });
      let remaining = expectedSize;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (remaining === 0) { controller.close(); return; }
          const next = pattern.subarray(0, Math.min(pattern.byteLength, remaining));
          remaining -= next.byteLength;
          controller.enqueue(next);
        },
      });
      return new Response(body, { status: 200, headers: { "content-length": String(expectedSize) } });
    }),
  } as unknown as R2ObjectStorage;
  return { ...storage, putObject, maxChunkSize: () => maxChunk };
}

async function* chunks(value: Uint8Array, chunkSize = 5): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < value.byteLength; offset += chunkSize) yield value.slice(offset, offset + chunkSize);
}

async function* repeatedChunks(pattern: Uint8Array, byteSize: number): AsyncIterable<Uint8Array> {
  for (let remaining = byteSize; remaining > 0;) {
    const next = pattern.subarray(0, Math.min(pattern.byteLength, remaining));
    remaining -= next.byteLength;
    yield next;
  }
}

function sha256Repeated(pattern: Uint8Array, byteSize: number): string {
  const hash = createHash("sha256");
  for (let remaining = byteSize; remaining > 0;) {
    const next = pattern.subarray(0, Math.min(pattern.byteLength, remaining));
    remaining -= next.byteLength;
    hash.update(next);
  }
  return hash.digest("hex");
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const values: Uint8Array[] = [];
  let size = 0;
  for await (const value of source) { values.push(value); size += value.byteLength; }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const value of values) { output.set(value, offset); offset += value.byteLength; }
  return output;
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
