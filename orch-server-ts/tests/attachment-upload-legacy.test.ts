import { describe, expect, it, vi } from "vitest";

import type {
  AttachmentCommitRepository,
  AttachmentLegacyAlias,
  CommitResult,
} from "../src/attachments/attachment_commit_contract.js";
import {
  AttachmentTransportConnectionError,
  AttachmentTransportTimeoutError,
} from "../src/attachments/attachment_routes.js";
import { finishLegacyUpload } from "../src/attachments/attachment_upload_legacy.js";

const committed: CommitResult = {
  attachmentId: "asset-a",
  storageKey: "session-attachments/originals/asset-a",
  storageEndpoint: "https://r2.example.test",
  storageBucket: "private-files",
  originalName: "report.txt",
  mimeType: "text/plain",
  byteSize: 42,
  checksumSha256: "a".repeat(64),
};

const workerResult = {
  path: "C:\\out\\report.txt",
  filename: "report.txt",
  size: 42,
  content_type: "text/plain",
};

function resolvedAlias(overrides: Partial<AttachmentLegacyAlias> = {}): AttachmentLegacyAlias {
  return {
    nodeId: "node-a",
    normalizedPath: "C:/out/report.txt",
    assetId: "asset-a",
    originalPath: "C:\\out\\report.txt",
    availability: "resolved",
    ...overrides,
  };
}

function createHarness(options: {
  stored?: AttachmentLegacyAlias | null;
  insert?: AttachmentLegacyAlias | null;
} = {}) {
  const mocks = {
    findLegacyAliasForUpload: vi.fn(async () => options.stored ?? null),
    insertLegacyAlias: vi.fn(async (input: {
      nodeId: string;
      normalizedPath: string;
      assetId: string;
      originalPath: string;
    }): Promise<AttachmentLegacyAlias | null> => (
      options.insert === undefined
        ? resolvedAlias({
          nodeId: input.nodeId,
          normalizedPath: input.normalizedPath,
          assetId: input.assetId,
          originalPath: input.originalPath,
        })
        : options.insert
    )),
  };
  const repository = mocks as unknown as AttachmentCommitRepository;
  const cache = vi.fn(async () => workerResult as unknown);
  return {
    mocks,
    cache,
    finish: (nodeId = "node-a") => finishLegacyUpload({ committed, nodeId, repository, cache }),
  };
}

describe("finish legacy upload", () => {
  it("looks up the alias, warms the cache once, writes the alias, then returns the worker result", async () => {
    const h = createHarness();

    const result = await h.finish();

    expect(result).toEqual(workerResult);
    expect(h.mocks.findLegacyAliasForUpload.mock.invocationCallOrder[0]!)
      .toBeLessThan(h.cache.mock.invocationCallOrder[0]!);
    expect(h.mocks.findLegacyAliasForUpload).toHaveBeenCalledWith("asset-a", "node-a");
    expect(h.cache).toHaveBeenCalledTimes(1);
    expect(h.mocks.insertLegacyAlias).toHaveBeenCalledWith({
      nodeId: "node-a",
      normalizedPath: "C:/out/report.txt",
      assetId: "asset-a",
      originalPath: "C:\\out\\report.txt",
    });
  });

  it("reuses a stored alias for the same asset and node without calling the cache", async () => {
    const h = createHarness({ stored: resolvedAlias({ originalPath: "C:\\old\\report.txt" }) });

    const result = await h.finish();

    expect(result).toEqual({
      path: "C:\\old\\report.txt",
      filename: "report.txt",
      size: 42,
      content_type: "text/plain",
    });
    expect(h.cache).not.toHaveBeenCalled();
    expect(h.mocks.insertLegacyAlias).not.toHaveBeenCalled();
  });

  it("rejects a worker result that is not a plain object or lacks trimmed strings", async () => {
    const h = createHarness();

    for (const bad of [null, [], "report.txt", { ...workerResult, path: "" }, { ...workerResult, filename: "" }, { ...workerResult, content_type: "" }]) {
      h.cache.mockResolvedValueOnce(bad as unknown);
      await expect(h.finish()).rejects.toMatchObject({ statusCode: 502, code: "cache_failed" });
    }
    expect(h.mocks.insertLegacyAlias).not.toHaveBeenCalled();
  });

  it("rejects a worker size that is not a safe integer or differs from the committed size", async () => {
    const h = createHarness();

    for (const size of [41, "42", 42.5, Number.MAX_SAFE_INTEGER + 1]) {
      h.cache.mockResolvedValueOnce({ ...workerResult, size } as unknown);
      await expect(h.finish()).rejects.toMatchObject({ statusCode: 502, code: "cache_failed" });
    }
    expect(h.mocks.insertLegacyAlias).not.toHaveBeenCalled();
  });

  it("maps an alias conflict to 409 and never returns the worker result", async () => {
    const h = createHarness({ insert: null });

    await expect(h.finish()).rejects.toMatchObject({ statusCode: 409, code: "alias_conflict" });
  });

  it("maps cache failures to their transport codes without leaking raw details", async () => {
    const h = createHarness();

    h.cache.mockRejectedValueOnce(new AttachmentTransportConnectionError("connect ws://secret-token@node failed"));
    await expect(h.finish()).rejects.toMatchObject({
      statusCode: 503,
      code: "cache_unavailable",
      detail: expect.not.stringContaining("secret-token"),
    });

    h.cache.mockRejectedValueOnce(new AttachmentTransportTimeoutError("command timed out"));
    await expect(h.finish()).rejects.toMatchObject({ statusCode: 504, code: "cache_timeout" });

    h.cache.mockRejectedValueOnce(Object.assign(new Error("unsupported"), { statusCode: 409 }));
    await expect(h.finish()).rejects.toMatchObject({ statusCode: 409, code: "cache_unsupported" });

    h.cache.mockRejectedValueOnce(new Error("boom"));
    await expect(h.finish()).rejects.toMatchObject({ statusCode: 502, code: "cache_failed" });
  });
});
