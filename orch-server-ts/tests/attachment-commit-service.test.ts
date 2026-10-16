import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createOwnedAttachmentCommitService,
  type OwnedAttachmentUpload,
  verifyStoredObject,
} from "../src/attachments/attachment_commit_service.js";
import { R2ObjectIntegrityError, R2StorageRequestError } from "../src/runtime/live_board_asset_storage.js";

const now = new Date("2026-10-11T03:00:00.000Z");
const endpoint = "https://r2.example.test";
const location = { endpoint, bucket: "private-files" };
const owner = { kind: "user_email" as const, key: "owner@example.test" };
const registration = {
  registrationScope: { type: "folder" as const, id: "folder-a" },
  sourceNodeId: "node-a",
  sourceSessionId: "session-a",
  outputCommandId: "command-a",
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function spec(overrides: Record<string, unknown> = {}) {
  return {
    attachmentId: "attachment-a",
    owner,
    registration,
    originalName: "hello.txt",
    mimeType: "text/plain",
    byteSize: 3,
    ...overrides,
  };
}

function row(uploadSpec: ReturnType<typeof spec>, overrides: Record<string, unknown> = {}): OwnedAttachmentUpload {
  return {
    attachmentId: uploadSpec.attachmentId,
    storageKey: `session-attachments/originals/${uploadSpec.attachmentId}`,
    owner: uploadSpec.owner,
    registration: uploadSpec.registration,
    originalName: uploadSpec.originalName,
    mimeType: uploadSpec.mimeType,
    byteSize: uploadSpec.byteSize,
    storageEndpoint: endpoint,
    storageBucket: location.bucket,
    checksumSha256: null,
    uploadStatus: "pending" as const,
    multipartUploadId: null,
    createdAt: now,
    garbageCollectedAt: null,
    ...overrides,
  };
}

function createHarness(initialRow: OwnedAttachmentUpload | null = null) {
  let currentRow = initialRow;
  const events: string[] = [];
  const body = new Uint8Array([1, 2, 3]);
  const storage = {
    putObject: vi.fn(async () => { events.push("put"); }),
    openObject: vi.fn(async () => {
      events.push("get");
      return new Response(body, { status: 200, headers: { "content-length": "3" } });
    }),
    headObject: vi.fn(async () => { events.push("head"); return { byteSize: 3 }; }),
    createMultipartUpload: vi.fn(async () => ({
      uploadId: "upload-a",
      partSize: 16 * 1024 * 1024,
      parts: [{ partNumber: 1, uploadUrl: "https://r2.example.test/part-1" }],
    })),
    createMultipartPartUrls: vi.fn((input: { uploadId: string; partSize: number }) => ({
      uploadId: input.uploadId,
      partSize: input.partSize,
      parts: [{ partNumber: 1, uploadUrl: "https://r2.example.test/part-1" }],
    })),
    completeMultipartUpload: vi.fn(async () => { events.push("complete"); }),
    abortMultipartUpload: vi.fn(async () => { events.push("abort"); }),
    createPresignedPutUrl: vi.fn(async () => "https://r2.example.test/put"),
    createPresignedGetUrl: vi.fn(async () => "https://r2.example.test/get"),
    deleteObject: vi.fn(async () => { throw new Error("deleteObject is outside this service"); }),
  };
  const repository = {
    insertOwnedPending: vi.fn(async (input: Record<string, any>): Promise<OwnedAttachmentUpload | null> => {
      events.push("insert");
      if (currentRow === null) currentRow = row(input as ReturnType<typeof spec>);
      return currentRow;
    }),
    getOwnedUpload: vi.fn(async () => currentRow),
    setMultipartUploadId: vi.fn(async (input: { uploadId: string }) => {
      if (currentRow === null) return null;
      currentRow = { ...currentRow, multipartUploadId: input.uploadId };
      return currentRow;
    }),
    commitVerified: vi.fn(async (input: { checksumSha256: string }) => {
      events.push("commit");
      if (currentRow === null) return null;
      currentRow = { ...currentRow, checksumSha256: input.checksumSha256, uploadStatus: "committed", multipartUploadId: null };
      return currentRow;
    }),
    clearPendingMultipart: vi.fn(async () => { currentRow = currentRow && { ...currentRow, multipartUploadId: null }; return true; }),
    findLegacyAliasForAsset: vi.fn(async () => null),
    findLegacyAliasForUpload: vi.fn(async () => null),
    insertLegacyAlias: vi.fn(async () => null),
  };
  const binding = { storage, identity: "binding-v1", location };
  const resolveAttachmentBinding = vi.fn(async (): Promise<typeof binding | null> => binding);
  const service = createOwnedAttachmentCommitService({
    repository,
    resolveAttachmentBinding,
    now: () => new Date(now),
  });
  return { service, repository, storage, binding, resolveAttachmentBinding, events, body, get row() { return currentRow; }, set row(value) { currentRow = value; } };
}

describe("owned attachment commit service", () => {
  it("PUTs exact bytes, verifies a streaming GET, then commits the digest", async () => {
    const h = createHarness();
    const bytes = new Uint8Array([1, 2, 3]);

    const result = await h.service.putSmall({ spec: spec(), body: bytes });

    expect(h.events).toEqual(["insert", "put", "get", "commit"]);
    expect(h.storage.putObject).toHaveBeenCalledWith(expect.objectContaining({
      storageKey: "session-attachments/originals/attachment-a",
      mimeType: "text/plain",
      byteSize: 3,
      checksumSha256: sha256(bytes),
      body: bytes,
    }));
    expect(h.repository.commitVerified).toHaveBeenCalledWith(expect.objectContaining({
      attachmentId: "attachment-a",
      owner,
      expectedByteSize: 3,
      checksumSha256: sha256(bytes),
    }));
    expect(result).toMatchObject({ attachmentId: "attachment-a", byteSize: 3, checksumSha256: sha256(bytes) });
  });

  it("stores browser-produced bytes with null source node and preserves the source session", async () => {
    const h = createHarness();
    const browserRegistration = { ...registration, sourceNodeId: null };

    await h.service.putSmall({
      spec: spec({ registration: browserRegistration }),
      body: new Uint8Array([1, 2, 3]),
    });

    expect(h.repository.insertOwnedPending).toHaveBeenCalledWith(expect.objectContaining({
      registration: browserRegistration,
    }));
    expect(h.row?.registration).toMatchObject({ sourceNodeId: null, sourceSessionId: "session-a" });
  });

  it("rejects an empty source node instead of treating it as browser provenance", async () => {
    const h = createHarness();

    await expect(h.service.putSmall({
      spec: spec({ registration: { ...registration, sourceNodeId: "" } }),
      body: new Uint8Array([1, 2, 3]),
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(h.repository.insertOwnedPending).not.toHaveBeenCalled();
  });

  it("accepts a zero-byte upload and its SHA-256", async () => {
    const h = createHarness();
    const empty = new Uint8Array();
    h.storage.openObject.mockResolvedValue(new Response(null, { status: 200, headers: { "content-length": "0" } }));

    await expect(h.service.putSmall({
      spec: spec({ byteSize: 0, checksumSha256: sha256(empty) }),
      body: empty,
    })).resolves.toMatchObject({ byteSize: 0, checksumSha256: sha256(empty) });
    expect(h.storage.putObject).toHaveBeenCalledOnce();
  });

  it("rejects a client checksum before creating a row or sending a PUT", async () => {
    const h = createHarness();

    await expect(h.service.putSmall({
      spec: spec({ checksumSha256: "0".repeat(64) }),
      body: new Uint8Array([1, 2, 3]),
    })).rejects.toMatchObject({ code: "checksum_mismatch", statusCode: 422 });

    expect(h.repository.insertOwnedPending).not.toHaveBeenCalled();
    expect(h.storage.putObject).not.toHaveBeenCalled();
  });

  it("returns a matching committed small upload without another R2 request", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const committed = row(spec(), { checksumSha256: sha256(bytes), uploadStatus: "committed" });
    const h = createHarness(committed);

    await expect(h.service.putSmall({ spec: spec(), body: bytes })).resolves.toMatchObject({
      attachmentId: "attachment-a",
      checksumSha256: sha256(bytes),
    });
    expect(h.storage.putObject).not.toHaveBeenCalled();
    expect(h.storage.openObject).not.toHaveBeenCalled();
  });

  it("verifies and commits an identical object after conditional PUT reports it already exists", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const h = createHarness();
    h.storage.putObject.mockRejectedValueOnce(new R2StorageRequestError("put object", 412));

    await expect(h.service.putSmall({ spec: spec(), body: bytes })).resolves.toMatchObject({
      attachmentId: "attachment-a",
      checksumSha256: sha256(bytes),
    });

    expect(h.storage.openObject).toHaveBeenCalledOnce();
    expect(h.repository.commitVerified).toHaveBeenCalledOnce();
  });

  it("preserves an existing different object after conditional PUT reports a conflict", async () => {
    const h = createHarness();
    h.storage.putObject.mockRejectedValueOnce(new R2StorageRequestError("put object", 412));
    h.storage.openObject.mockResolvedValueOnce(new Response(new Uint8Array([3, 2, 1]), {
      status: 200,
      headers: { "content-length": "3" },
    }));

    await expect(h.service.putSmall({ spec: spec(), body: new Uint8Array([1, 2, 3]) }))
      .rejects.toMatchObject({ statusCode: 409 });

    expect(h.repository.commitVerified).not.toHaveBeenCalled();
  });

  it("rejects an ID already owned by a different caller", async () => {
    const h = createHarness();
    h.repository.insertOwnedPending.mockResolvedValue(null);

    await expect(h.service.putSmall({
      spec: spec({ owner: { kind: "user_email", key: "other@example.test" } }),
      body: new Uint8Array([1, 2, 3]),
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(h.storage.putObject).not.toHaveBeenCalled();
  });

  it("reuses an active multipart ID and derives URL expiry from the original pending row", async () => {
    const existing = row(spec({ byteSize: 20 }), {
      byteSize: 20,
      multipartUploadId: "existing-upload",
      createdAt: new Date(now.getTime() - 90_000),
    });
    const h = createHarness(existing);

    const result = await h.service.initMultipart({ spec: spec({ byteSize: 20 }) });

    expect(h.storage.createMultipartUpload).not.toHaveBeenCalled();
    expect(h.storage.createMultipartPartUrls).toHaveBeenCalledWith(expect.objectContaining({
      storageKey: existing.storageKey,
      uploadId: "existing-upload",
      expiresSeconds: 3510,
    }));
    expect(result.ticket).toMatchObject({ importId: "attachment-a", uploadId: "existing-upload", exp: Math.floor(now.getTime() / 1000) + 3510 });
  });

  it("returns multipart tickets with null source node and preserved source session", async () => {
    const h = createHarness();
    const browserRegistration = { ...registration, sourceNodeId: null };

    const result = await h.service.initMultipart({ spec: spec({ byteSize: 20, registration: browserRegistration }) });

    expect(h.repository.insertOwnedPending).toHaveBeenCalledWith(expect.objectContaining({
      registration: browserRegistration,
    }));
    expect(result.ticket).toMatchObject({ sourceNodeId: null, sourceSessionId: "session-a" });
  });

  it("completes only when the stored object is absent and verifies the assembled object", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const browserRegistration = { ...registration, sourceNodeId: null };
    const ticket = {
      importId: "attachment-a",
      storageKey: "session-attachments/originals/attachment-a",
      uploadId: "upload-a",
      filename: "hello.txt",
      size: 3,
      contentType: "text/plain",
      sourceSessionId: "session-a",
      sourceNodeId: null,
      settingsIdentity: "binding-v1",
      exp: Math.floor(now.getTime() / 1000) + 3600,
      checksumSha256: sha256(bytes),
    };
    const pending = row(spec({ registration: browserRegistration }), { multipartUploadId: "upload-a" });
    const h = createHarness(pending);
    h.storage.headObject.mockRejectedValueOnce(new R2StorageRequestError("head object", 404));

    const result = await h.service.completeMultipart({ owner, ticket, parts: [{ partNumber: 1, etag: "etag" }] });

    expect(h.storage.completeMultipartUpload).toHaveBeenCalledWith({
      storageKey: pending.storageKey,
      uploadId: "upload-a",
      parts: [{ partNumber: 1, etag: "etag" }],
    });
    expect(h.storage.openObject).toHaveBeenCalledOnce();
    expect(result.checksumSha256).toBe(sha256(bytes));
  });

  it("checks the key once when R2 reports NoSuchUpload during completion", async () => {
    const pending = row(spec(), { multipartUploadId: "upload-a" });
    const h = createHarness(pending);
    h.storage.headObject
      .mockRejectedValueOnce(new R2StorageRequestError("head object", 404))
      .mockResolvedValueOnce({ byteSize: 3 });
    h.storage.completeMultipartUpload.mockRejectedValueOnce(
      new R2StorageRequestError("complete multipart upload", 404),
    );
    const ticket = {
      importId: "attachment-a", storageKey: pending.storageKey, uploadId: "upload-a",
      filename: "hello.txt", size: 3, contentType: "text/plain", sourceSessionId: "session-a",
      sourceNodeId: "node-a", settingsIdentity: "binding-v1", exp: Math.floor(now.getTime() / 1000) + 3600,
    };

    await expect(h.service.completeMultipart({ owner, ticket, parts: [] })).resolves.toMatchObject({ attachmentId: "attachment-a" });

    expect(h.storage.completeMultipartUpload).toHaveBeenCalledOnce();
    expect(h.storage.headObject).toHaveBeenCalledTimes(2);
    expect(h.storage.openObject).toHaveBeenCalledOnce();
  });

  it("recovers a completed R2 object after a prior DB failure and makes ticket retries idempotent", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const ticket = {
      importId: "attachment-a",
      storageKey: "session-attachments/originals/attachment-a",
      uploadId: "upload-a",
      filename: "hello.txt",
      size: 3,
      contentType: "text/plain",
      sourceSessionId: "session-a",
      sourceNodeId: "node-a",
      settingsIdentity: "binding-v1",
      exp: Math.floor(now.getTime() / 1000) + 3600,
    };
    const pending = row(spec(), { multipartUploadId: "upload-a" });
    const h = createHarness(pending);

    await h.service.completeMultipart({ owner, ticket, parts: [{ partNumber: 1, etag: "etag" }] });
    const requestCounts = { complete: h.storage.completeMultipartUpload.mock.calls.length, get: h.storage.openObject.mock.calls.length };
    await h.service.completeMultipart({ owner, ticket, parts: [{ partNumber: 1, etag: "etag" }] });

    expect(requestCounts).toEqual({ complete: 0, get: 1 });
    expect(h.storage.completeMultipartUpload).toHaveBeenCalledTimes(0);
    expect(h.storage.openObject).toHaveBeenCalledTimes(1);
    expect(h.storage.headObject).toHaveBeenCalledTimes(1);
  });

  it("does not interpret a storage 403 as a missing object", async () => {
    const pending = row(spec(), { multipartUploadId: "upload-a" });
    const h = createHarness(pending);
    h.storage.headObject.mockRejectedValueOnce(new R2StorageRequestError("head object", 403));
    const ticket = {
      importId: "attachment-a", storageKey: pending.storageKey, uploadId: "upload-a",
      filename: "hello.txt", size: 3, contentType: "text/plain", sourceSessionId: "session-a",
      sourceNodeId: "node-a", settingsIdentity: "binding-v1", exp: Math.floor(now.getTime() / 1000) + 3600,
    };

    await expect(h.service.completeMultipart({ owner, ticket, parts: [] })).rejects.toMatchObject({ statusCode: 502 });
    expect(h.storage.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it("does not abort or delete an already committed object", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const committed = row(spec(), { checksumSha256: sha256(bytes), uploadStatus: "committed" });
    const h = createHarness(committed);
    const ticket = {
      importId: "attachment-a", storageKey: committed.storageKey, uploadId: "upload-a",
      filename: "hello.txt", size: 3, contentType: "text/plain", sourceSessionId: "session-a",
      sourceNodeId: "node-a", settingsIdentity: "stale-binding-is-ignored", exp: Math.floor(now.getTime() / 1000) + 3600,
    };

    await h.service.abortMultipart({ owner, ticket });

    expect(h.storage.abortMultipartUpload).not.toHaveBeenCalled();
    expect(h.storage.deleteObject).not.toHaveBeenCalled();
    expect(h.repository.clearPendingMultipart).not.toHaveBeenCalled();
  });

  it("aborts only a pending multipart upload and clears its matching ID", async () => {
    const pending = row(spec(), { multipartUploadId: "upload-a" });
    const h = createHarness(pending);
    const ticket = {
      importId: "attachment-a", storageKey: pending.storageKey, uploadId: "upload-a",
      filename: "hello.txt", size: 3, contentType: "text/plain", sourceSessionId: "session-a",
      sourceNodeId: "node-a", settingsIdentity: "binding-v1", exp: Math.floor(now.getTime() / 1000) + 3600,
    };

    await h.service.abortMultipart({ owner, ticket });

    expect(h.storage.abortMultipartUpload).toHaveBeenCalledWith({ storageKey: pending.storageKey, uploadId: "upload-a" });
    expect(h.repository.clearPendingMultipart).toHaveBeenCalledWith({ attachmentId: "attachment-a", owner, expectedUploadId: "upload-a" });
    expect(h.storage.deleteObject).not.toHaveBeenCalled();
  });

  it("keeps a pending row when the binding changes after the verified GET", async () => {
    const h = createHarness();
    h.resolveAttachmentBinding
      .mockResolvedValueOnce(h.binding)
      .mockResolvedValueOnce({ ...h.binding, identity: "binding-v2" });

    await expect(h.service.putSmall({ spec: spec(), body: new Uint8Array([1, 2, 3]) }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(h.repository.commitVerified).not.toHaveBeenCalled();
  });

  it("reports a conflict when the attachment binding disappears after the verified GET", async () => {
    const h = createHarness();
    h.resolveAttachmentBinding
      .mockResolvedValueOnce(h.binding)
      .mockResolvedValueOnce(null);

    await expect(h.service.putSmall({ spec: spec(), body: new Uint8Array([1, 2, 3]) }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(h.repository.commitVerified).not.toHaveBeenCalled();
  });
});

describe("stored attachment verification", () => {
  it("counts and hashes streamed bytes without buffering the complete object", async () => {
    const storage = {
      openObject: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.enqueue(new Uint8Array([2, 3]));
          controller.close();
        },
      }), { status: 200, headers: { "content-length": "3" } })),
    };

    await expect(verifyStoredObject({
      storage: storage as never,
      storageKey: "session-attachments/originals/attachment-a",
      expectedByteSize: 3,
    })).resolves.toEqual({ byteSize: 3, checksumSha256: sha256(new Uint8Array([1, 2, 3])) });
  });

  it("stops reading when the stored response exceeds the registered size", async () => {
    const cancel = vi.fn();
    const storage = {
      openObject: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); },
        cancel,
      }), { status: 200, headers: { "content-length": "4" } })),
    };

    await expect(verifyStoredObject({ storage: storage as never, storageKey: "key", expectedByteSize: 3 }))
      .rejects.toBeInstanceOf(R2ObjectIntegrityError);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
