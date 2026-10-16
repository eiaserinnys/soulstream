import { describe, expect, it, vi } from "vitest";

import { createAttachmentInputAdmission } from "../src/attachments/attachment_input_admission.js";
import type {
  AttachmentAssetRow,
  AttachmentLegacyAliasRow,
  AttachmentReadActor,
  AttachmentReadRepository,
} from "../src/attachments/attachment_read_service.js";

const user: AttachmentReadActor = { kind: "user", email: "owner@example.com" };
const otherUser: AttachmentReadActor = { kind: "user", email: "other@example.com" };
const target = { sessionId: "session-1" };

function assetRow(id: string, overrides: Partial<AttachmentAssetRow> = {}): AttachmentAssetRow {
  return {
    id,
    storageKey: `private/${id}`,
    storagePurpose: "attachment",
    storageEndpoint: "https://r2.example.test",
    storageBucket: "private-attachments",
    ownerKind: "user_email",
    ownerKey: "owner@example.com",
    registrationScope: null,
    sourceSessionId: null,
    originalName: `${id}.png`,
    mimeType: "image/png",
    byteSize: 8,
    width: null,
    height: null,
    checksumSha256: null,
    uploadStatus: "committed",
    ...overrides,
  };
}

function makeAdmission(input: {
  readonly assets?: readonly AttachmentAssetRow[];
  readonly aliases?: Readonly<Record<string, AttachmentLegacyAliasRow>>;
  readonly requireLink?: (
    actor: AttachmentReadActor,
    id: string,
    target: { sessionId?: string; cardId?: string },
    asset: AttachmentAssetRow,
  ) => Promise<void>;
} = {}) {
  const assets = new Map((input.assets ?? []).map((asset) => [asset.id, asset]));
  const aliases = input.aliases ?? {};
  const repository: AttachmentReadRepository = {
    getAsset: vi.fn(async (id) => assets.get(id) ?? null),
    getLegacyAlias: vi.fn(async (nodeId, normalizedPath) =>
      aliases[`${nodeId}:${normalizedPath}`] ?? null),
    getSqlScopeEvidence: vi.fn(async () => null),
    listLegacyCandidateScopes: vi.fn(async () => []),
  };
  const requireLink = vi.fn(input.requireLink ?? (async () => undefined));
  const admission = createAttachmentInputAdmission({ repository, requireLink });
  return { admission, repository, requireLink };
}

const resolved = (assetId: string): AttachmentLegacyAliasRow => ({
  assetId,
  availability: "resolved",
});

