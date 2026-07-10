import { describe, expect, it, vi } from "vitest";

import {
  AttachmentTransportConnectionError,
  AttachmentTransportTimeoutError,
  attachmentRouteAuthRequirements,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  type AttachmentAccessProvider,
  type AttachmentDownloadResult,
  type AttachmentLegacyUploadInput,
  type AttachmentNode,
  type AttachmentRouteProvider,
  type AttachmentTransport,
  type AttachmentUploadInput,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const node: AttachmentNode = { id: "node-1", host: "127.0.0.1", port: 4105 };

type HarnessCall =
  | ["node", string]
  | ["access", { accessEmail?: string | null }]
  | ["check", { sessionId: string; accessEmail?: string | null }]
  | ["upload", { node: AttachmentNode; input: Omit<AttachmentUploadInput, "chunks">; chunks: string[] }]
  | ["legacy", { node: AttachmentNode; input: AttachmentLegacyUploadInput }]
  | ["delete", { node: AttachmentNode; sessionId: string }]
  | ["download", { node: AttachmentNode; path: string }];

function createHarness(overrides: Partial<AttachmentTransport> = {}) {
  const calls: HarnessCall[] = [];
  const provider: AttachmentRouteProvider = {
    async getNode(nodeId) {
      calls.push(["node", nodeId]);
      return nodeId === "node-1" ? node : null;
    },
  };
  const accessProvider: AttachmentAccessProvider = {
    async resolveAccess(_request, context) {
      calls.push(["access", { accessEmail: context.accessEmail }]);
      return { restricted: true };
    },
    async requireSessionAccess(input) {
      calls.push([
        "check",
        { sessionId: input.sessionId, accessEmail: input.accessEmail },
      ]);
    },
  };
  const transport: AttachmentTransport = {
    async uploadAttachment(target, input) {
      const chunks = await collectChunkStrings(input.chunks);
      const { chunks: _chunks, ...rest } = input;
      calls.push(["upload", { node: target, input: rest, chunks }]);
      return {
        path: "/incoming/session-abc/photo.png",
        filename: "photo.png",
        size: input.expectedSize ?? 0,
        content_type: input.contentType,
        ignored: true,
      };
    },
    async legacyUploadAttachment(target, input) {
      calls.push(["legacy", { node: target, input }]);
      return {
        path: "/incoming/session-abc/photo.png",
        filename: input.filename,
        size: Buffer.from(input.contentBase64, "base64").length,
        content_type: input.contentType,
      };
    },
    async deleteSessionAttachments(target, sessionId) {
      calls.push(["delete", { node: target, sessionId }]);
      return {};
    },
    async downloadAttachment(target, path) {
      calls.push(["download", { node: target, path }]);
      return {
        content_b64: Buffer.from("PNG bytes").toString("base64"),
        filename: "photo.png",
        content_type: "image/png",
      };
    },
    ...overrides,
  };
  const app = createApp({
    config,
    attachmentRoutes: { provider, accessProvider, transport },
  });
  return { app, calls };
}

function createUploadBody(options: {
  sessionId?: string;
  callerInfo?: string;
  filename?: string;
  contentType?: string;
  content?: Buffer;
}) {
  const boundary = "----soulstream-attachment-test";
  const chunks: Buffer[] = [];
  const append = (value: string | Buffer) => {
    chunks.push(typeof value === "string" ? Buffer.from(value, "utf8") : value);
  };
  if (options.sessionId !== undefined) {
    append(`--${boundary}\r\nContent-Disposition: form-data; name="session_id"\r\n\r\n`);
    append(options.sessionId);
    append("\r\n");
  }
  if (options.callerInfo !== undefined) {
    append(`--${boundary}\r\nContent-Disposition: form-data; name="caller_info"\r\n\r\n`);
    append(options.callerInfo);
    append("\r\n");
  }
  append(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${options.filename ?? "photo.png"}"\r\nContent-Type: ${options.contentType ?? "image/png"}\r\n\r\n`,
  );
  append(options.content ?? Buffer.from("PNG bytes"));
  append(`\r\n--${boundary}--\r\n`);
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  };
}

async function collectChunkStrings(chunks: AsyncIterable<Buffer>) {
  const collected: string[] = [];
  for await (const chunk of chunks) {
    collected.push(chunk.toString("utf8"));
  }
  return collected;
}

