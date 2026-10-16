import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerMultipartAttachmentRoutes, type MultipartAttachmentOptions } from "../src/attachments/multipart_attachment_routes.js";
import { verifyAttachmentTicket, LARGE_ATTACHMENT_MAX_SIZE } from "../src/attachments/attachment_upload_ticket.js";
import { AttachmentCommitError } from "../src/attachments/attachment_commit_service.js";
import { AttachmentUploadHttpError, type AttachmentUploadOptions } from "../src/attachments/attachment_upload_http.js";
import type { AttachmentCommitRepository, OwnedAttachmentCommitService, UploadRegistration } from "../src/attachments/attachment_commit_contract.js";

const SECRET = "test-secret";
const SESSION_ID = "bed05238-498d-4f76-aebb-c0eaa236cda5";
const UPLOAD_ID = "11111111-1111-4111-8111-111111111111";
const EXP = 1_800_000_000;
const ID_V1 = { "x-soulstream-attachment-contract": "id-v1" };

function createHarness(overrides: { requireRegistration?: AttachmentUploadOptions["requireRegistration"]; actor?: AttachmentUploadOptions["resolveActor"]; initMultipart?: OwnedAttachmentCommitService["initMultipart"] } = {}) {
  const calls: string[] = [];
  const registration: UploadRegistration = { registrationScope: { type: "session", id: SESSION_ID }, sourceNodeId: null, sourceSessionId: SESSION_ID, outputCommandId: null };
  const binding = {
    identity: "settings-v1",
    location: { endpoint: "https://r2.test", bucket: "bucket" },
    storage: { createPresignedGetUrl: vi.fn(() => "https://r2/get") },
  } as unknown as NonNullable<Awaited<ReturnType<AttachmentUploadOptions["resolveBinding"]>>>;
  const uploads: AttachmentUploadOptions = {
    resolveActor: overrides.actor ?? vi.fn(async () => ({ kind: "user" as const, email: "owner@example.com" })),
    requireRegistration: overrides.requireRegistration ?? vi.fn(async () => registration),
    commits: {
      initMultipart: overrides.initMultipart ?? vi.fn(async ({ spec }) => ({
        partSize: 16 * 1024 ** 2,
        parts: [1, 2, 3, 4].map((partNumber) => ({ partNumber, uploadUrl: `https://r2/part-${partNumber}` })),
        ticket: {
          importId: spec.attachmentId,
          storageKey: `session-attachments/originals/${spec.attachmentId}`,
          uploadId: "r2-upload",
          filename: spec.originalName,
          size: spec.byteSize,
          contentType: spec.mimeType,
          sourceSessionId: spec.registration.sourceSessionId,
          sourceNodeId: spec.registration.sourceNodeId,
          settingsIdentity: "settings-v1",
          exp: EXP,
          ...(spec.checksumSha256 === undefined ? {} : { checksumSha256: spec.checksumSha256 }),
        },
      })),
    } as unknown as OwnedAttachmentCommitService,
    repository: {} as unknown as AttachmentCommitRepository,
    resolveBinding: vi.fn(async () => binding),
    ownerMetadata: vi.fn(async () => { throw new Error("unused"); }),
  };
  const getNode = vi.fn(async () => ({ capabilities: { attachment_import_v1: true } }));
  const options: MultipartAttachmentOptions = {
    resolveStorage: vi.fn(async () => ({ storage: binding.storage as never, identity: "settings-v1" })),
    resolveSecret: vi.fn(async () => SECRET),
    resolveEmail: vi.fn(async () => "owner@example.com"),
    requireAccess: vi.fn(async () => {}),
    getNode,
    importAttachment: vi.fn(async () => ({})),
    abortImport: vi.fn(async () => ({})),
    uploads,
  };
  const app = Fastify();
  registerMultipartAttachmentRoutes(app, options);
  const init = (body: Record<string, unknown>, extra: Record<string, string> = {}, nodeId: string | null = "worker") =>
    app.inject({ method: "POST", url: `/api/attachments/sessions/multipart/init${nodeId === null ? "" : `?nodeId=${nodeId}`}`, headers: extra,
      payload: { session_id: SESSION_ID, filename: "large.zip", size: 64 * 1024 ** 2, content_type: "application/zip", upload_id: UPLOAD_ID, ...body } });
  return { app, uploads, options, getNode, init, registration };
}

