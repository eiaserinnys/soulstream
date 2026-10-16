import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerMultipartAttachmentRoutes, type MultipartAttachmentOptions } from "../src/attachments/multipart_attachment_routes.js";
import { AttachmentTransportConnectionError, AttachmentTransportTimeoutError } from "../src/attachments/attachment_routes.js";
import { issueAttachmentTicket } from "../src/attachments/attachment_upload_ticket.js";
import { AttachmentUploadHttpError, type AttachmentUploadOptions } from "../src/attachments/attachment_upload_http.js";
import type {
  AttachmentCommitRepository, OwnedAttachmentCommitService, OwnedAttachmentUpload, UploadRegistration,
} from "../src/attachments/attachment_commit_contract.js";

const SECRET = "test-secret";
const SESSION_ID = "bed05238-498d-4f76-aebb-c0eaa236cda5";
const IMPORT_ID = "22222222-2222-4222-8222-222222222222";
const UPLOAD_ID = "r2-multipart-upload";
const EXP = 1_800_000_000;
const SIZE = 64 * 1024 ** 2;
const PARTS = [1, 2, 3, 4].map((partNumber) => ({ partNumber, etag: `"etag${partNumber}"` }));
const ID_V1 = { "x-soulstream-attachment-contract": "id-v1" };
const OWNER = { kind: "user_email", key: "owner@example.com" } as const;
const ORIGINAL_KEY = `session-attachments/originals/${IMPORT_ID}`;
const TRANSFER_KEY = `session-attachments/transfers/${IMPORT_ID}`;
const WORKER_RESULT = { path: "sessions/abc/large.zip", filename: "large.zip", size: SIZE, content_type: "application/zip" };

type TicketOverrides = { responseContract?: "legacy" | "id-v1"; storageKey?: string; nodeId?: string | null; sub?: string; exp?: number };

function issue(overrides: TicketOverrides = {}): string {
  return issueAttachmentTicket({
    purpose: "session_attachment_upload", sub: overrides.sub ?? "owner@example.com", sessionId: SESSION_ID, folderId: null,
    nodeId: "nodeId" in overrides ? overrides.nodeId ?? null : "worker",
    storageKey: overrides.storageKey ?? ORIGINAL_KEY, uploadId: UPLOAD_ID, importId: IMPORT_ID,
    filename: "large.zip", size: SIZE, contentType: "application/zip", settingsIdentity: "settings-v1", exp: overrides.exp ?? EXP,
    ...(overrides.responseContract === undefined ? {} : { responseContract: overrides.responseContract }),
  }, SECRET);
}

function rowFor(overrides: Partial<OwnedAttachmentUpload> = {}): OwnedAttachmentUpload {
  const registration: UploadRegistration = { registrationScope: { type: "session", id: SESSION_ID }, sourceNodeId: null, sourceSessionId: SESSION_ID, outputCommandId: null };
  return {
    attachmentId: IMPORT_ID, storageKey: ORIGINAL_KEY, owner: OWNER, registration, originalName: "large.zip", mimeType: "application/zip",
    byteSize: SIZE, storageEndpoint: "https://r2.test", storageBucket: "bucket", checksumSha256: null, uploadStatus: "pending",
    multipartUploadId: UPLOAD_ID, createdAt: new Date(0), garbageCollectedAt: null, ...overrides,
  };
}

type Config = Partial<{
  row: OwnedAttachmentUpload | null; identity: string; noBinding: boolean; noActor: boolean;
  getNode: MultipartAttachmentOptions["getNode"]; importAttachment: MultipartAttachmentOptions["importAttachment"];
  requireRegistration: AttachmentUploadOptions["requireRegistration"]; alias: { originalPath: string } | null; abortR2: () => Promise<void>;
}>;

