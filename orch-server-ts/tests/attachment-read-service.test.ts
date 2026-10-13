import { describe, expect, it, vi } from "vitest";

import {
  AttachmentReadError,
  createAttachmentReadService,
  type AttachmentAssetRow,
  type AttachmentReadRepository,
} from "../src/attachments/attachment_read_service.js";
import { responseHeaders } from "../src/attachments/attachment_read_http.js";

const committedAsset: AttachmentAssetRow = {
  id: "attachment-a",
  storageKey: "private/object-a",
  storagePurpose: "attachment",
  storageEndpoint: "https://r2.example.test",
  storageBucket: "private-attachments",
  ownerKind: "user_email",
  ownerKey: "owner@example.com",
  registrationScope: null,
  sourceSessionId: null,
  originalName: "../report.png",
  mimeType: "image/png",
  byteSize: 8,
  width: 2,
  height: 2,
  checksumSha256: "sha256",
  uploadStatus: "committed",
};

function makeService(input: {
  readonly asset?: AttachmentAssetRow;
  readonly read?: (request: {
    readonly storageKey: string;
    readonly method?: "GET" | "HEAD";
    readonly range?: string;
    readonly signal?: AbortSignal;
  }) => Promise<Response>;
  readonly pageEvidence?: () => Promise<null>;
} = {}) {
  const asset = input.asset ?? committedAsset;
  const repository: AttachmentReadRepository = {
    getAsset: vi.fn(async (id) => id === asset.id ? asset : null),
    getLegacyAlias: vi.fn(async () => null),
    getSqlScopeEvidence: vi.fn(async (scope) => ({
      scope,
      folderId: "folder-a",
      hasStoredRef: true,
    })),
    listLegacyCandidateScopes: vi.fn(async () => []),
  };
  const openObject = vi.fn(input.read ?? (async () => new Response("12345678")));
  const requireScope = vi.fn(async () => undefined);
  const resolveReadStorage = vi.fn(async () => ({
    storage: { openObject },
    identity: "binding-id",
    location: { endpoint: "https://r2.example.test", bucket: "private-attachments" },
  }));
  const service = createAttachmentReadService({
    repository,
    access: { requireScope },
    resolveReadStorage,
    readPageAttachmentEvidence: input.pageEvidence ?? (async (pageId, attachmentId) => ({
      scope: { type: "page", id: pageId },
      folderId: null,
      hasStoredRef: attachmentId === asset.id,
    })),
  });
  return { service, repository, openObject, requireScope, resolveReadStorage };
}