describe("attachment input admission", () => {
  it("passes legacy paths through without an actor when no alias exists", async () => {
    const { admission, requireLink } = makeAdmission();

    await expect(admission.admit({
      actor: null,
      sourceNodeId: "node-1",
      target,
      attachmentPaths: ["/tmp/a.txt", "/tmp/b.txt"],
    })).resolves.toEqual({
      attachment_ids: [],
      attachment_paths: ["/tmp/a.txt", "/tmp/b.txt"],
      attachment_bindings: [],
    });
    expect(requireLink).not.toHaveBeenCalled();
  });

  it("binds only aliased paths and keeps the original path list intact", async () => {
    const asset = assetRow("att-a");
    const { admission, repository, requireLink } = makeAdmission({
      assets: [asset],
      aliases: { "node-1:/tmp/a.png": resolved("att-a") },
    });

    const result = await admission.admit({
      actor: user,
      sourceNodeId: "node-1",
      target,
      attachmentPaths: ["/tmp/a.png", "/tmp/plain.txt"],
    });

    expect(result).toEqual({
      attachment_ids: ["att-a"],
      attachment_paths: ["/tmp/a.png", "/tmp/plain.txt"],
      attachment_bindings: [
        { attachment_id: "att-a", node_id: "node-1", path: "/tmp/a.png" },
      ],
    });
    expect(repository.getLegacyAlias).toHaveBeenCalledWith("node-1", "/tmp/plain.txt");
    expect(requireLink).toHaveBeenCalledTimes(1);
    expect(requireLink).toHaveBeenCalledWith(user, "att-a", target, asset);
  });

  it("admits explicit ids without paths, deduping in first-seen order", async () => {
    const { admission, requireLink } = makeAdmission({
      assets: [assetRow("att-a"), assetRow("att-b")],
    });

    const result = await admission.admit({
      actor: user,
      sourceNodeId: "node-1",
      target,
      attachmentIds: ["att-b", "att-a", "att-b"],
    });

    expect(result).toEqual({
      attachment_ids: ["att-b", "att-a"],
      attachment_paths: [],
      attachment_bindings: [],
    });
    expect(requireLink.mock.calls.map((call) => call[1])).toEqual(["att-b", "att-a"]);
  });

  it("accepts matching ids and paths with one id and one binding per path", async () => {
    const { admission, requireLink } = makeAdmission({
      assets: [assetRow("att-a")],
      aliases: {
        "node-1:/tmp/one.png": resolved("att-a"),
        "node-1:/tmp/two.png": resolved("att-a"),
      },
    });

    const result = await admission.admit({
      actor: user,
      sourceNodeId: "node-1",
      target,
      attachmentIds: ["att-a", "att-a"],
      attachmentPaths: ["/tmp/one.png", "/tmp/two.png"],
    });

    expect(result.attachment_ids).toEqual(["att-a"]);
    expect(result.attachment_bindings).toEqual([
      { attachment_id: "att-a", node_id: "node-1", path: "/tmp/one.png" },
      { attachment_id: "att-a", node_id: "node-1", path: "/tmp/two.png" },
    ]);
    expect(requireLink).toHaveBeenCalledTimes(1);
  });

  it("rejects an alias id that the explicit ids do not contain", async () => {
    const { admission } = makeAdmission({
      assets: [assetRow("att-a"), assetRow("att-b")],
      aliases: { "node-1:/tmp/a.png": resolved("att-a") },
    });

    await expect(admission.admit({
      actor: user,
      sourceNodeId: "node-1",
      target,
      attachmentIds: ["att-b"],
      attachmentPaths: ["/tmp/a.png"],
    })).rejects.toMatchObject({
      code: "ATTACHMENT_REFERENCE_MISMATCH",
      statusCode: 422,
    });
  });

  it("does not compare unaliased paths with explicit ids", async () => {
    const { admission } = makeAdmission({ assets: [assetRow("att-b")] });

    await expect(admission.admit({
      actor: user,
      sourceNodeId: "node-1",
      target,
      attachmentIds: ["att-b"],
      attachmentPaths: ["/tmp/legacy.txt"],
    })).resolves.toEqual({
      attachment_ids: ["att-b"],
      attachment_paths: ["/tmp/legacy.txt"],
      attachment_bindings: [],
    });
  });

  it("registers explicit ids first and appends alias ids in path order", async () => {
    const { admission } = makeAdmission({
      assets: [assetRow("att-a"), assetRow("att-b"), assetRow("att-c")],
      aliases: {
        "node-1:/tmp/b.png": resolved("att-b"),
        "node-1:/tmp/c.png": resolved("att-c"),
      },
    });

    const result = await admission.admit({
      actor: user,
      sourceNodeId: "node-1",
      target,
      attachmentIds: ["att-c", "att-b", "att-a"],
      attachmentPaths: ["/tmp/b.png", "/tmp/c.png"],
    });

    expect(result.attachment_ids).toEqual(["att-c", "att-b", "att-a"]);
  });

  it("rejects pending, missing, and non-attachment assets", async () => {
    const { admission } = makeAdmission({
      assets: [
        assetRow("att-pending", { uploadStatus: "pending" }),
        assetRow("att-avatar", { storagePurpose: "avatar" }),
      ],
    });
    const admit = (ids: string[]) => admission.admit({
      actor: user,
      sourceNodeId: "node-1",
      target,
      attachmentIds: ids,
    });

    await expect(admit(["att-pending"])).rejects.toMatchObject({
      code: "ATTACHMENT_NOT_COMMITTED",
      statusCode: 409,
    });
    await expect(admit(["att-missing"])).rejects.toMatchObject({
      code: "ATTACHMENT_NOT_FOUND",
      statusCode: 404,
    });
    await expect(admit(["att-avatar"])).rejects.toMatchObject({
      code: "ATTACHMENT_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("rejects an alias whose source is missing", async () => {
    const { admission, requireLink } = makeAdmission({
      aliases: {
        "node-1:/tmp/gone.png": { assetId: null, availability: "missing" },
        "node-1:/tmp/null.png": { assetId: null, availability: "resolved" },
      },
    });

    for (const path of ["/tmp/gone.png", "/tmp/null.png"]) {
      await expect(admission.admit({
        actor: user,
        sourceNodeId: "node-1",
        target,
        attachmentPaths: [path],
      })).rejects.toMatchObject({
        code: "ATTACHMENT_SOURCE_MISSING",
        statusCode: 404,
      });
    }
    expect(requireLink).not.toHaveBeenCalled();
  });

  it("propagates a link denial for another actor", async () => {
    const denied = Object.assign(new Error("denied"), {
      code: "ATTACHMENT_ACCESS_DENIED",
      statusCode: 403,
    });
    const { admission, requireLink } = makeAdmission({
      assets: [assetRow("att-a")],
      requireLink: async (actor) => {
        if (actor.kind === "user" && actor.email === "other@example.com") throw denied;
      },
    });

    await expect(admission.admit({
      actor: otherUser,
      sourceNodeId: "node-1",
      target,
      attachmentIds: ["att-a"],
    })).rejects.toBe(denied);
    expect(requireLink).toHaveBeenCalledWith(otherUser, "att-a", target, expect.anything());
  });

  it("requires an actor before assigning ids", async () => {
    const { admission, requireLink } = makeAdmission({
      assets: [assetRow("att-a")],
      aliases: { "node-1:/tmp/a.png": resolved("att-a") },
    });

    for (const input of [
      { attachmentIds: ["att-a"] },
      { attachmentPaths: ["/tmp/a.png"] },
    ]) {
      await expect(admission.admit({
        actor: null,
        sourceNodeId: "node-1",
        target,
        ...input,
      })).rejects.toMatchObject({
        code: "ATTACHMENT_UNAUTHENTICATED",
        statusCode: 401,
      });
    }
    expect(requireLink).not.toHaveBeenCalled();
  });

  it("normalizes Windows paths for the alias lookup and keeps the original string", async () => {
    const windowsPath = "C:\\work\\..\\files\\a.png";
    const { admission, repository } = makeAdmission({
      assets: [assetRow("att-a")],
      aliases: { "win-node:C:/files/a.png": resolved("att-a") },
    });

    const result = await admission.admit({
      actor: user,
      sourceNodeId: "win-node",
      target,
      attachmentPaths: [windowsPath],
    });

    expect(repository.getLegacyAlias).toHaveBeenCalledWith("win-node", "C:/files/a.png");
    expect(result.attachment_paths).toEqual([windowsPath]);
    expect(result.attachment_bindings).toEqual([
      { attachment_id: "att-a", node_id: "win-node", path: windowsPath },
    ]);
  });

  it("rejects malformed id arrays", async () => {
    const { admission } = makeAdmission();

    for (const attachmentIds of [[""], [1], "att-a", [null]]) {
      await expect(admission.admit({
        actor: user,
        sourceNodeId: "node-1",
        target,
        attachmentIds: attachmentIds as unknown as string[],
      })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        statusCode: 400,
      });
    }
  });
});