function createHarness(config: Config = {}) {
  const calls: string[] = [];
  const binding = {
    identity: config.identity ?? "settings-v1", location: { endpoint: "https://r2.test", bucket: "bucket" },
    storage: {
      createPresignedGetUrl: vi.fn(() => "https://r2/get"), abortMultipartUpload: vi.fn(config.abortR2 ?? (async () => {})),
      deleteObject: vi.fn(async () => {}), completeMultipartUpload: vi.fn(async () => {}), headObject: vi.fn(async () => ({ byteSize: SIZE })),
    },
  } as unknown as NonNullable<Awaited<ReturnType<AttachmentUploadOptions["resolveBinding"]>>>;
  const repository = {
    getOwnedUpload: vi.fn(async () => ("row" in config ? config.row ?? null : rowFor())),
    findLegacyAliasForUpload: vi.fn(async () => config.alias ?? null),
    insertLegacyAlias: vi.fn(async (input: object) => { calls.push("alias"); return { ...input, availability: "resolved" as const }; }),
    insertOwnedPending: vi.fn(), setMultipartUploadId: vi.fn(),
  } as unknown as AttachmentCommitRepository;
  const completeMultipart = vi.fn(async () => {
    calls.push("commit");
    return { attachmentId: IMPORT_ID, storageKey: ORIGINAL_KEY, storageEndpoint: "https://r2.test", storageBucket: "bucket",
      originalName: "large.zip", mimeType: "application/zip", byteSize: SIZE, checksumSha256: "a".repeat(64) };
  });
  const abortMultipart = vi.fn(async () => {});
  const initMultipart = vi.fn(async () => ({ partSize: 16 * 1024 ** 2, parts: [], ticket: {
    importId: IMPORT_ID, storageKey: ORIGINAL_KEY, uploadId: UPLOAD_ID, filename: "large.zip", size: SIZE, contentType: "application/zip",
    sourceSessionId: SESSION_ID, sourceNodeId: null, settingsIdentity: "settings-v1", exp: EXP,
  } }));
  const uploads: AttachmentUploadOptions = {
    resolveActor: vi.fn(async () => (config.noActor ? null : { kind: "user" as const, email: "owner@example.com" })),
    requireRegistration: config.requireRegistration ?? vi.fn(async () => rowFor().registration),
    commits: { completeMultipart, abortMultipart, initMultipart } as unknown as OwnedAttachmentCommitService, repository,
    resolveBinding: vi.fn(async () => (config.noBinding ? null : binding)),
    ownerMetadata: vi.fn(async () => ({ descriptor: { attachment_id: IMPORT_ID, name: "large.zip" }, upload_status: "committed" })) as never,
  };
  const getNode = config.getNode ?? vi.fn(async () => ({ capabilities: { attachment_import_v1: true } }));
  const importAttachment = vi.fn(config.importAttachment ?? (async () => { calls.push("import"); return WORKER_RESULT; }));
  const abortImport = vi.fn(async () => ({}));
  const app = Fastify();
  registerMultipartAttachmentRoutes(app, {
    resolveStorage: vi.fn(), resolveSecret: async () => SECRET, resolveEmail: vi.fn(), requireAccess: vi.fn(),
    getNode, importAttachment: importAttachment as never, abortImport, uploads,
  } as unknown as MultipartAttachmentOptions);
  const post = (path: "init" | "complete" | "abort", payload: Record<string, unknown>, headers: Record<string, string> = {}, query = "") =>
    app.inject({ method: "POST", url: `/api/attachments/sessions/multipart/${path}${query}`, headers, payload });
  return { app, calls, binding, repository, completeMultipart, abortMultipart, getNode, importAttachment, abortImport, uploads, post };
}
type Harness = ReturnType<typeof createHarness>;

function expectNoWork(h: Harness) {
  for (const spy of [h.repository.getOwnedUpload, h.completeMultipart, h.abortMultipart, h.binding.storage.abortMultipartUpload,
    h.binding.storage.completeMultipartUpload, h.binding.storage.deleteObject, h.importAttachment, h.abortImport,
    h.repository.findLegacyAliasForUpload, h.repository.insertLegacyAlias, h.repository.insertOwnedPending, h.repository.setMultipartUploadId]) {
    expect(spy).not.toHaveBeenCalled();
  }
}