describe("attachment route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps attachment routes disabled on the default app", async () => {
    const app = createApp({ config });
    const upload = createUploadBody({ sessionId: "session-abc" });

    for (const request of [
      { method: "POST", url: "/api/attachments/sessions?nodeId=node-1", ...upload },
      { method: "DELETE", url: "/api/attachments/sessions/session-abc?nodeId=node-1" },
      { method: "GET", url: "/api/attachments/files?nodeId=node-1&path=/incoming/session-abc/photo.png" },
    ] as const) {
      expect(await app.inject(request)).toMatchObject({ statusCode: 404 });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 86-88", () => {
    expect(attachmentRouteAuthRequirements).toEqual({
      "POST /api/attachments/sessions": true,
      "DELETE /api/attachments/sessions/:session_id": true,
      "GET /api/attachments/files": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        ["proxy_upload", "proxy_delete", "proxy_download"].includes(route.name),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [86, "POST", "/api/attachments/sessions", true],
      [87, "DELETE", "/api/attachments/sessions/{session_id}", true],
      [88, "GET", "/api/attachments/files", true],
    ]);
  });

  it("uploads multipart files through the chunked transport and checks session access", async () => {
    const { app, calls } = createHarness();
    const body = createUploadBody({
      sessionId: "session-abc",
      callerInfo: JSON.stringify({ email: "writer@example.com" }),
      filename: "photo.png",
      contentType: "image/png",
      content: Buffer.from("PNG bytes"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/attachments/sessions?nodeId=node-1",
      ...body,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      path: "/incoming/session-abc/photo.png",
      filename: "photo.png",
      size: 9,
      content_type: "image/png",
    });
    expect(calls).toEqual([
      ["node", "node-1"],
      ["access", { accessEmail: "writer@example.com" }],
      ["check", { sessionId: "session-abc", accessEmail: "writer@example.com" }],
      [
        "upload",
        {
          node,
          input: {
            sessionId: "session-abc",
            filename: "photo.png",
            contentType: "image/png",
            expectedSize: 9,
          },
          chunks: ["PNG bytes"],
        },
      ],
    ]);

    await app.close();
  });

  it("splits multipart payloads into 1MiB raw chunks before WS transport", async () => {
    const chunkSizes: number[] = [];
    const { app } = createHarness({
      async uploadAttachment(_target, input) {
        for await (const chunk of input.chunks) chunkSizes.push(chunk.length);
        return {
          path: "/incoming/session-abc/large.bin",
          filename: "large.bin",
          size: input.expectedSize,
          content_type: input.contentType,
        };
      },
    });
    const content = Buffer.alloc(1024 * 1024 + 3, 1);

    const response = await app.inject({
      method: "POST",
      url: "/api/attachments/sessions?nodeId=node-1",
      ...createUploadBody({
        sessionId: "session-abc",
        filename: "large.bin",
        contentType: "application/octet-stream",
        content,
      }),
    });

    expect(response.statusCode).toBe(201);
    expect(chunkSizes).toEqual([1024 * 1024, 3]);
    await app.close();
  });

  it("falls back to legacy upload for unsupported chunked command within legacy limit", async () => {
    const { app, calls } = createHarness({
      uploadAttachment: vi.fn(async () => {
        throw new Error("Unknown command: upload_attachment_start");
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/attachments/sessions?nodeId=node-1",
      ...createUploadBody({ sessionId: "session-abc", content: Buffer.from("legacy") }),
    });

    expect(response.statusCode).toBe(201);
    expect(calls.at(-1)).toEqual([
      "legacy",
      {
        node,
        input: {
          sessionId: "session-abc",
          filename: "photo.png",
          contentType: "image/png",
          contentBase64: Buffer.from("legacy").toString("base64"),
        },
      },
    ]);

    await app.close();
  });

  it.each([
    [new AttachmentTransportConnectionError("closed"), 503, "Node temporarily unavailable: closed"],
    [new AttachmentTransportTimeoutError("slow"), 504, "Node attachment upload timed out: slow"],
    [new Error("INVALID_REQUEST: bad file"), 400, "bad file"],
    [new Error("disk exploded"), 502, "Node attachment upload failed: disk exploded"],
  ])("maps upload transport error %#", async (error, statusCode, detail) => {
    const { app } = createHarness({
      uploadAttachment: vi.fn(async () => {
        throw error;
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/attachments/sessions?nodeId=node-1",
      ...createUploadBody({ sessionId: "session-abc" }),
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ detail });

    await app.close();
  });

  it("returns 404 for unknown upload, delete, and download target nodes", async () => {
    const { app } = createHarness();

    const upload = await app.inject({
      method: "POST",
      url: "/api/attachments/sessions?nodeId=missing-node",
      ...createUploadBody({ sessionId: "session-abc" }),
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/attachments/sessions/session-abc?nodeId=missing-node",
    });
    const download = await app.inject({
      method: "GET",
      url: "/api/attachments/files?nodeId=missing-node&path=/incoming/session-abc/photo.png",
    });

    expect(upload.statusCode).toBe(404);
    expect(deleted.statusCode).toBe(404);
    expect(download.statusCode).toBe(404);

    await app.close();
  });

  it("deletes session attachments with Python-compatible response defaults", async () => {
    const { app, calls } = createHarness();

    const response = await app.inject({
      method: "DELETE",
      url: "/api/attachments/sessions/session-abc?nodeId=node-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cleaned: true, files_removed: 0 });
    expect(calls).toEqual([
      ["node", "node-1"],
      ["access", { accessEmail: null }],
      ["check", { sessionId: "session-abc", accessEmail: null }],
      ["delete", { node, sessionId: "session-abc" }],
    ]);

    await app.close();
  });

  it.each([
    [new AttachmentTransportConnectionError("closed"), 503, "Node temporarily unavailable: closed"],
    [new AttachmentTransportTimeoutError("slow"), 504, "Node attachment delete timed out: slow"],
    [new Error("INVALID_REQUEST: bad session"), 400, "bad session"],
    [new Error("boom"), 502, "Node attachment delete failed: boom"],
  ])("maps delete transport error %#", async (error, statusCode, detail) => {
    const { app } = createHarness({
      deleteSessionAttachments: vi.fn(async () => {
        throw error;
      }),
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/attachments/sessions/session-abc?nodeId=node-1",
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ detail });

    await app.close();
  });

  it("downloads binary attachments and derives restricted access session from path parent", async () => {
    const { app, calls } = createHarness();

    const response = await app.inject({
      method: "GET",
      url: "/api/attachments/files?nodeId=node-1&path=/incoming/session-abc/photo.png",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-disposition"]).toBe('inline; filename="photo.png"');
    expect(response.headers["cache-control"]).toBe("private, max-age=3600");
    expect(Buffer.from(response.rawPayload).toString("utf8")).toBe("PNG bytes");
    expect(calls).toEqual([
      ["node", "node-1"],
      ["access", { accessEmail: null }],
      ["check", { sessionId: "session-abc", accessEmail: null }],
      ["download", { node, path: "/incoming/session-abc/photo.png" }],
    ]);

    await app.close();
  });

  it.each([
    [new Error("NOT_FOUND: missing"), 404, "missing"],
    [new Error("INVALID_REQUEST: bad path"), 400, "bad path"],
    [new AttachmentTransportConnectionError("closed"), 503, "Node temporarily unavailable: closed"],
    [new AttachmentTransportTimeoutError("slow"), 504, "Node download timed out: slow"],
    [new Error("boom"), 502, "Node download failed: boom"],
  ])("maps download transport error %#", async (error, statusCode, detail) => {
    const { app } = createHarness({
      downloadAttachment: vi.fn(async (): Promise<AttachmentDownloadResult> => {
        throw error;
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/attachments/files?nodeId=node-1&path=/incoming/session-abc/photo.png",
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ detail });

    await app.close();
  });

  it("rejects malformed node responses", async () => {
    const { app } = createHarness({
      uploadAttachment: vi.fn(async () => ({ path: "/incoming/session-abc/photo.png" })),
      deleteSessionAttachments: vi.fn(async () => "done"),
      downloadAttachment: vi.fn(async () => ({
        content_b64: "not base64",
        filename: "photo.png",
      })),
    });

    const upload = await app.inject({
      method: "POST",
      url: "/api/attachments/sessions?nodeId=node-1",
      ...createUploadBody({ sessionId: "session-abc" }),
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/attachments/sessions/session-abc?nodeId=node-1",
    });
    const download = await app.inject({
      method: "GET",
      url: "/api/attachments/files?nodeId=node-1&path=/incoming/session-abc/photo.png",
    });

    expect(upload.statusCode).toBe(502);
    expect(upload.json()).toEqual({ detail: "Node returned malformed upload response" });
    expect(deleted.statusCode).toBe(502);
    expect(deleted.json()).toEqual({ detail: "Node returned malformed delete response" });
    expect(download.statusCode).toBe(502);
    expect(download.json().detail).toContain("Node returned invalid base64");

    await app.close();
  });
});
