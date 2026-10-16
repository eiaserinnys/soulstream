import { describe, expect, it, vi } from "vitest";

import {
  AttachmentTransportTimeoutError,
  createApp,
  parseOrchServerConfig,
  type AttachmentAccessProvider,
  type AttachmentNode,
  type AttachmentRouteProvider,
  type AttachmentTransport,
} from "../src/index.js";
import type {
  AttachmentCommitRepository,
  AttachmentLegacyAlias,
  CommitResult,
  OwnedAttachmentCommitService,
  UploadSpec,
} from "../src/attachments/attachment_commit_contract.js";
import { AttachmentCommitError } from "../src/attachments/attachment_commit_service.js";
import type { AttachmentUploadOptions, UserUploadActor } from "../src/attachments/attachment_upload_http.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});
const node: AttachmentNode = { id: "node-1", host: "127.0.0.1", port: 4105 };
const ID_V1 = { "x-soulstream-attachment-contract": "id-v1" };

type HarnessOptions = {
  actor?: UserUploadActor | null;
  requireRegistration?: AttachmentUploadOptions["requireRegistration"];
  putSmall?: OwnedAttachmentCommitService["putSmall"];
  storedAlias?: AttachmentLegacyAlias | null;
  transport?: Partial<AttachmentTransport>;
  provider?: AttachmentRouteProvider;
};

function createHarness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const provider: AttachmentRouteProvider = options.provider ?? {
    async getNode(nodeId) {
      calls.push(`node:${nodeId}`);
      return nodeId === "node-1" ? node : null;
    },
  };
  const accessProvider: AttachmentAccessProvider = {
    async resolveAccess() {
      return { restricted: true };
    },
    async requireSessionAccess() {},
  };
  const transport: AttachmentTransport = {
    async uploadAttachment(_target, input) {
      calls.push("upload");
      for await (const _chunk of input.chunks) void _chunk;
      return { path: "/incoming/session-abc/photo.png", filename: "photo.png", size: input.expectedSize ?? 0, content_type: input.contentType };
    },
    async legacyUploadAttachment(_target, input) {
      calls.push("legacy");
      return { path: "/incoming/session-abc/photo.png", filename: input.filename, size: Buffer.from(input.contentBase64, "base64").length, content_type: input.contentType };
    },
    async deleteSessionAttachments() {
      return {};
    },
    async downloadAttachment() {
      return {};
    },
    ...options.transport,
  };
  const toResult = (spec: UploadSpec): CommitResult => ({
    attachmentId: spec.attachmentId,
    storageKey: `key/${spec.attachmentId}`,
    storageEndpoint: "https://r2.test",
    storageBucket: "bucket",
    originalName: spec.originalName,
    mimeType: spec.mimeType,
    byteSize: spec.byteSize,
    checksumSha256: "a".repeat(64),
  });
  let committedSpec: UploadSpec | undefined;
  const putSmall = vi.fn(
    async (input: { spec: UploadSpec; body: Uint8Array; signal?: AbortSignal }): Promise<CommitResult> => {
      if (options.putSmall) return await options.putSmall(input);
      committedSpec = input.spec;
      calls.push("commit");
      return toResult(input.spec);
    },
  );
  const repository = {
    async findLegacyAliasForUpload() {
      calls.push("find-alias");
      return options.storedAlias ?? null;
    },
    async insertLegacyAlias(input: { nodeId: string; normalizedPath: string; assetId: string; originalPath: string }): Promise<AttachmentLegacyAlias> {
      calls.push("insert-alias");
      return { ...input, availability: "resolved" };
    },
  } as unknown as AttachmentCommitRepository;
  const uploads: AttachmentUploadOptions = {
    resolveActor: async () => (options.actor === undefined ? { kind: "user", email: "writer@example.com" } : options.actor),
    requireRegistration:
      options.requireRegistration ??
      (async () => ({ registrationScope: { type: "session", id: "session-abc" }, sourceNodeId: "node-1", sourceSessionId: "session-abc", outputCommandId: null })),
    commits: { putSmall, initMultipart: vi.fn(), completeMultipart: vi.fn(), abortMultipart: vi.fn() } as unknown as OwnedAttachmentCommitService,
    repository,
    resolveBinding: async () => null,
    ownerMetadata: async (_actor, id) => ({
      descriptor: { attachment_id: id, name: "photo.png", mime_type: "image/png", byte_size: 9, checksum_sha256: null, width: null, height: null, preview_kind: "image", preview_mime_type: "image/png" },
      upload_status: "committed",
    }),
  };
  const app = createApp({ config, attachmentRoutes: { provider, accessProvider, transport, assetUpload: uploads } });
  return { app, calls, putSmall, getSpec: () => committedSpec };
}

