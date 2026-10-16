import { describe, expect, it, vi } from "vitest";

import type {
  AttachmentAssetRow,
  AttachmentLegacyAliasRow,
  AttachmentReadRepository,
} from "../src/attachments/attachment_read_service.js";
import { projectSessionEventAttachments } from "../src/session/session_event_attachment_projection.js";

type ProjectionRepository = Pick<
  AttachmentReadRepository,
  "getAsset" | "getLegacyAlias" | "getSqlScopeEvidence"
>;

function createFixture() {
  const assets = new Map<string, AttachmentAssetRow>();
  const aliases = new Map<string, AttachmentLegacyAliasRow>();
  const storedRefs = new Set<string>();
  const repository: ProjectionRepository = {
    getAsset: vi.fn(async (id) => assets.get(id) ?? null),
    getLegacyAlias: vi.fn(async (nodeId, normalizedPath) =>
      aliases.get(`${nodeId}\u0000${normalizedPath}`) ?? null),
    getSqlScopeEvidence: vi.fn(async (scope, attachmentId) => ({
      scope,
      folderId: null,
      hasStoredRef: storedRefs.has(`${scope.type}:${scope.id}:${attachmentId}`),
    })),
  };
  return { assets, aliases, storedRefs, repository };
}

function addAsset(
  fixture: ReturnType<typeof createFixture>,
  id: string,
  uploadStatus: AttachmentAssetRow["uploadStatus"] = "committed",
): void {
  fixture.assets.set(id, {
    id,
    storageKey: `private/${id}`,
    storagePurpose: "attachment",
    storageEndpoint: "https://r2.example.test",
    storageBucket: "private-attachments",
    ownerKind: null,
    ownerKey: null,
    registrationScope: null,
    sourceSessionId: null,
    originalName: `${id}.png`,
    mimeType: "image/png",
    byteSize: 8,
    width: null,
    height: null,
    checksumSha256: null,
    uploadStatus,
  });
}

function addAlias(
  fixture: ReturnType<typeof createFixture>,
  nodeId: string,
  normalizedPath: string,
  alias: AttachmentLegacyAliasRow,
): void {
  fixture.aliases.set(`${nodeId}\u0000${normalizedPath}`, alias);
}

