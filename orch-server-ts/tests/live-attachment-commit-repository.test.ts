import { describe, expect, it, vi } from "vitest";

import { createLiveAttachmentCommitRepository } from "../src/runtime/live_attachment_commit_repository.js";
import type { LiveDbSqlResolver } from "../src/runtime/live_db_sql.js";

type QueryHandler = (text: string, values: unknown[]) => readonly Record<string, unknown>[];

function createSqlHarness(handler: QueryHandler) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql: any = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return handler(text, values);
  });
  sql.json = (value: unknown) => JSON.stringify(value);
  const resolver: LiveDbSqlResolver = { resolveSql: async () => sql, close: async () => {} };
  return { calls, resolver };
}

const pendingRow = {
  id: "asset-a",
  storage_key: "session-attachments/originals/asset-a",
  storage_purpose: "attachment",
  storage_endpoint: "https://r2.example.test",
  storage_bucket: "private-files",
  owner_kind: "user_email",
  owner_key: "owner@example.test",
  registration_scope: { type: "folder", id: "folder-a" },
  source_node_id: "node-a",
  source_session_id: "session-a",
  output_command_id: "command-a",
  original_name: "report.txt",
  mime_type: "text/plain",
  byte_size: "42",
  checksum_sha256: null,
  upload_status: "pending",
  multipart_upload_id: "upload-a",
  garbage_collected_at: null,
  created_at: new Date("2026-10-11T03:00:00.000Z"),
  updated_at: new Date("2026-10-11T03:00:00.000Z"),
};