function multipartBody(options: { fields?: Record<string, string>; filename?: string; contentType?: string; content?: Buffer; omitFile?: boolean }) {
  const boundary = "----soulstream-owned-upload-test";
  const chunks: Buffer[] = [];
  const append = (value: string | Buffer) => chunks.push(typeof value === "string" ? Buffer.from(value, "utf8") : value);
  for (const [name, value] of Object.entries(options.fields ?? {})) {
    append(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  if (!options.omitFile) {
    append(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${options.filename ?? "photo.png"}"\r\nContent-Type: ${options.contentType ?? "image/png"}\r\n\r\n`);
    append(options.content ?? Buffer.from("PNG bytes"));
    append("\r\n");
  }
  append(`--${boundary}--\r\n`);
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(chunks) };
}

function post(app: ReturnType<typeof createApp>, body: { headers: Record<string, string>; payload: Buffer }, extra: Record<string, string> = {}, nodeId: string | null = "node-1") {
  const url = nodeId === null ? "/api/attachments/sessions" : `/api/attachments/sessions?nodeId=${nodeId}`;
  return app.inject({ method: "POST", url, headers: { ...body.headers, ...extra }, payload: body.payload });
}

describe("owned small upload branch", () => {
  it("commits an id-v1 upload and returns the descriptor even when the node is offline", async () => {
    const harness = createHarness({ provider: { async getNode() { return null; } } });
    const response = await post(harness.app, multipartBody({ fields: { session_id: "session-abc" } }), ID_V1, "missing");
    expect(response.statusCode).toBe(201);
    expect(response.headers["x-soulstream-attachment-contract"]).toBe("id-v1");
    expect(response.json()).toEqual({ attachment: expect.objectContaining({ attachment_id: expect.any(String), name: "photo.png" }) });
    expect(harness.getSpec()!.owner).toEqual({ kind: "user_email", key: "writer@example.com" });
    expect(harness.calls).toEqual(["commit"]);
  });

  it("ignores a forged caller_info and commits under the verified email", async () => {
    const harness = createHarness();
    const response = await post(harness.app, multipartBody({ fields: { session_id: "session-abc", caller_info: JSON.stringify({ email: "forged@evil.example" }) } }), ID_V1);
    expect(response.statusCode).toBe(201);
    expect(harness.getSpec()!.owner).toEqual({ kind: "user_email", key: "writer@example.com" });
  });

  it("falls back to the worker path for an unauthenticated legacy request without committing", async () => {
    const harness = createHarness({ actor: null });
    const response = await post(harness.app, multipartBody({ fields: { session_id: "session-abc" } }));
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ path: "/incoming/session-abc/photo.png", filename: "photo.png", size: 9, content_type: "image/png" });
    expect(harness.putSmall).not.toHaveBeenCalled();
    expect(harness.calls).toEqual(["node:node-1", "upload"]);
  });

  it("rejects an id-v1 upload from an unauthenticated caller with 401", async () => {
    const harness = createHarness({ actor: null });
    const response = await post(harness.app, multipartBody({ fields: { session_id: "session-abc" } }), ID_V1);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "unauthenticated" });
    expect(harness.putSmall).not.toHaveBeenCalled();
  });

  it("authorizes before committing and returns 403 without a PUT", async () => {
    const harness = createHarness({ requireRegistration: async () => { throw Object.assign(new Error("denied"), { statusCode: 403, code: "forbidden" }); } });
    const response = await post(harness.app, multipartBody({ fields: { session_id: "session-abc" } }), ID_V1);
    expect(response.statusCode).toBe(403);
    expect(harness.putSmall).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });

  it.each([
    ["no file part", { session_id: "session-abc" }, {} as Record<string, string>, "node-1", true, 400],
    ["missing session_id", {}, ID_V1, "node-1", false, 422],
    ["missing node id", { session_id: "session-abc" }, {} as Record<string, string>, null, false, 422],
    ["unknown contract header", { session_id: "session-abc" }, { "x-soulstream-attachment-contract": "v2" }, "node-1", false, 400],
  ])("rejects %s before committing", async (_name, fields, headers, nodeId, omitFile, status) => {
    const harness = createHarness();
    const response = await post(harness.app, multipartBody({ fields, omitFile }), headers, nodeId as string | null);
    expect(response.statusCode).toBe(status);
    expect(harness.putSmall).not.toHaveBeenCalled();
  });

  it("commits, warms the worker cache, writes the alias, then returns the four legacy fields", async () => {
    const harness = createHarness();
    const response = await post(harness.app, multipartBody({ fields: { session_id: "session-abc" } }));
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ path: "/incoming/session-abc/photo.png", filename: "photo.png", size: 9, content_type: "image/png" });
    expect(harness.calls).toEqual(["commit", "find-alias", "node:node-1", "upload", "insert-alias"]);
  });

  it("reuses a stored alias without warming the cache", async () => {
    const harness = createHarness({ storedAlias: { nodeId: "node-1", normalizedPath: "c:/old/report.txt", assetId: "asset-1", originalPath: "C:\\old\\report.txt", availability: "resolved" } });
    const response = await post(harness.app, multipartBody({ fields: { session_id: "session-abc" } }));
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ path: "C:\\old\\report.txt", filename: "report.txt", size: 9, content_type: "image/png" });
    expect(harness.calls).toEqual(["commit", "find-alias"]);
  });

  it("uploads a zero-byte legacy file through the chunked transport", async () => {
    const harness = createHarness();
    const response = await post(harness.app, multipartBody({ fields: { session_id: "session-abc" }, content: Buffer.alloc(0) }));
    expect(response.statusCode).toBe(201);
    expect(harness.calls).toContain("upload");
    expect(harness.calls).not.toContain("legacy");
  });

  it("maps an unsupported chunked command for a zero-byte legacy file to 409", async () => {
    const harness = createHarness({ transport: { uploadAttachment: vi.fn(async () => { throw new Error("Unknown command: upload_attachment_start"); }) } });
    const response = await post(harness.app, multipartBody({ fields: { session_id: "session-abc" }, content: Buffer.alloc(0) }));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "cache_unsupported", attachment_id: harness.getSpec()!.attachmentId });
    expect(harness.calls).not.toContain("legacy");
  });

  it.each([64, 100])("accepts a %iMiB owned upload", async (mib) => {
    const harness = createHarness({ provider: { async getNode() { return null; } } });
    const response = await post(harness.app, multipartBody({ fields: { session_id: "session-abc" }, content: Buffer.alloc(mib * 1024 * 1024, 7) }), ID_V1);
    expect(response.statusCode).toBe(201);
    expect(harness.getSpec()!.byteSize).toBe(mib * 1024 * 1024);
  });

  it("rejects multipart overhead above 1MiB with 413", async () => {
    const harness = createHarness();
    const response = await post(harness.app, multipartBody({ fields: { session_id: "session-abc", caller_info: "x".repeat(1024 * 1024 + 16) } }));
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "invalid_upload" });
    expect(harness.putSmall).not.toHaveBeenCalled();
  });

  it("surfaces a commit failure with the attachment id and never touches the node", async () => {
    const harness = createHarness({ putSmall: vi.fn(async () => { throw new AttachmentCommitError("checksum_mismatch", 422, "checksum mismatch", "asset-a"); }) });
    const response = await post(harness.app, multipartBody({ fields: { session_id: "session-abc" } }), ID_V1);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "checksum_mismatch", attachment_id: "asset-a" });
    expect(harness.calls).toEqual([]);
  });

  it("keeps the committed attachment id when the legacy cache times out", async () => {
    const harness = createHarness({ transport: { uploadAttachment: vi.fn(async () => { throw new AttachmentTransportTimeoutError("cache timed out"); }) } });
    const response = await post(harness.app, multipartBody({ fields: { session_id: "session-abc" } }));
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ code: "cache_timeout", attachment_id: harness.getSpec()!.attachmentId });
    expect(harness.calls).not.toContain("insert-alias");
  });
});