describe("projectSessionEventAttachments", () => {
  it("preserves ID order while removing duplicate and invalid IDs", async () => {
    const fixture = createFixture();
    addAsset(fixture, "asset-a");
    addAsset(fixture, "asset-b");

    const result = await projectSessionEventAttachments({
      sessionId: "session-1",
      eventId: 12,
      eventType: "assistant_message",
      payload: { attachment_ids: ["asset-b", "", "asset-a", "asset-b", 1] },
      nodeId: "node-1",
    }, fixture.repository);

    expect(result.event_id).toBe(12);
    expect(result.items.map((item) => item.kind === "asset" ? item.descriptor.attachment_id : null))
      .toEqual(["asset-b", "asset-a"]);
    expect(result.items).toEqual([
      expect.objectContaining({
        kind: "asset",
        read_context: { type: "session", id: "session-1" },
        legacy_sources: [],
      }),
      expect.objectContaining({
        kind: "asset",
        read_context: { type: "session", id: "session-1" },
        legacy_sources: [],
      }),
    ]);
  });

  it("attaches resolved aliases to their ID and keeps unmatched paths in record order", async () => {
    const fixture = createFixture();
    addAsset(fixture, "asset-a");
    addAlias(fixture, "node-1", "/legacy/linked.png", {
      assetId: "asset-a",
      availability: "resolved",
    });

    const result = await projectSessionEventAttachments({
      sessionId: "session-1",
      eventId: 13,
      eventType: "user_message",
      payload: {
        attachment_ids: ["asset-a", "asset-a"],
        attachments: ["\\legacy\\linked.png", "/legacy/first.txt", "/legacy/first.txt"],
        attachment_paths: ["/legacy/second.txt", "/legacy/first.txt"],
      },
      nodeId: "node-1",
    }, fixture.repository);

    expect(result.items).toEqual([
      expect.objectContaining({
        kind: "asset",
        descriptor: expect.objectContaining({ attachment_id: "asset-a" }),
        legacy_sources: [{ node_id: "node-1", path: "/legacy/linked.png" }],
      }),
      expect.objectContaining({
        kind: "legacy",
        path: "/legacy/first.txt",
        name: "first.txt",
        availability: "unresolved",
        mime_type: null,
        byte_size: null,
      }),
      expect.objectContaining({
        kind: "legacy",
        path: "/legacy/second.txt",
        name: "second.txt",
        availability: "unresolved",
      }),
    ]);
    expect(fixture.repository.getSqlScopeEvidence).not.toHaveBeenCalled();
  });

  it("does not promote a resolved alias without a stored session reference", async () => {
    const fixture = createFixture();
    addAsset(fixture, "asset-a");
    addAlias(fixture, "node-1", "/legacy/a.png", {
      assetId: "asset-a",
      availability: "resolved",
    });

    const result = await projectSessionEventAttachments({
      sessionId: "session-1",
      eventId: 14,
      eventType: "intervention_sent",
      payload: { attachments: ["/legacy/a.png"] },
      nodeId: "node-1",
    }, fixture.repository);

    expect(result.items).toEqual([
      expect.objectContaining({
        kind: "legacy",
        node_id: "node-1",
        path: "/legacy/a.png",
        availability: "unresolved",
      }),
    ]);
    expect(fixture.repository.getAsset).not.toHaveBeenCalled();
    expect(fixture.repository.getSqlScopeEvidence).toHaveBeenCalledWith(
      { type: "session", id: "session-1" },
      "asset-a",
    );
  });

  it("promotes alias-only paths with a session reference and merges paths by asset ID", async () => {
    const fixture = createFixture();
    addAsset(fixture, "asset-a");
    addAlias(fixture, "node-1", "/legacy/a.png", { assetId: "asset-a", availability: "resolved" });
    addAlias(fixture, "node-1", "/legacy/alias-a.png", { assetId: "asset-a", availability: "resolved" });
    fixture.storedRefs.add("session:session-1:asset-a");

    const result = await projectSessionEventAttachments({
      sessionId: "session-1",
      eventId: 15,
      eventType: "complete",
      payload: { attachment_paths: ["/legacy/a.png", "/legacy/alias-a.png", "/legacy/a.png"] },
      nodeId: "node-1",
    }, fixture.repository);

    expect(result.items).toEqual([
      expect.objectContaining({
        kind: "asset",
        descriptor: expect.objectContaining({ attachment_id: "asset-a" }),
        legacy_sources: [
          { node_id: "node-1", path: "/legacy/a.png" },
          { node_id: "node-1", path: "/legacy/alias-a.png" },
        ],
      }),
    ]);
    expect(fixture.repository.getAsset).toHaveBeenCalledTimes(1);
  });

  it("keeps confirmed missing aliases distinct from absent and pending assets", async () => {
    const fixture = createFixture();
    addAsset(fixture, "asset-pending", "pending");
    addAlias(fixture, "node-1", "/legacy/missing.png", { assetId: null, availability: "missing" });

    const result = await projectSessionEventAttachments({
      sessionId: "session-1",
      eventId: 16,
      eventType: "assistant_message",
      payload: {
        attachment_ids: ["asset-absent", "asset-pending"],
        attachments: ["/legacy/missing.png", "/legacy/unresolved.png"],
      },
      nodeId: "node-1",
    }, fixture.repository);

    expect(result.items).toEqual([
      expect.objectContaining({ kind: "unavailable", attachment_id: "asset-absent", availability: "unavailable" }),
      expect.objectContaining({ kind: "unavailable", attachment_id: "asset-pending", availability: "unavailable" }),
      expect.objectContaining({ kind: "legacy", path: "/legacy/missing.png", availability: "missing" }),
      expect.objectContaining({ kind: "legacy", path: "/legacy/unresolved.png", availability: "unresolved" }),
    ]);
  });

  it("uses a payload node when present and emits unavailable legacy without either node", async () => {
    const fixture = createFixture();
    addAlias(fixture, "payload-node", "/legacy/missing.png", { assetId: null, availability: "missing" });

    const payloadNodeResult = await projectSessionEventAttachments({
      sessionId: "session-1",
      eventId: 17,
      eventType: "user_message",
      payload: { node_id: "payload-node", attachments: ["/legacy/missing.png"] },
      nodeId: "session-node",
    }, fixture.repository);
    const unknownNodeResult = await projectSessionEventAttachments({
      sessionId: "session-2",
      eventId: 18,
      eventType: "user_message",
      payload: { attachments: ["/legacy/unknown.txt"] },
      nodeId: null,
    }, fixture.repository);

    expect(payloadNodeResult.items).toEqual([
      expect.objectContaining({ kind: "legacy", node_id: "payload-node", availability: "missing" }),
    ]);
    expect(unknownNodeResult.items).toEqual([
      expect.objectContaining({
        kind: "unavailable_legacy",
        path: "/legacy/unknown.txt",
        name: "unknown.txt",
        availability: "unavailable",
      }),
    ]);
    expect(fixture.repository.getLegacyAlias).not.toHaveBeenCalledWith("session-node", expect.any(String));
  });

  it("returns an empty projection for event types outside the four chat types", async () => {
    const fixture = createFixture();

    await expect(projectSessionEventAttachments({
      sessionId: "session-1",
      eventId: 19,
      eventType: "tool_result",
      payload: { attachment_ids: ["asset-a"], attachments: ["/legacy/a.png"] },
      nodeId: "node-1",
    }, fixture.repository)).resolves.toEqual({ event_id: 19, items: [] });
    expect(fixture.repository.getAsset).not.toHaveBeenCalled();
    expect(fixture.repository.getLegacyAlias).not.toHaveBeenCalled();
  });
});
