import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createApp,
  parseOrchServerConfig,
  type AttachmentAccessProvider,
  type AttachmentRouteProvider,
  type AttachmentTransport,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const descriptor = {
  attachment_id: "attachment-1",
  name: "photo.png",
  mime_type: "image/png",
  byte_size: 4,
  checksum_sha256: null,
  width: 1,
  height: 1,
  preview_kind: "image",
  preview_mime_type: "image/png",
};

const openResponse = () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3, 4]));
    controller.close();
  },
}), {
  status: 200,
  headers: {
    "content-length": "4",
    "content-type": "image/png",
    "content-disposition": 'inline; filename="photo.png"',
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
  },
});

function makeApp(options: {
  resolveActor?: () => Promise<unknown>;
  metadata?: ReturnType<typeof vi.fn>;
  content?: ReturnType<typeof vi.fn>;
  legacy?: ReturnType<typeof vi.fn>;
  getNode?: ReturnType<typeof vi.fn>;
  downloadAttachment?: ReturnType<typeof vi.fn>;
} = {}) {
  const calls: string[] = [];
  const attachmentRoutes = {
    provider: {
      async getNode(nodeId: string) {
        calls.push(`node:${nodeId}`);
        return options.getNode?.(nodeId) ?? null;
      },
    } satisfies AttachmentRouteProvider,
    accessProvider: {
      async resolveAccess() {
        return { restricted: false };
      },
      async requireSessionAccess() {},
    } satisfies AttachmentAccessProvider,
    transport: {
      async uploadAttachment() { throw new Error("unused"); },
      async legacyUploadAttachment() { throw new Error("unused"); },
      async deleteSessionAttachments() { throw new Error("unused"); },
      async downloadAttachment(node, path) {
        calls.push(`download:${node.id}:${path}`);
        return options.downloadAttachment?.(node, path) ?? {
          content_b64: "AQIDBA==",
          filename: "photo.png",
          content_type: "image/png",
        };
      },
    } satisfies AttachmentTransport,
    assetRead: {
      async resolveActor() {
        calls.push("actor");
        if (options.resolveActor) return await options.resolveActor();
        return { kind: "user", email: "reader@example.com" };
      },
      service: {
        metadata: options.metadata ?? vi.fn(async () => ({
          descriptor,
          upload_status: "committed",
        })),
        content: options.content ?? vi.fn(async () => openResponse()),
        legacy: options.legacy ?? vi.fn(async () => ({
          kind: "response",
          response: openResponse(),
        })),
      },
    },
  };
  const app = createApp({ config, attachmentRoutes: attachmentRoutes as never });
  return { app, calls, attachmentRoutes };
}

describe("authenticated attachment reads", () => {
  const apps: Array<ReturnType<typeof makeApp>["app"]> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("returns metadata through the authenticated permanent-ID route", async () => {
    const { app, calls, attachmentRoutes } = makeApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/attachments/attachment-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ descriptor, upload_status: "committed" });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.vary).toContain("Cookie");
    expect(calls).toEqual(["actor"]);
    expect(attachmentRoutes.assetRead.service.metadata).toHaveBeenCalledWith(
      { kind: "user", email: "reader@example.com" },
      "attachment-1",
      { type: "owner" },
    );
  });

  it("rejects unauthenticated permanent-ID reads before invoking the service", async () => {
    const metadata = vi.fn();
    const { app } = makeApp({
      resolveActor: async () => {
        throw Object.assign(new Error("Authentication required"), {
          statusCode: 401,
          code: "ATTACHMENT_UNAUTHENTICATED",
        });
      },
      metadata,
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/attachments/attachment-1?access_email=owner%40example.com",
    });

    expect(response.statusCode).toBe(401);
    expect(metadata).not.toHaveBeenCalled();
  });

  it("passes GET and HEAD content through as streams and strips unsafe response headers", async () => {
    const content = vi.fn(async (_actor, _id, _context, input) =>
      input.method === "HEAD"
        ? new Response(null, { status: 200, headers: { "content-length": "4" } })
        : openResponse(),
    );
    const { app, attachmentRoutes } = makeApp({ content });
    apps.push(app);

    const get = await app.inject({
      method: "GET",
      url: "/api/attachments/attachment-1/content",
    });
    const head = await app.inject({
      method: "HEAD",
      url: "/api/attachments/attachment-1/content",
    });

    expect(get.statusCode).toBe(200);
    expect(get.rawPayload).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(get.headers["content-disposition"]).toContain("photo.png");
    expect(get.headers["x-content-type-options"]).toBe("nosniff");
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload).toHaveLength(0);
    expect(content).toHaveBeenNthCalledWith(
      1,
      { kind: "user", email: "reader@example.com" },
      "attachment-1",
      { type: "owner" },
      { method: "GET", range: undefined, signal: expect.any(AbortSignal) },
    );
    expect(content).toHaveBeenNthCalledWith(
      2,
      { kind: "user", email: "reader@example.com" },
      "attachment-1",
      { type: "owner" },
      { method: "HEAD", range: undefined, signal: expect.any(AbortSignal) },
    );
    expect(attachmentRoutes.assetRead.service.content).toBe(content);
  });

  it("dispatches a resolved legacy alias before looking up its source node", async () => {
    const legacy = vi.fn(async () => ({ kind: "response", response: openResponse() }));
    const { app, calls } = makeApp({
      legacy,
      getNode: vi.fn(() => null),
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/attachments/files?nodeId=offline-node&path=%2Fincoming%2Fsession-a%2Fphoto.png",
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(legacy).toHaveBeenCalledWith(
      expect.any(Function),
      "offline-node",
      "/incoming/session-a/photo.png",
      undefined,
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
    expect(calls).toEqual([]);
  });
});