describe("attachment read service", () => {
  it("preserves safe MIME parameters for inline and download responses", () => {
    const asset = {
      originalName: "notes.txt",
      mimeType: "text/plain; charset=iso-8859-1",
    };

    const inline = responseHeaders(asset, false, { contentLength: 12 });
    const download = responseHeaders(asset, true, { contentLength: 12 });

    expect(inline.get("content-type")).toBe("text/plain; charset=iso-8859-1");
    expect(inline.get("content-disposition")).toMatch(/^inline;/);
    expect(download.get("content-type")).toBe("text/plain; charset=iso-8859-1");
    expect(download.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("rejects MIME parameter header injection and keeps risky MIME as an attachment", () => {
    const headers = responseHeaders({
      originalName: "page.html",
      mimeType: "text/html; charset=utf-8\r\nX-Injected: yes",
    }, false, { contentLength: 12 });

    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect(headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(headers.get("x-injected")).toBeNull();
  });

  it("returns pending metadata only to the matching owner without resolving storage", async () => {
    const pending = { ...committedAsset, uploadStatus: "pending" as const };
    const { service, resolveReadStorage } = makeService({ asset: pending });

    await expect(service.metadata(
      { kind: "user", email: "OWNER@example.com" },
      pending.id,
      { type: "owner" },
    )).resolves.toMatchObject({
      upload_status: "pending",
      descriptor: {
        attachment_id: pending.id,
        name: "../report.png",
        preview_kind: "image",
        preview_mime_type: "image/png",
      },
    });
    await expect(service.metadata(
      { kind: "user", email: "other@example.com" },
      pending.id,
      { type: "owner" },
    )).rejects.toMatchObject({ statusCode: 403 });
    expect(resolveReadStorage).not.toHaveBeenCalled();
  });

  it("requires stored scope evidence and existing ACL before returning metadata", async () => {
    const { service, requireScope } = makeService();
    requireScope.mockRejectedValueOnce(new AttachmentReadError(
      "DENIED",
      "Attachment access denied",
      403,
    ));

    await expect(service.metadata(
      { kind: "user", email: "reader@example.com" },
      committedAsset.id,
      { type: "card", id: "card-a" },
    )).rejects.toMatchObject({ statusCode: 403 });
    expect(requireScope).toHaveBeenCalledWith(
      { kind: "user", email: "reader@example.com" },
      { type: "card", id: "card-a" },
      { scope: { type: "card", id: "card-a" }, folderId: "folder-a", hasStoredRef: true },
    );
  });

  it("forwards a validated single range and streams the original bytes", async () => {
    const openObject = vi.fn(async (request) => new Response("cde", {
      status: 206,
      headers: {
        "content-range": "bytes 2-4/8",
        "content-length": "3",
      },
    }));
    const { service } = makeService({ read: openObject });

    const response = await service.content(
      { kind: "user", email: "owner@example.com" },
      committedAsset.id,
      { type: "owner" },
      { method: "GET", range: "bytes=2-4" },
    );

    expect(openObject).toHaveBeenCalledWith(expect.objectContaining({
      storageKey: committedAsset.storageKey,
      method: "GET",
      range: "bytes=2-4",
    }));
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-4/8");
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("content-disposition")).toContain('filename="report.png"');
    expect(await response.text()).toBe("cde");
  });

  it("uses a bodyless upstream HEAD and cancels any returned body", async () => {
    const cancel = vi.fn();
    const openObject = vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      status: 200,
      headers: { etag: '"stored-etag"' },
    }));
    const { service } = makeService({ read: openObject });

    const response = await service.content(
      { kind: "user", email: "owner@example.com" },
      committedAsset.id,
      { type: "owner" },
      { method: "HEAD", range: "bytes=2-4" },
    );

    expect(openObject).toHaveBeenCalledWith({
      storageKey: committedAsset.storageKey,
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-length")).toBe("8");
    expect(response.headers.get("etag")).toBe('"stored-etag"');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels an upstream full response when a requested range is ignored", async () => {
    const cancel = vi.fn();
    const openObject = vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      status: 200,
      headers: { "content-length": "8" },
    }));
    const { service } = makeService({ read: openObject });

    await expect(service.content(
      { kind: "user", email: "owner@example.com" },
      committedAsset.id,
      { type: "owner" },
      { method: "GET", range: "bytes=2-4" },
    )).rejects.toMatchObject({ statusCode: 502 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects multiple ranges before opening the R2 object", async () => {
    const { service, openObject } = makeService();

    await expect(service.content(
      { kind: "user", email: "owner@example.com" },
      committedAsset.id,
      { type: "owner" },
      { method: "GET", range: "bytes=0-1,4-5" },
    )).rejects.toMatchObject({
      statusCode: 416,
      headers: { "Content-Range": "bytes */8" },
    });
    expect(openObject).not.toHaveBeenCalled();
  });

  it("rejects pending scope reads and mismatched R2 locations before opening bytes", async () => {
    const pending = { ...committedAsset, uploadStatus: "pending" as const };
    const pendingRead = makeService({ asset: pending });
    await expect(pendingRead.service.content(
      { kind: "user", email: "reader@example.com" },
      pending.id,
      { type: "card", id: "card-a" },
      { method: "GET" },
    )).rejects.toMatchObject({ statusCode: 409 });
    expect(pendingRead.openObject).not.toHaveBeenCalled();

    const locationMismatch = makeService();
    locationMismatch.resolveReadStorage.mockResolvedValue({
      storage: { openObject: locationMismatch.openObject },
      identity: "another-binding",
      location: { endpoint: "https://other.example.test", bucket: "private-attachments" },
    });
    await expect(locationMismatch.service.content(
      { kind: "user", email: "owner@example.com" },
      committedAsset.id,
      { type: "owner" },
      { method: "GET" },
    )).rejects.toMatchObject({ statusCode: 503 });
    expect(locationMismatch.openObject).not.toHaveBeenCalled();
  });

  it("leaves an unknown legacy path on the existing auth and node fallback", async () => {
    const { service, repository } = makeService();
    const resolveActor = vi.fn(async () => ({ kind: "user" as const, email: "owner@example.com" }));

    await expect(service.legacy(
      resolveActor,
      "node-a",
      "/incoming/legacy.png",
      undefined,
      { method: "GET" },
    )).resolves.toEqual({ kind: "unresolved" });
    expect(repository.getLegacyAlias).toHaveBeenCalledWith("node-a", "/incoming/legacy.png");
    expect(resolveActor).not.toHaveBeenCalled();
  });
});