describe("live attachment commit repository", () => {
  it("inserts only the owned attachment registration fields and returns the database row", async () => {
    const harness = createSqlHarness((text) => text.includes("INSERT INTO file_assets") ? [pendingRow] : []);
    const repository = createLiveAttachmentCommitRepository(harness.resolver);

    const result = await repository.insertOwnedPending({
      attachmentId: "asset-a",
      storageKey: pendingRow.storage_key,
      owner: { kind: "user_email", key: "owner@example.test" },
      registration: {
        registrationScope: { type: "folder", id: "folder-a" },
        sourceNodeId: "node-a",
        sourceSessionId: "session-a",
        outputCommandId: "command-a",
      },
      originalName: "report.txt",
      mimeType: "text/plain",
      byteSize: 42,
      location: { endpoint: "https://r2.example.test", bucket: "private-files" },
    });

    expect(result).toMatchObject({
      attachmentId: "asset-a",
      storageKey: pendingRow.storage_key,
      owner: { kind: "user_email", key: "owner@example.test" },
      registration: { registrationScope: { type: "folder", id: "folder-a" }, sourceSessionId: "session-a" },
      uploadStatus: "pending",
      multipartUploadId: "upload-a",
      byteSize: 42,
    });
    expect(harness.calls[0]?.text).toContain("storage_purpose");
    expect(harness.calls[0]?.text).toContain("'attachment'");
    expect(harness.calls[0]?.text).toContain("ON CONFLICT DO NOTHING");
    expect(harness.calls[0]?.values).toContain("owner@example.test");
    expect(harness.calls[0]?.values).toContain("https://r2.example.test");
  });

  it("restores browser provenance with a null source node and keeps the source session", async () => {
    const browserRow = { ...pendingRow, source_node_id: null, source_session_id: "draft-session-a" };
    const harness = createSqlHarness((text) => text.includes("INSERT INTO file_assets") ? [browserRow] : []);
    const repository = createLiveAttachmentCommitRepository(harness.resolver);

    const result = await repository.insertOwnedPending({
      attachmentId: "asset-a",
      storageKey: pendingRow.storage_key,
      owner: { kind: "user_email", key: "owner@example.test" },
      registration: {
        registrationScope: { type: "folder", id: "folder-a" },
        sourceNodeId: null,
        sourceSessionId: "draft-session-a",
        outputCommandId: "command-a",
      },
      originalName: "report.txt",
      mimeType: "text/plain",
      byteSize: 42,
      location: { endpoint: "https://r2.example.test", bucket: "private-files" },
    });

    expect(result).toMatchObject({
      registration: { sourceNodeId: null, sourceSessionId: "draft-session-a" },
      uploadStatus: "pending",
    });
    expect(harness.calls[0]?.values).toContain(null);
  });

  it("does not expose a row whose owner or purpose does not match", async () => {
    const harness = createSqlHarness((text) => text.includes("INSERT INTO file_assets") ? [] : []);
    const repository = createLiveAttachmentCommitRepository(harness.resolver);

    await expect(repository.getOwnedUpload("asset-a", { kind: "user_email", key: "other@example.test" })).resolves.toBeNull();
    expect(harness.calls[0]?.text).toContain("owner_kind");
    expect(harness.calls[0]?.text).toContain("owner_key");
    expect(harness.calls[0]?.text).toContain("storage_purpose = 'attachment'");
    expect(harness.calls[0]?.values).toContain("other@example.test");
  });

  it("commits only pending rows with the registered owner, purpose, and size", async () => {
    const committed = { ...pendingRow, upload_status: "committed", checksum_sha256: "a".repeat(64), multipart_upload_id: null };
    const harness = createSqlHarness((text) => text.includes("UPDATE file_assets") ? [committed] : []);
    const repository = createLiveAttachmentCommitRepository(harness.resolver);

    await expect(repository.commitVerified({
      attachmentId: "asset-a",
      owner: { kind: "user_email", key: "owner@example.test" },
      expectedByteSize: 42,
      checksumSha256: "a".repeat(64),
    })).resolves.toMatchObject({ uploadStatus: "committed", checksumSha256: "a".repeat(64), multipartUploadId: null });
    const update = harness.calls[0]!;
    expect(update.text).toContain("upload_status = 'pending'");
    expect(update.text).toContain("byte_size");
    expect(update.text).toContain("storage_purpose = 'attachment'");
    expect(update.values).toContain("owner@example.test");
    expect(update.values).toContain(42);
  });

  it("uses the expected multipart ID when clearing a pending upload", async () => {
    const harness = createSqlHarness((text) => text.includes("UPDATE file_assets") ? [{ id: "asset-a" }] : []);
    const repository = createLiveAttachmentCommitRepository(harness.resolver);

    await expect(repository.clearPendingMultipart({
      attachmentId: "asset-a",
      owner: { kind: "user_email", key: "owner@example.test" },
      expectedUploadId: "upload-a",
    })).resolves.toBe(true);
    expect(harness.calls[0]?.text).toContain("multipart_upload_id = ?");
    expect(harness.calls[0]?.text).toContain("upload_status = 'pending'");
    expect(harness.calls[0]?.values).toContain("upload-a");
  });

  it("re-reads a conflicting alias and accepts only a resolved match to the same asset", async () => {
    const alias = {
      node_id: "node-a",
      normalized_path: "C:/out/report.txt",
      asset_id: "another-asset",
      original_path: "C:\\out\\report.txt",
      availability: "resolved",
      checked_at: new Date("2026-10-11T03:00:00.000Z"),
    };
    const harness = createSqlHarness((text) => text.includes("INSERT INTO attachment_legacy_aliases") ? [] : [alias]);
    const repository = createLiveAttachmentCommitRepository(harness.resolver);

    await expect(repository.insertLegacyAlias({
      nodeId: "node-a",
      normalizedPath: "C:/out/report.txt",
      assetId: "asset-a",
      originalPath: "C:\\out\\report.txt",
    })).resolves.toBeNull();
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0]?.text).toContain("ON CONFLICT (node_id, normalized_path) DO NOTHING");
    expect(harness.calls[1]?.text).toContain("FROM attachment_legacy_aliases");
    expect(harness.calls[1]?.values).toContain("C:/out/report.txt");
  });

  it("accepts an existing resolved alias when it points to the same asset", async () => {
    const alias = {
      node_id: "node-a",
      normalized_path: "C:/out/report.txt",
      asset_id: "asset-a",
      original_path: "C:\\out\\report.txt",
      availability: "resolved",
    };
    const harness = createSqlHarness((text) => text.includes("INSERT INTO attachment_legacy_aliases") ? [] : [alias]);
    const repository = createLiveAttachmentCommitRepository(harness.resolver);

    await expect(repository.insertLegacyAlias({
      nodeId: "node-a",
      normalizedPath: "C:/out/report.txt",
      assetId: "asset-a",
      originalPath: "C:\\out\\report.txt",
    })).resolves.toMatchObject({ assetId: "asset-a", availability: "resolved" });
  });

  it("finds a legacy upload alias by resolved asset and node only", async () => {
    const alias = {
      node_id: "node-a",
      normalized_path: "C:/out/report.txt",
      asset_id: "asset-a",
      original_path: "C:\\out\\report.txt",
      availability: "resolved",
    };
    const harness = createSqlHarness(() => [alias]);
    const repository = createLiveAttachmentCommitRepository(harness.resolver);

    await expect(
      repository.findLegacyAliasForUpload("asset-a", "node-a"),
    ).resolves.toMatchObject({ assetId: "asset-a", normalizedPath: "C:/out/report.txt" });
    const query = harness.calls[0]!;
    expect(query.text).toContain("asset_id");
    expect(query.text).toContain("node_id");
    expect(query.text).toContain("availability = 'resolved'");
    expect(query.text).toContain("ORDER BY normalized_path");
    expect(query.text).toContain("LIMIT 1");
    expect(query.values).toContain("asset-a");
    expect(query.values).toContain("node-a");
  });

  it("treats a missing legacy upload alias as absent", async () => {
    const harness = createSqlHarness(() => []);
    const repository = createLiveAttachmentCommitRepository(harness.resolver);

    await expect(repository.findLegacyAliasForUpload("asset-a", "node-a")).resolves.toBeNull();
  });
});
