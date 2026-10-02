import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerMultipartAttachmentRoutes } from "../src/attachments/multipart_attachment_routes.js";
import { createLiveAuthJwtHelper } from "../src/runtime/live_auth_route_provider.js";

// Same inject-at-HTTP-boundary pattern as attachment-routes.test.ts. Storage
// and worker are external boundaries; ticket/permission/HTTP logic is real.
describe("multipart session attachment HTTP contract", () => {
  function harness() {
    const storage = {
      createPresignedPutUrl: vi.fn(() => "https://r2/put"),
      createMultipartUpload: vi.fn(async () => ({ uploadId: "r2-upload", partSize: 16 * 1024 ** 2,
        parts: [1, 2, 3, 4].map(partNumber => ({ partNumber, uploadUrl: `https://r2/part-${partNumber}` })) })),
      completeMultipartUpload: vi.fn(async () => {}),
      headObject: vi.fn(async () => ({ byteSize: 64 * 1024 ** 2 })),
      createPresignedGetUrl: vi.fn(() => "https://r2/download"),
      deleteObject: vi.fn(async () => {}), abortMultipartUpload: vi.fn(async () => {}),
    };
    const requireAccess = vi.fn(async () => {});
    const importAttachment = vi.fn(async () => ({ path: "/incoming/s/large.zip", filename: "large.zip",
      size: 64 * 1024 ** 2, content_type: "application/zip" }));
    const app = Fastify();
    registerMultipartAttachmentRoutes(app, {
      resolveStorage: async () => ({ storage, identity: "settings-v1" }),
      resolveEmail: async (req: any) => req.headers["x-user"] ?? "owner@example.com",
      requireAccess, getNode: async () => ({ capabilities: { attachment_import_v1: true } }),
      importAttachment, abortImport: vi.fn(async () => {}), resolveSecret: async () => "test-secret",
    });
    const size = 64 * 1024 ** 2;
    async function init() {
      const res = await app.inject({ method: "POST", url: "/api/attachments/sessions/multipart/init?nodeId=worker",
        payload: { session_id: "bed05238-498d-4f76-aebb-c0eaa236cda5", filename: "large.zip", size, content_type: "application/zip", folder_id: "folder" } });
      expect(res.statusCode).toBe(201);
      return res.json();
    }
    function complete(ticket: string, headers = {}) {
      return app.inject({ method: "POST", url: "/api/attachments/sessions/multipart/complete?nodeId=worker", headers,
        payload: { ticket, parts: Array.from({ length: 4 }, (_, i) => ({ partNumber: i + 1, etag: `"etag-${i}"` })) } });
    }
    return { app, storage, requireAccess, importAttachment, init, complete };
  }
  it("imports the server-owned object and removes it after worker success", async () => {
    const h = harness();
    try {
      const init = await h.init();
      expect((await h.complete(init.ticket)).statusCode).toBe(201);
      expect(h.importAttachment).toHaveBeenCalledWith("worker", expect.objectContaining({ expectedSize: 64 * 1024 ** 2, filename: "large.zip" }), expect.anything());
      expect(h.storage.deleteObject).toHaveBeenCalledOnce();
      expect(h.requireAccess).toHaveBeenCalledTimes(2);
    } finally { await h.app.close(); }
  });
  it("rejects another user before completing storage", async () => {
    const h = harness();
    try {
      const init = await h.init();
      expect((await h.complete(init.ticket, { "x-user": "other@example.com" })).statusCode).toBe(403);
      expect(h.storage.completeMultipartUpload).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });
  it("does not import an object whose actual size differs from the ticket", async () => {
    const h = harness();
    try {
      const init = await h.init();
      h.storage.headObject.mockResolvedValue({ byteSize: 1 });
      expect((await h.complete(init.ticket)).statusCode).toBe(400);
      expect(h.importAttachment).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });
  it("rejects a changed ticket payload before storage access", async () => {
    const h = harness();
    try {
      const init = await h.init();
      const [header, payload, signature] = init.ticket.split(".");
      const altered = JSON.parse(Buffer.from(payload, "base64url").toString());
      altered.size = 5 * 1024 ** 3;
      const forged = `${header}.${Buffer.from(JSON.stringify(altered)).toString("base64url")}.${signature}`;
      expect((await h.complete(forged)).statusCode).toBe(403);
      expect(h.storage.completeMultipartUpload).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });
  it("does not accept an upload ticket as a dashboard login token", async () => {
    const h = harness();
    try {
      const init = await h.init();
      const jwt = createLiveAuthJwtHelper({ configProvider: {
        getConfig: () => ({}), requireConfig: () => "test-secret",
      } });
      expect(await jwt.verifyToken(init.ticket)).toBeNull();
    } finally { await h.app.close(); }
  });
});