const decode = (ticket: string) => verifyAttachmentTicket(ticket, SECRET)!;

describe("owned multipart init", () => {
  it("runs the legacy owned init without attachment_id or a contract header", async () => {
    const h = createHarness();
    try {
      const res = await h.init({});
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.attachment_id).toBeUndefined();
      expect(res.headers["x-soulstream-attachment-contract"]).toBeUndefined();
      expect(body.parts).toHaveLength(4);
      const ticket = decode(body.ticket);
      expect(ticket).toMatchObject({ responseContract: "legacy", nodeId: "worker", sessionId: SESSION_ID, folderId: null, sub: "owner@example.com", exp: EXP });
      expect(ticket.storageKey).toBe(`session-attachments/originals/${ticket.importId}`);
      expect(h.getNode).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });

  it("runs the id-v1 owned init with no node and the contract response header", async () => {
    const h = createHarness();
    try {
      const res = await h.init({}, ID_V1, null);
      expect(res.statusCode).toBe(201);
      expect(res.headers["x-soulstream-attachment-contract"]).toBe("id-v1");
      const ticket = decode(res.json().ticket);
      expect(res.json().attachment_id).toBe(ticket.importId);
      expect(ticket).toMatchObject({ responseContract: "id-v1", nodeId: null, exp: EXP });
      expect(h.getNode).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });

  it("does not copy internal provenance into the client ticket", async () => {
    const h = createHarness();
    try {
      const res = await h.init({}, ID_V1, null);
      expect(res.statusCode).toBe(201);
      const ticket = decode(res.json().ticket);
      expect("sourceSessionId" in ticket).toBe(false);
      expect("sourceNodeId" in ticket).toBe(false);
      expect("registration" in ticket).toBe(false);
    } finally { await h.app.close(); }
  });

  it("rejects a folder-less id-v1 multipart draft with 400", async () => {
    const h = createHarness({ requireRegistration: async () => { throw new AttachmentUploadHttpError(400, "invalid_upload", "첨부 업로드 등록 정보가 올바르지 않습니다"); } });
    try {
      const res = await h.init({}, ID_V1, null);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("invalid_upload");
      expect(h.uploads.commits.initMultipart).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });

  it("rejects size 0 with small-upload guidance and a size above 5GiB", async () => {
    const h = createHarness();
    try {
      const zero = await h.init({ size: 0 });
      expect(zero.statusCode).toBe(400);
      expect(zero.json().detail).toContain("작은 업로드");
      const huge = await h.init({ size: LARGE_ATTACHMENT_MAX_SIZE + 1 });
      expect(huge.statusCode).toBe(400);
      expect(h.uploads.commits.initMultipart).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });

  it("keeps the service expiry when the same upload_id is reissued", async () => {
    const h = createHarness();
    try {
      const first = decode((await h.init({})).json().ticket);
      const second = decode((await h.init({})).json().ticket);
      expect(first.exp).toBe(EXP);
      expect(second.exp).toBe(EXP);
      expect(h.uploads.commits.initMultipart).toHaveBeenCalledTimes(2);
    } finally { await h.app.close(); }
  });

  it("rejects a non-UUID upload_id and a missing legacy nodeId", async () => {
    const h = createHarness();
    try {
      expect((await h.init({ upload_id: "not-a-uuid" })).statusCode).toBe(400);
      expect((await h.init({}, {}, null)).statusCode).toBe(400);
      expect(h.uploads.commits.initMultipart).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });

  it("requires login and propagates an ACL denial", async () => {
    const denied = createHarness({ actor: async () => null });
    const acl = createHarness({ requireRegistration: async () => { throw new AttachmentUploadHttpError(403, "forbidden", "권한이 없습니다"); } });
    try {
      expect((await denied.init({})).statusCode).toBe(401);
      const res = await acl.init({});
      expect(res.statusCode).toBe(403);
      expect(acl.uploads.commits.initMultipart).not.toHaveBeenCalled();
    } finally { await denied.app.close(); await acl.app.close(); }
  });

  it("surfaces a storage failure as 502 with the attachment id", async () => {
    const h = createHarness({ initMultipart: async ({ spec }) => { throw new AttachmentCommitError("storage_failed", 502, "R2 failed", spec.attachmentId); } });
    try {
      const res = await h.init({});
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ code: "storage_failed", attachment_id: UPLOAD_ID });
    } finally { await h.app.close(); }
  });
});