describe("owned multipart complete", () => {
  it("completes an id-v1 upload started by init and returns the owner descriptor without touching a worker", async () => {
    const h = createHarness();
    try {
      const init = await h.post("init", { session_id: SESSION_ID, filename: "large.zip", content_type: "application/zip", size: SIZE }, ID_V1);
      expect(init.statusCode).toBe(201);
      const res = await h.post("complete", { ticket: init.json().ticket, parts: PARTS }, ID_V1);
      expect(res.statusCode).toBe(201);
      expect(res.headers["x-soulstream-attachment-contract"]).toBe("id-v1");
      expect(res.json()).toEqual({ attachment: { attachment_id: IMPORT_ID, name: "large.zip" } });
      expect(h.completeMultipart).toHaveBeenCalledWith(expect.objectContaining({
        owner: OWNER, parts: PARTS, ticket: expect.objectContaining({ importId: IMPORT_ID, sourceSessionId: SESSION_ID, sourceNodeId: null }),
      }));
      for (const spy of [h.getNode, h.importAttachment, h.repository.insertLegacyAlias, h.binding.storage.deleteObject]) expect(spy).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });

  it("commits before the worker cache and alias, then answers with the four legacy fields", async () => {
    const h = createHarness();
    try {
      const res = await h.post("complete", { ticket: issue({ responseContract: "legacy" }), parts: PARTS }, {}, "?nodeId=worker");
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(WORKER_RESULT);
      expect(h.calls).toEqual(["commit", "import", "alias"]);
      expect(h.importAttachment).toHaveBeenCalledWith("worker", {
        uploadId: IMPORT_ID, sessionId: SESSION_ID, filename: "large.zip", contentType: "application/zip", expectedSize: SIZE, downloadUrl: "https://r2/get",
      }, expect.anything());
      expect(h.binding.storage.createPresignedGetUrl).toHaveBeenCalledWith({ storageKey: ORIGINAL_KEY, expiresSeconds: 3600 });
      expect(h.binding.storage.deleteObject).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });

  it.each([
    ["worker offline", { getNode: async () => null }, 503, "cache_unavailable"],
    ["worker without import capability", { getNode: async () => ({ capabilities: {} }) }, 409, "cache_unsupported"],
    ["import connection failure", { importAttachment: async () => { throw new AttachmentTransportConnectionError("down"); } }, 503, "cache_unavailable"],
    ["import timeout", { importAttachment: async () => { throw new AttachmentTransportTimeoutError("slow"); } }, 504, "cache_timeout"],
    ["import failure", { importAttachment: async () => { throw new Error("boom https://r2/get?sig=secret"); } }, 502, "cache_failed"],
  ] as [string, Config, number, string][])("keeps the committed original on %s", async (_name, config, status, code) => {
    const h = createHarness(config);
    try {
      const res = await h.post("complete", { ticket: issue({ responseContract: "legacy" }), parts: PARTS }, {}, "?nodeId=worker");
      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ code, attachment_id: IMPORT_ID });
      expect(res.body).not.toContain("secret");
      expect(h.binding.storage.deleteObject).not.toHaveBeenCalled();
      expect(h.repository.insertLegacyAlias).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });

  it("reuses an already committed upload and its stored alias without calling the worker again", async () => {
    const h = createHarness({ row: rowFor({ uploadStatus: "committed", multipartUploadId: null }), alias: { originalPath: "sessions/abc/large.zip" } });
    try {
      const res = await h.post("complete", { ticket: issue({ responseContract: "legacy" }), parts: PARTS }, {}, "?nodeId=worker");
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(WORKER_RESULT);
      for (const spy of [h.getNode, h.importAttachment, h.repository.insertLegacyAlias]) expect(spy).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });

  it("rejects a pre-contract transfer ticket with upload_restart_required before any owned work", async () => {
    const h = createHarness();
    try {
      const res = await h.post("complete", { ticket: issue({ storageKey: TRANSFER_KEY }), parts: PARTS }, {}, "?nodeId=worker");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ code: "upload_restart_required", detail: "업로드를 다시 시작해 주세요" });
      expectNoWork(h);
    } finally { await h.app.close(); }
  });

  it.each([
    ["missing row", { row: null }],
    ["garbage collected row", { row: rowFor({ garbageCollectedAt: new Date() }) }],
    ["different size", { row: rowFor({ byteSize: SIZE + 1 }) }],
    ["different source session", { row: rowFor({ registration: { ...rowFor().registration, sourceSessionId: "other-session" } }) }],
    ["different multipart upload", { row: rowFor({ multipartUploadId: "another-upload" }) }],
  ] as [string, Config][])("rejects a %s as upload_conflict", async (_name, config) => {
    const h = createHarness(config);
    try {
      const res = await h.post("complete", { ticket: issue({ responseContract: "legacy" }), parts: PARTS }, {}, "?nodeId=worker");
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("upload_conflict");
      expect(h.completeMultipart).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });

  it("rejects a wrong part list as invalid input and accepts a differently cased subject", async () => {
    const h = createHarness();
    try {
      const ticket = issue({ responseContract: "legacy", sub: " Owner@Example.com " });
      const bad = await h.post("complete", { ticket, parts: PARTS.slice(1) }, {}, "?nodeId=worker");
      expect(bad.statusCode).toBe(400);
      expect(bad.json().code).toBe("invalid_upload");
      expect(h.completeMultipart).not.toHaveBeenCalled();
      expect((await h.post("complete", { ticket, parts: PARTS }, {}, "?nodeId=worker")).statusCode).toBe(201);
    } finally { await h.app.close(); }
  });

  it("derives the owner and provenance from the signed-in user and stored row, never from caller input", async () => {
    const h = createHarness();
    try {
      const res = await h.post("complete", {
        ticket: issue({ responseContract: "id-v1", nodeId: null }), parts: PARTS,
        owner: { kind: "user_email", key: "victim@example.com" }, email: "victim@example.com", sourceNodeId: "evil", registration: { sourceNodeId: "evil" },
      }, { ...ID_V1, "x-user-email": "victim@example.com" });
      expect(res.statusCode).toBe(201);
      expect(h.repository.getOwnedUpload).toHaveBeenCalledWith(IMPORT_ID, OWNER);
      expect(h.completeMultipart).toHaveBeenCalledWith(expect.objectContaining({ owner: OWNER, ticket: expect.objectContaining({ sourceNodeId: null }) }));
      expect(h.repository.insertOwnedPending).not.toHaveBeenCalled();
      expect(h.repository.setMultipartUploadId).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });
});

describe("owned multipart abort", () => {
  it("aborts a pending id-v1 upload through the commit service only", async () => {
    const h = createHarness();
    try {
      const res = await h.post("abort", { ticket: issue({ responseContract: "id-v1", nodeId: null }) }, ID_V1);
      expect(res.json()).toEqual({ aborted: true, committed: false });
      expect(h.abortMultipart).toHaveBeenCalledWith(expect.objectContaining({ owner: OWNER }));
      for (const spy of [h.abortImport, h.binding.storage.abortMultipartUpload, h.binding.storage.deleteObject]) expect(spy).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });

  it("leaves a committed upload alone and still checks the row against the ticket", async () => {
    const committed = createHarness({ row: rowFor({ uploadStatus: "committed", multipartUploadId: null }) });
    const mismatch = createHarness({ row: rowFor({ uploadStatus: "committed", byteSize: SIZE + 1 }) });
    try {
      const ticket = issue({ responseContract: "legacy" });
      expect((await committed.post("abort", { ticket }, {}, "?nodeId=worker")).json()).toEqual({ aborted: false, committed: true });
      for (const spy of [committed.abortMultipart, committed.abortImport, committed.binding.storage.abortMultipartUpload, committed.binding.storage.deleteObject]) {
        expect(spy).not.toHaveBeenCalled();
      }
      expect((await mismatch.post("abort", { ticket }, {}, "?nodeId=worker")).json().code).toBe("upload_conflict");
    } finally { await committed.app.close(); await mismatch.app.close(); }
  });

  it("best-effort cancels the worker import of a pending legacy upload, but not after a commit race", async () => {
    const pending = createHarness();
    const raced = createHarness();
    vi.mocked(raced.repository.getOwnedUpload).mockResolvedValueOnce(rowFor()).mockResolvedValueOnce(rowFor({ uploadStatus: "committed" }));
    try {
      const ticket = issue({ responseContract: "legacy" });
      expect((await pending.post("abort", { ticket }, {}, "?nodeId=worker")).json()).toEqual({ aborted: true, committed: false });
      expect(pending.abortImport).toHaveBeenCalledWith("worker", IMPORT_ID);
      expect((await raced.post("abort", { ticket }, {}, "?nodeId=worker")).json()).toEqual({ aborted: false, committed: true });
      expect(raced.abortImport).not.toHaveBeenCalled();
    } finally { await pending.app.close(); await raced.app.close(); }
  });

  it.each([
    ["succeeds", undefined],
    ["fails", async () => { throw new Error("r2 down"); }],
  ] as [string, Config["abortR2"]][])("cancels only the R2 multipart of a pre-contract transfer ticket and reports aborted when R2 %s", async (_name, abortR2) => {
    const h = createHarness({ abortR2 });
    try {
      const res = await h.post("abort", { ticket: issue({ storageKey: TRANSFER_KEY }) }, {}, "?nodeId=worker");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ aborted: true });
      expect(h.binding.storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
      expect(h.binding.storage.abortMultipartUpload).toHaveBeenCalledWith({ storageKey: TRANSFER_KEY, uploadId: UPLOAD_ID });
      for (const spy of [h.repository.getOwnedUpload, h.abortMultipart, h.abortImport, h.binding.storage.deleteObject]) expect(spy).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });
});

describe("owned multipart common verification", () => {
  const forbidden = async () => { throw new AttachmentUploadHttpError(403, "forbidden", "접근 권한이 없습니다"); };
  it.each([
    ["a forged ticket", { ticket: "garbage" }, {}, "?nodeId=worker", {}, 403, "invalid_upload_ticket"],
    ["an expired ticket", { exp: 1_700_000_000 }, {}, "?nodeId=worker", {}, 403, "invalid_upload_ticket"],
    ["another user's ticket", { sub: "other@example.com" }, {}, "?nodeId=worker", {}, 403, "invalid_upload_ticket"],
    ["a forbidden ACL", {}, {}, "?nodeId=worker", { requireRegistration: forbidden }, 403, "forbidden"],
    ["a different storage binding", {}, {}, "?nodeId=worker", { identity: "other-settings" }, 409, "upload_conflict"],
    ["a missing storage binding", {}, {}, "?nodeId=worker", { noBinding: true }, 503, "storage_unavailable"],
    ["a different node", {}, {}, "?nodeId=intruder", {}, 403, "invalid_upload_ticket"],
    ["a contract header that conflicts with the ticket", {}, ID_V1, "?nodeId=worker", {}, 409, "upload_contract_conflict"],
    ["an unauthenticated caller", {}, {}, "?nodeId=worker", { noActor: true }, 401, "unauthenticated"],
  ] as [string, TicketOverrides & { ticket?: string }, Record<string, string>, string, Config, number, string][])(
    "rejects %s on pre-contract and originals tickets with no side effects",
    async (_name, ticketOverrides, headers, query, config, status, code) => {
      for (const path of ["complete", "abort"] as const) {
        for (const storageKey of [TRANSFER_KEY, ORIGINAL_KEY]) {
          const h = createHarness(config);
          try {
            const { ticket, ...overrides } = ticketOverrides;
            const res = await h.post(path, { ticket: ticket ?? issue({ ...overrides, storageKey, ...(storageKey === ORIGINAL_KEY ? { responseContract: "legacy" } : {}) }), parts: PARTS }, headers, query);
            expect([res.statusCode, res.json().code]).toEqual([status, code]);
            expectNoWork(h);
          } finally { await h.app.close(); }
        }
      }
    },
  );
});
